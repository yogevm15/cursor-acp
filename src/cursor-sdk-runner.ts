import type { McpServer } from "@agentclientprotocol/sdk";
import {
	Agent,
	Cursor,
	type AgentOptions,
	type McpServerConfig,
	type Run,
	type SDKAgent,
	type SDKMessage,
} from "@cursor/sdk";
import { randomUUID } from "node:crypto";
import { applyCursorCliAttributionEnvironment } from "./cursor-cli-config.js";
import {
	sdkMessageToCursorStreamEvent,
	sdkRunResultToCursorResultEvent,
	sdkUsageToCursorUsageEvent,
} from "./cursor-sdk-event-adapter.js";
import { getCursorApiKey } from "./cursor-sdk-config.js";
import { buildLocalAgentOptions } from "./cursor-sdk-local-options.js";
import type {
	ChatCost,
	CursorPromptRun,
	CursorRunner,
	CursorStreamEvent,
	ForkChatOptions,
	RunPromptOptions,
	RunPromptResult,
} from "./cursor-runner.js";
import { forkLocalAgent, type OpenLocalAgentStore } from "./cursor-sdk-fork.js";
import { CursorTransportFailure } from "./cursor-transport-failure.js";
import { buildSdkModelSelection, ensureAutoModel } from "./model-id.js";
import type { CursorModelDescriptor } from "./slash-commands.js";
import type { Logger } from "./utils.js";

const PENDING_AGENT_PREFIX = "pending-";
const CANCELLATION_DRAIN_TIMEOUT_MS = 15_000;

interface ManagedAgent {
	agent: SDKAgent;
	configKey: string;
	cwd: string;
}

interface PromptHooks {
	isCancelled: () => boolean;
	waitUntilCancelled: () => Promise<void>;
	setCancelRun: (cancel: () => Promise<void>) => void;
	setSteerableRun: (run: Run | undefined) => void;
}

type OperationOutcome<T> =
	| { cancelled: false; value: T }
	| { cancelled: true; settled: false }
	| { cancelled: true; settled: true; succeeded: false }
	| { cancelled: true; settled: true; succeeded: true; value: T };

function isPendingAgentId(agentId: string | undefined): agentId is string {
	return typeof agentId === "string" && agentId.startsWith(PENDING_AGENT_PREFIX);
}

function isResumableAgentId(agentId: string | undefined): agentId is string {
	return typeof agentId === "string" && agentId.length > 0 && !isPendingAgentId(agentId);
}

/** Reads the structured fields a thrown `CursorSdkError` carries. */
function sdkErrorDetails(error: unknown): {
	errorCode?: string;
	requestId?: string;
	retryable?: boolean;
} {
	if (typeof error !== "object" || error === null) {
		return {};
	}
	const { code, requestId, isRetryable } = error as Record<string, unknown>;
	return {
		...(typeof code === "string" ? { errorCode: code } : {}),
		...(typeof requestId === "string" ? { requestId } : {}),
		...(typeof isRetryable === "boolean" ? { retryable: isRetryable } : {}),
	};
}

function sdkMcpServers(
	servers: McpServer[] | undefined,
): Record<string, McpServerConfig> | undefined {
	if (!servers?.length) {
		return undefined;
	}

	const result: Record<string, McpServerConfig> = {};
	for (const server of servers) {
		if ("serverId" in server) {
			continue;
		}
		if ("url" in server) {
			result[server.name] = {
				type: server.type,
				url: server.url,
				headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
			};
			continue;
		}
		result[server.name] = {
			type: "stdio",
			command: server.command,
			args: server.args,
			env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
		};
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export class CursorSdkRunner implements CursorRunner {
	private readonly agents = new Map<string, ManagedAgent>();
	/** Set when the account cannot read usage cost, so later calls skip the request. */
	private costUnavailable = false;

	constructor(
		private readonly apiKey: string | undefined = getCursorApiKey(),
		private readonly logger: Logger = console,
		private readonly openStore?: OpenLocalAgentStore,
	) {}

	async listModels(): Promise<CursorModelDescriptor[]> {
		const models = await Cursor.models.list(this.apiKey ? { apiKey: this.apiKey } : undefined);
		return ensureAutoModel(
			models.map((model) => ({
				modelId: model.id,
				name: model.displayName?.trim() || model.id,
				...(model.parameters?.length
					? {
							parameters: model.parameters.map((parameter) => ({
								id: parameter.id,
								displayName: parameter.displayName,
								values: parameter.values.map((value) => ({
									value: value.value,
									displayName: value.displayName,
								})),
							})),
						}
					: {}),
				...(model.variants?.length
					? {
							variants: model.variants.map((variant) => ({
								params: variant.params,
								isDefault: variant.isDefault,
								...(variant.isMaxMode ? { isMaxMode: true } : {}),
							})),
						}
					: {}),
			})),
		);
	}

	async createChat(): Promise<string> {
		return `${PENDING_AGENT_PREFIX}${randomUUID()}`;
	}

	async forkChat(options: ForkChatOptions): Promise<string | undefined> {
		if (!isResumableAgentId(options.backendSessionId)) {
			return undefined;
		}
		return await forkLocalAgent({
			agentId: options.backendSessionId,
			sourceWorkspace: options.sourceWorkspace,
			workspace: options.workspace,
			...(this.openStore ? { openStore: this.openStore } : {}),
		});
	}

	async getChatCost(backendSessionId: string): Promise<ChatCost | undefined> {
		if (this.costUnavailable || !isResumableAgentId(backendSessionId)) {
			return undefined;
		}
		try {
			const { cost } = await Agent.getUsage(
				backendSessionId,
				this.apiKey ? { apiKey: this.apiKey } : undefined,
			);
			return cost && { chargedCents: cost.chargedCents, rawCostCents: cost.rawCostCents };
		} catch (error) {
			const { errorCode } = sdkErrorDetails(error);
			if (errorCode === "feature_unavailable") {
				this.costUnavailable = true;
				this.logger.warn?.("[cursor-acp] Usage cost is not available for this account");
				return undefined;
			}
			if (errorCode === "agent_not_found") {
				return undefined;
			}
			throw error;
		}
	}

	startPrompt(options: RunPromptOptions): CursorPromptRun {
		let cancelled = false;
		let cancelRun: (() => Promise<void>) | undefined;
		let steerableRun: Run | undefined;
		let resolveCancelled: (() => void) | undefined;
		const cancelledPromise = new Promise<void>((resolve) => {
			resolveCancelled = resolve;
		});
		const cancelActiveRun = () => {
			const cancel = cancelRun;
			cancelRun = undefined;
			if (cancel) {
				void cancel().catch((error: unknown) => {
					this.logger.error?.("[cursor-acp] SDK cancellation failed", error);
				});
			}
		};
		const completed = this.executePrompt(options, {
			isCancelled: () => cancelled,
			waitUntilCancelled: () => cancelledPromise,
			setCancelRun: (cancel) => {
				cancelRun = cancel;
				if (cancelled) {
					cancelActiveRun();
				}
			},
			setSteerableRun: (run) => {
				steerableRun = run;
			},
		});
		void completed.then(
			() => {
				cancelRun = undefined;
				steerableRun = undefined;
			},
			() => {
				cancelRun = undefined;
				steerableRun = undefined;
			},
		);

		return {
			completed,
			cancel: () => {
				if (cancelled) {
					return;
				}
				cancelled = true;
				resolveCancelled?.();
				cancelActiveRun();
			},
			steer: async (text) => {
				const run = steerableRun;
				if (cancelled || !run?.steer) {
					return "revert_to_followup";
				}
				return await run.steer(text);
			},
		};
	}

	private async executePrompt(
		options: RunPromptOptions,
		hooks: PromptHooks,
	): Promise<RunPromptResult> {
		const events: CursorStreamEvent[] = [];
		let resultEvent: CursorStreamEvent | undefined;
		let stderr = "";
		let agent: SDKAgent | undefined;
		const unfinishedToolCalls = new Map<string, Extract<SDKMessage, { type: "tool_call" }>>();
		let assistantReply = new CursorTransportFailure();
		let nextAssistantStartsSegment = true;
		const emit = async (event: CursorStreamEvent) => {
			events.push(event);
			if (event.type === "result") {
				resultEvent = event;
			}
			await options.onEvent?.(event);
		};

		try {
			const agentCompleted = this.resolveAgent(options);
			const agentOutcome = await Promise.race([
				agentCompleted.then((value) => ({ cancelled: false as const, value })),
				hooks.waitUntilCancelled().then(() => ({ cancelled: true as const })),
			]);
			if (agentOutcome.cancelled) {
				void agentCompleted
					.then((late) => this.retireAgent(late.agent))
					.catch(() => undefined);
				resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
				await emit(resultEvent);
				return { events, resultEvent, stderr, exitCode: 0 };
			}
			agent = agentOutcome.value.agent;
			const { missingAgentId, created } = agentOutcome.value;
			await emit({
				type: "system",
				subtype: "init",
				session_id: agent.agentId,
				...(missingAgentId ? { missing_session_id: missingAgentId } : {}),
			});
			if (hooks.isCancelled()) {
				resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
				await emit(resultEvent);
				return { events, resultEvent, stderr, exitCode: 0 };
			}

			const modelCallIds = new Set<string>();
			const sendOptions: Parameters<SDKAgent["send"]>[1] = {
				model: buildSdkModelSelection(
					options.modelId ?? "auto",
					options.modelCatalog,
					options.thinkingLevel,
					options.fastValue,
					options.contextValue,
				),
				onDelta: ({ update }) => {
					if (update.type === "tool-call-started") {
						modelCallIds.add(update.modelCallId);
					}
				},
				...(options.modeId === "plan" ? { mode: "plan" as const } : {}),
				...(sdkMcpServers(options.mcpServers)
					? { mcpServers: sdkMcpServers(options.mcpServers) }
					: {}),
			};

			this.logger.log?.(
				"[cursor-acp] SDK prompt:",
				agent.agentId,
				options.workspace,
				options.modelId ?? "auto",
				options.reviewPolicy === "run-everything"
					? "approval-retry"
					: options.reviewPolicy === "auto-review"
						? "auto-review"
						: "run-everything",
			);

			const prompt =
				created && options.newChatPromptPrefix
					? `${options.newChatPromptPrefix}\n\n${options.prompt}`
					: options.prompt;
			const message = options.images?.length
				? { text: prompt, images: options.images }
				: prompt;
			const sendCompleted = agent.send(message, sendOptions);
			const sendOutcome = await this.completeOperation(sendCompleted, hooks, agent);
			if (sendOutcome.cancelled && (!sendOutcome.settled || !sendOutcome.succeeded)) {
				void sendCompleted.then((run) => run.cancel()).catch(() => undefined);
				resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
				await emit(resultEvent);
				return { events, resultEvent, stderr, exitCode: 0 };
			}
			const run = sendOutcome.value;
			hooks.setCancelRun(() => run.cancel());
			hooks.setSteerableRun(run);
			const streamCompleted = (async () => {
				for await (const message of run.stream()) {
					let duplicateRunningToolCall = false;
					if (message.type === "tool_call") {
						nextAssistantStartsSegment = true;
						if (message.status === "running") {
							duplicateRunningToolCall = unfinishedToolCalls.has(message.call_id);
							unfinishedToolCalls.set(message.call_id, message);
						} else {
							unfinishedToolCalls.delete(message.call_id);
						}
					} else if (message.type === "assistant") {
						if (nextAssistantStartsSegment) {
							assistantReply = new CursorTransportFailure();
							nextAssistantStartsSegment = false;
						}
						for (const content of message.message.content) {
							if (content.type === "text") {
								assistantReply.push(content.text);
							}
						}
					}
					if (duplicateRunningToolCall) {
						continue;
					}
					if (message.type === "usage") {
						// Tool-calling model calls plus the final reply call.
						await emit(
							sdkUsageToCursorUsageEvent(message.usage, modelCallIds.size + 1),
						);
						continue;
					}
					for (const adapted of sdkMessageToCursorStreamEvent(message)) {
						await emit(adapted);
					}
				}
			})();

			const streamOutcome = await this.completeOperation(streamCompleted, hooks, agent);
			hooks.setSteerableRun(undefined);
			if (streamOutcome.cancelled) {
				resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
				await emit(resultEvent);
				return { events, resultEvent, stderr, exitCode: 0 };
			}

			if (hooks.isCancelled()) {
				resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
			} else {
				const waitCompleted = run.wait();
				const waitOutcome = await this.completeOperation(waitCompleted, hooks, agent);
				if (waitOutcome.cancelled) {
					resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
					await emit(resultEvent);
					return { events, resultEvent, stderr, exitCode: 0 };
				}
				const finished = waitOutcome.value;
				if (finished.status === "finished") {
					for (const toolCall of unfinishedToolCalls.values()) {
						for (const adapted of sdkMessageToCursorStreamEvent({
							...toolCall,
							status: "error",
							result: {
								message:
									"Cursor Auto Review stopped this tool at the auto-approval boundary",
							},
						})) {
							await emit(adapted);
						}
					}
				}
				const transportFailure =
					finished.status === "finished" ? assistantReply.failure : undefined;
				if (transportFailure) {
					stderr = transportFailure;
					this.retireAgent(agent);
					resultEvent = {
						...sdkRunResultToCursorResultEvent({
							status: "error",
							errorText: transportFailure,
							requestId: finished.requestId ?? run.requestId,
						}),
						subtype: "transport_error",
					};
				} else {
					resultEvent = sdkRunResultToCursorResultEvent({
						status: finished.status,
						resultText: finished.result,
						errorText: finished.error?.message ?? finished.result,
						errorCode: finished.error?.code,
						requestId: finished.requestId ?? run.requestId,
					});
					stderr =
						finished.status === "error"
							? (finished.error?.message ?? finished.result ?? "")
							: "";
				}
			}
			if (resultEvent.is_error === true) {
				this.logRunFailure(options, agent.agentId, run.id, resultEvent);
			}
			await emit(resultEvent);
			return {
				events,
				resultEvent,
				stderr,
				exitCode: resultEvent.is_error === true ? 1 : 0,
			};
		} catch (error) {
			if (agent) {
				this.retireAgent(agent);
			}
			stderr = error instanceof Error ? error.message : String(error);
			resultEvent = sdkRunResultToCursorResultEvent(
				hooks.isCancelled()
					? { status: "cancelled" }
					: { status: "error", errorText: stderr, ...sdkErrorDetails(error) },
			);
			if (resultEvent.is_error === true) {
				this.logRunFailure(options, agent?.agentId, undefined, resultEvent, error);
			}
			await emit(resultEvent);
			return { events, resultEvent, stderr, exitCode: hooks.isCancelled() ? 0 : 1 };
		}
	}

	private async completeOperation<T>(
		operation: Promise<T>,
		hooks: PromptHooks,
		agent: SDKAgent,
	): Promise<OperationOutcome<T>> {
		const first = await Promise.race([
			operation.then((value) => ({ completed: true as const, value })),
			hooks.waitUntilCancelled().then(() => ({ completed: false as const })),
		]);
		if (first.completed) {
			return { cancelled: false, value: first.value };
		}

		let timeout: ReturnType<typeof setTimeout> | undefined;
		const settled = await Promise.race([
			operation.then(
				(value) => ({ settled: true as const, succeeded: true as const, value }),
				() => ({ settled: true as const, succeeded: false as const }),
			),
			new Promise<{ settled: false }>((resolve) => {
				timeout = setTimeout(
					() => resolve({ settled: false }),
					CANCELLATION_DRAIN_TIMEOUT_MS,
				);
			}),
		]);
		if (timeout) {
			clearTimeout(timeout);
		}
		if (!settled.settled) {
			this.retireAgent(agent);
			void operation.catch(() => undefined);
		}
		return { cancelled: true, ...settled };
	}

	/** Leaves the raw failure on stderr; the ACP client usually shows only a summary. */
	private logRunFailure(
		options: RunPromptOptions,
		agentId: string | undefined,
		runId: string | undefined,
		resultEvent: CursorStreamEvent,
		cause?: unknown,
	): void {
		this.logger.error(
			"[cursor-acp] SDK run failed:",
			JSON.stringify({
				agentId,
				runId,
				requestId: resultEvent.request_id,
				model: options.modelId ?? "auto",
				subtype: resultEvent.subtype,
				code: resultEvent.error_code,
				retryable: resultEvent.retryable,
				message: resultEvent.result,
			}),
			...(cause === undefined ? [] : [cause]),
		);
	}

	private retireAgent(agent: SDKAgent): void {
		for (const [agentId, managed] of this.agents) {
			if (managed.agent !== agent) {
				continue;
			}
			this.agents.delete(agentId);
			try {
				agent.close();
			} catch (error) {
				this.logger.error?.("[cursor-acp] Failed to close unusable SDK agent", error);
			}
			return;
		}
	}

	private agentConfig(options: RunPromptOptions) {
		// The SDK has no approval callback. Smart Auto fails closed; an ACP-approved retry
		// deliberately resumes with Auto-review disabled for that one whole-turn retry.
		const autoReview = options.reviewPolicy !== "run-everything";
		const ask = options.modeId === "ask";
		return {
			autoReview,
			ask,
			key: JSON.stringify({ autoReview, ask, roots: options.workspaceRoots ?? [] }),
		};
	}

	private agentOptions(options: RunPromptOptions): AgentOptions {
		applyCursorCliAttributionEnvironment(options.workspace);
		const config = this.agentConfig(options);
		return {
			...(this.apiKey ? { apiKey: this.apiKey } : {}),
			model: buildSdkModelSelection(
				options.modelId ?? "auto",
				options.modelCatalog,
				options.thinkingLevel,
				options.fastValue,
				options.contextValue,
			),
			local: buildLocalAgentOptions(
				options.workspace,
				config.autoReview,
				options.workspaceRoots,
			),
			...(config.ask ? { tools: [] } : {}),
			...(sdkMcpServers(options.mcpServers)
				? { mcpServers: sdkMcpServers(options.mcpServers) }
				: {}),
		};
	}

	/**
	 * `created` is true when a new SDK agent was made. `missingAgentId` is set when the
	 * requested agent was not found and a new one was made.
	 */
	private async resolveAgent(
		options: RunPromptOptions,
	): Promise<{ agent: SDKAgent; created: boolean; missingAgentId?: string }> {
		const backendSessionId = options.backendSessionId;
		const configKey = this.agentConfig(options).key;
		let missingAgentId: string | undefined;
		if (backendSessionId) {
			const cached = this.agents.get(backendSessionId);
			if (cached && cached.cwd === options.workspace && cached.configKey === configKey) {
				return { agent: cached.agent, created: false };
			}
			if (cached) {
				cached.agent.close();
				this.agents.delete(backendSessionId);
			}

			if (isResumableAgentId(backendSessionId)) {
				try {
					const agent = await Agent.resume(backendSessionId, this.agentOptions(options));
					this.agents.set(backendSessionId, {
						agent,
						cwd: options.workspace,
						configKey,
					});
					return { agent, created: false };
				} catch (error) {
					if (sdkErrorDetails(error).errorCode !== "agent_not_found") {
						throw error;
					}
					this.logger.warn?.(
						"[cursor-acp] Saved SDK agent not found; creating a new agent",
						backendSessionId,
					);
					missingAgentId = backendSessionId;
				}
			}
		}

		const agent = await Agent.create(this.agentOptions(options));
		if (backendSessionId) {
			this.agents.delete(backendSessionId);
		}
		this.agents.set(agent.agentId, { agent, cwd: options.workspace, configKey });
		return { agent, created: true, ...(missingAgentId ? { missingAgentId } : {}) };
	}
}
