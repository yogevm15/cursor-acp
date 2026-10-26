import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CURSOR_ACP_ATTRIBUTE_COMMITS_ENV,
	CURSOR_ACP_ATTRIBUTE_PRS_ENV,
} from "../cursor-cli-config.js";
import type { CursorStreamEvent } from "../cursor-runner.js";
import type { ForkableLocalAgentStore } from "../cursor-sdk-fork.js";
import { CursorSdkRunner } from "../cursor-sdk-runner.js";

const sdkMocks = vi.hoisted(() => ({
	agentCreate: vi.fn(),
	agentResume: vi.fn(),
	agentGetUsage: vi.fn(),
	modelList: vi.fn(),
}));

const logger = { log() {}, error() {} };
const originalConfigDir = process.env.CURSOR_CONFIG_DIR;
const originalCommitAttribution = process.env[CURSOR_ACP_ATTRIBUTE_COMMITS_ENV];
const originalPrAttribution = process.env[CURSOR_ACP_ATTRIBUTE_PRS_ENV];

vi.mock("@cursor/sdk", () => ({
	Agent: {
		create: sdkMocks.agentCreate,
		resume: sdkMocks.agentResume,
		getUsage: sdkMocks.agentGetUsage,
	},
	Cursor: { models: { list: sdkMocks.modelList } },
}));

function sdkRun(messages: unknown[] = []) {
	return {
		cancel: vi.fn(async () => undefined),
		async *stream() {
			for (const message of messages) yield message;
		},
		wait: vi.fn(async () => ({ status: "finished", result: "done" })),
	};
}

function sdkAgent(agentId: string, messages: unknown[] = []) {
	return {
		agentId,
		close: vi.fn(),
		send: vi.fn(async () => sdkRun(messages)),
	};
}

describe("CursorSdkRunner", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
		if (originalConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR;
		else process.env.CURSOR_CONFIG_DIR = originalConfigDir;
		if (originalCommitAttribution === undefined) {
			delete process.env[CURSOR_ACP_ATTRIBUTE_COMMITS_ENV];
		} else {
			process.env[CURSOR_ACP_ATTRIBUTE_COMMITS_ENV] = originalCommitAttribution;
		}
		if (originalPrAttribution === undefined) {
			delete process.env[CURSOR_ACP_ATTRIBUTE_PRS_ENV];
		} else {
			process.env[CURSOR_ACP_ATTRIBUTE_PRS_ENV] = originalPrAttribution;
		}
	});

	it("applies global attribution settings before creating the SDK agent", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "cursor-sdk-runner-config-"));
		writeFileSync(
			join(configDir, "cli-config.json"),
			JSON.stringify({
				attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
			}),
		);
		process.env.CURSOR_CONFIG_DIR = configDir;
		const agent = sdkAgent("agent-attribution");
		sdkMocks.agentCreate.mockImplementation(async () => {
			expect(process.env[CURSOR_ACP_ATTRIBUTE_COMMITS_ENV]).toBe("false");
			expect(process.env[CURSOR_ACP_ATTRIBUTE_PRS_ENV]).toBe("false");
			return agent;
		});

		const runner = new CursorSdkRunner("test-key", logger);
		await runner.startPrompt({ workspace: "/tmp/project", prompt: "hello" }).completed;

		expect(sdkMocks.agentCreate).toHaveBeenCalledOnce();
	});

	it("creates local agents with Auto Review enabled by default", async () => {
		const agent = sdkAgent("agent-real");
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);

		await runner.startPrompt({
			workspace: "/tmp/project",
			backendSessionId: await runner.createChat(),
			prompt: "hello",
		}).completed;

		expect(sdkMocks.agentCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: expect.objectContaining({ cwd: "/tmp/project", autoReview: true }),
			}),
		);
	});

	it("loads user and project settings from every workspace root", async () => {
		const agent = sdkAgent("agent-roots");
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);

		await runner.startPrompt({
			workspace: "/tmp/repos",
			workspaceRoots: ["/tmp/repos", "/tmp/repos/core", "/tmp/repos/infra"],
			prompt: "hello",
		}).completed;
		await runner.startPrompt({ workspace: "/tmp/project", prompt: "hello" }).completed;

		expect(sdkMocks.agentCreate).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				local: expect.objectContaining({
					cwd: "/tmp/repos",
					dirs: ["/tmp/repos", "/tmp/repos/core", "/tmp/repos/infra"],
					settingSources: ["user", "project"],
				}),
			}),
		);
		expect(sdkMocks.agentCreate.mock.calls[1]?.[0].local).not.toHaveProperty("dirs");
	});

	it("adds the new chat prefix only to the first prompt of a new agent", async () => {
		const created = sdkAgent("agent-new");
		const resumed = sdkAgent("agent-saved");
		sdkMocks.agentCreate.mockResolvedValue(created);
		sdkMocks.agentResume.mockResolvedValue(resumed);
		const runner = new CursorSdkRunner("test-key", logger);
		const base = { workspace: "/tmp/project", newChatPromptPrefix: "<skills/>" };

		await runner.startPrompt({
			...base,
			backendSessionId: await runner.createChat(),
			prompt: "one",
		}).completed;
		await runner.startPrompt({ ...base, backendSessionId: "agent-new", prompt: "two" })
			.completed;
		await runner.startPrompt({ ...base, backendSessionId: "agent-saved", prompt: "three" })
			.completed;

		expect(created.send).toHaveBeenNthCalledWith(1, "<skills/>\n\none", expect.anything());
		expect(created.send).toHaveBeenNthCalledWith(2, "two", expect.anything());
		expect(resumed.send).toHaveBeenCalledWith("three", expect.anything());
	});

	it("resumes with Auto Review disabled for an approved retry without SDK force", async () => {
		const reviewed = sdkAgent("agent-existing");
		const approved = sdkAgent("agent-existing");
		sdkMocks.agentResume.mockResolvedValueOnce(reviewed).mockResolvedValueOnce(approved);
		const runner = new CursorSdkRunner("test-key", logger);

		await runner.startPrompt({
			workspace: "/tmp/project",
			backendSessionId: "agent-existing",
			prompt: "first",
			reviewPolicy: "auto-review",
		}).completed;
		await runner.startPrompt({
			workspace: "/tmp/project",
			backendSessionId: "agent-existing",
			prompt: "retry",
			reviewPolicy: "run-everything",
		}).completed;

		expect(reviewed.close).toHaveBeenCalledOnce();
		expect(sdkMocks.agentResume).toHaveBeenNthCalledWith(
			2,
			"agent-existing",
			expect.objectContaining({ local: expect.objectContaining({ autoReview: false }) }),
		);
		expect(approved.send).toHaveBeenCalledWith(
			"retry",
			expect.not.objectContaining({ local: expect.anything() }),
		);
	});

	it("creates a new agent and reports the missing one when a saved agent is gone", async () => {
		sdkMocks.agentResume.mockRejectedValue(
			Object.assign(new Error("Agent agent-gone not found"), { code: "agent_not_found" }),
		);
		const created = sdkAgent("agent-new");
		sdkMocks.agentCreate.mockResolvedValue(created);
		const runner = new CursorSdkRunner("test-key", logger);

		const result = await runner.startPrompt({
			workspace: "/tmp/project",
			backendSessionId: "agent-gone",
			prompt: "hello",
		}).completed;

		expect(created.send).toHaveBeenCalledOnce();
		expect(result.events[0]).toEqual({
			type: "system",
			subtype: "init",
			session_id: "agent-new",
			missing_session_id: "agent-gone",
		});
		expect(result.exitCode).toBe(0);
	});

	it("fails the run when resuming a saved agent fails for another reason", async () => {
		sdkMocks.agentResume.mockRejectedValue(
			Object.assign(new Error("database locked"), { code: "storage_error" }),
		);
		const runner = new CursorSdkRunner("test-key", logger);

		const result = await runner.startPrompt({
			workspace: "/tmp/project",
			backendSessionId: "agent-existing",
			prompt: "hello",
		}).completed;

		expect(sdkMocks.agentCreate).not.toHaveBeenCalled();
		expect(result.exitCode).toBe(1);
	});

	it("reads the billed cost of real agents only", async () => {
		sdkMocks.agentGetUsage.mockResolvedValue({
			usage: {},
			cost: { chargedCents: 12.5, rawCostCents: 40 },
			runs: [],
		});
		const runner = new CursorSdkRunner("test-key", logger);

		await expect(runner.getChatCost("agent-real")).resolves.toEqual({
			chargedCents: 12.5,
			rawCostCents: 40,
		});
		await expect(runner.getChatCost(await runner.createChat())).resolves.toBeUndefined();

		expect(sdkMocks.agentGetUsage).toHaveBeenCalledOnce();
		expect(sdkMocks.agentGetUsage).toHaveBeenCalledWith("agent-real", { apiKey: "test-key" });
	});

	it("stops reading cost when the account does not have the feature", async () => {
		sdkMocks.agentGetUsage.mockRejectedValue(
			Object.assign(new Error("not available"), { code: "feature_unavailable" }),
		);
		const runner = new CursorSdkRunner("test-key", logger);

		await expect(runner.getChatCost("agent-a")).resolves.toBeUndefined();
		await expect(runner.getChatCost("agent-b")).resolves.toBeUndefined();

		expect(sdkMocks.agentGetUsage).toHaveBeenCalledOnce();
	});

	it("returns no cost for a missing agent and rethrows other cost errors", async () => {
		sdkMocks.agentGetUsage
			.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "agent_not_found" }))
			.mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "network_error" }));
		const runner = new CursorSdkRunner("test-key", logger);

		await expect(runner.getChatCost("agent-gone")).resolves.toBeUndefined();
		await expect(runner.getChatCost("agent-a")).rejects.toThrow("offline");
	});

	it("forks only real agents, in the store of each workspace", async () => {
		const opened: string[] = [];
		const runner = new CursorSdkRunner("test-key", logger, async (workspace) => {
			opened.push(workspace);
			return {
				agents: { get: async () => null },
			} as unknown as ForkableLocalAgentStore;
		});

		await expect(
			runner.forkChat({
				backendSessionId: await runner.createChat(),
				sourceWorkspace: "/tmp/a",
				workspace: "/tmp/a",
			}),
		).resolves.toBeUndefined();
		expect(opened).toEqual([]);

		await expect(
			runner.forkChat({
				backendSessionId: "agent-missing",
				sourceWorkspace: "/tmp/a",
				workspace: "/tmp/b",
			}),
		).resolves.toBeUndefined();
		expect(opened).toEqual(["/tmp/a", "/tmp/b"]);
	});

	it("forwards ACP MCP servers and image chunks to the SDK", async () => {
		const agent = sdkAgent("agent-real");
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);

		await runner.startPrompt({
			workspace: "/tmp/project",
			prompt: "inspect",
			images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
			mcpServers: [{ name: "local", command: "/bin/tool", args: ["serve"], env: [] }],
		}).completed;

		expect(sdkMocks.agentCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpServers: {
					local: { type: "stdio", command: "/bin/tool", args: ["serve"], env: {} },
				},
			}),
		);
		expect(agent.send).toHaveBeenCalledWith(
			{ text: "inspect", images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] },
			expect.objectContaining({ mcpServers: expect.any(Object) }),
		);
	});

	it("turns a tool left running by Auto Review into a rejected tool event", async () => {
		const agent = sdkAgent("agent-real", [
			{
				type: "tool_call",
				call_id: "call-1",
				name: "mcp",
				args: { tool: "dangerous" },
				status: "running",
			},
			{
				type: "tool_call",
				call_id: "call-1",
				name: "mcp",
				args: { tool: "dangerous" },
				status: "running",
			},
		]);
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);
		const events: CursorStreamEvent[] = [];

		await runner.startPrompt({
			workspace: "/tmp/project",
			prompt: "run it",
			onEvent: (event) => {
				events.push(event);
			},
		}).completed;

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "tool_call",
				subtype: "completed",
				tool_call: expect.objectContaining({
					mcpToolCall: expect.objectContaining({ result: expect.any(Object) }),
				}),
			}),
		);
		expect(events.filter((event) => event.subtype === "started")).toHaveLength(1);
	});

	it("emits turn usage with the number of model calls", async () => {
		const usage = {
			inputTokens: 16_000,
			outputTokens: 90,
			cacheReadTokens: 11_000,
			cacheWriteTokens: 0,
			totalTokens: 27_090,
		};
		const agent = {
			...sdkAgent("agent-real"),
			send: vi.fn(async (_message: unknown, options: unknown) => {
				const { onDelta } = options as {
					onDelta: (args: { update: Record<string, unknown> }) => void;
				};
				for (const modelCallId of ["call-a", "call-a", "call-b"]) {
					onDelta({ update: { type: "tool-call-started", callId: "c", modelCallId } });
				}
				return sdkRun([{ type: "usage", agent_id: "agent-real", run_id: "r", usage }]);
			}),
		};
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);
		const events: CursorStreamEvent[] = [];

		await runner.startPrompt({
			workspace: "/tmp/project",
			prompt: "hello",
			modelId: "gpt-5.6-sol",
			contextValue: "1m",
			modelCatalog: [
				{
					modelId: "gpt-5.6-sol",
					name: "GPT-5.6 Sol",
					parameters: [{ id: "context", values: [{ value: "272k" }, { value: "1m" }] }],
				},
			],
			onEvent: (event) => {
				events.push(event);
			},
		}).completed;

		expect(agent.send).toHaveBeenCalledWith(
			"hello",
			expect.objectContaining({
				model: { id: "gpt-5.6-sol", params: [{ id: "context", value: "1m" }] },
			}),
		);
		expect(events).toContainEqual({ type: "usage", usage, model_calls: 3 });
	});

	it("treats a standalone Cursor transport diagnostic as a failed run", async () => {
		const diagnostic = "Error: RetriableError: WritableIterable is closed";
		const agent = sdkAgent("agent-real", [
			{
				type: "assistant",
				agent_id: "agent-real",
				run_id: "run-1",
				message: { role: "assistant", content: [{ type: "text", text: diagnostic }] },
			},
		]);
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);

		const result = await runner.startPrompt({
			workspace: "/tmp/project",
			prompt: "hello",
		}).completed;

		expect(result).toMatchObject({
			exitCode: 1,
			stderr: diagnostic,
			resultEvent: { type: "result", subtype: "transport_error", is_error: true },
		});
		expect(agent.close).toHaveBeenCalledOnce();
	});

	it("carries the SDK error code and request id, and logs the failure", async () => {
		const agent = sdkAgent("agent-real");
		const failedRun = Object.assign(sdkRun(), {
			id: "run-1",
			wait: vi.fn(async () => ({
				id: "run-1",
				requestId: "req-1",
				status: "error",
				error: { message: "[resource_exhausted] Error", code: "resource_exhausted" },
			})),
		});
		agent.send.mockResolvedValue(failedRun as unknown as ReturnType<typeof sdkRun>);
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const errorLog = vi.fn();
		const runner = new CursorSdkRunner("test-key", { log() {}, error: errorLog });

		const result = await runner.startPrompt({
			workspace: "/tmp/project",
			prompt: "hello",
			modelId: "claude-opus-5-5",
		}).completed;

		expect(result.resultEvent).toMatchObject({
			subtype: "error",
			is_error: true,
			result: "[resource_exhausted] Error",
			error_code: "resource_exhausted",
			request_id: "req-1",
		});
		expect(errorLog).toHaveBeenCalledWith(
			"[cursor-acp] SDK run failed:",
			expect.stringContaining('"code":"resource_exhausted"'),
		);
		expect(errorLog.mock.calls[0]![1]).toContain('"model":"claude-opus-5-5"');
	});

	it("carries structured fields from a thrown SDK error", async () => {
		const agent = sdkAgent("agent-real");
		agent.send.mockRejectedValue(
			Object.assign(new Error("Slow down"), {
				code: "resource_exhausted",
				isRetryable: true,
				requestId: "req-2",
			}),
		);
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);

		const result = await runner.startPrompt({ workspace: "/tmp/project", prompt: "hello" })
			.completed;

		expect(result.resultEvent).toMatchObject({
			is_error: true,
			error_code: "resource_exhausted",
			request_id: "req-2",
			retryable: true,
		});
	});

	it("does not mistake an explanation containing a transport diagnostic for failure", async () => {
		const agent = sdkAgent("agent-real", [
			{
				type: "assistant",
				agent_id: "agent-real",
				run_id: "run-1",
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "The SDK returned Error: RetriableError: WritableIterable is closed",
						},
					],
				},
			},
		]);
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);

		const result = await runner.startPrompt({
			workspace: "/tmp/project",
			prompt: "explain the error",
		}).completed;

		expect(result.resultEvent).toMatchObject({ subtype: "success", is_error: false });
		expect(agent.close).not.toHaveBeenCalled();
	});

	it("classifies the final assistant segment after a tool call", async () => {
		const diagnostic = "Error: ConnectError: [unavailable] transport closed";
		const agent = sdkAgent("agent-real", [
			{
				type: "assistant",
				agent_id: "agent-real",
				run_id: "run-1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "I will inspect the repository." }],
				},
			},
			{
				type: "tool_call",
				agent_id: "agent-real",
				run_id: "run-1",
				call_id: "call-1",
				name: "read",
				args: { path: "README.md" },
				status: "completed",
				result: { content: "ok" },
			},
			{
				type: "assistant",
				agent_id: "agent-real",
				run_id: "run-1",
				message: { role: "assistant", content: [{ type: "text", text: diagnostic }] },
			},
		]);
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);

		const result = await runner.startPrompt({
			workspace: "/tmp/project",
			prompt: "inspect",
		}).completed;

		expect(result.stderr).toBe(diagnostic);
		expect(result.resultEvent).toMatchObject({ subtype: "transport_error", is_error: true });
	});

	it("does not dispatch a prompt cancelled while agent creation is pending", async () => {
		let resolveAgent: ((agent: ReturnType<typeof sdkAgent>) => void) | undefined;
		const created = new Promise<ReturnType<typeof sdkAgent>>((resolve) => {
			resolveAgent = resolve;
		});
		const agent = sdkAgent("agent-real");
		sdkMocks.agentCreate.mockReturnValue(created);
		const runner = new CursorSdkRunner("test-key", logger);

		const prompt = runner.startPrompt({ workspace: "/tmp/project", prompt: "hello" });
		prompt.cancel();
		resolveAgent?.(agent);
		const result = await prompt.completed;

		expect(agent.send).not.toHaveBeenCalled();
		expect(result.resultEvent).toMatchObject({ subtype: "cancelled", is_error: false });
	});

	it("completes cancellation without waiting for stalled agent creation", async () => {
		const agent = sdkAgent("agent-real");
		let resolveAgent: ((agent: ReturnType<typeof sdkAgent>) => void) | undefined;
		sdkMocks.agentCreate.mockReturnValue(
			new Promise<ReturnType<typeof sdkAgent>>((resolve) => {
				resolveAgent = resolve;
			}),
		);
		const runner = new CursorSdkRunner("test-key", logger);

		const prompt = runner.startPrompt({ workspace: "/tmp/project", prompt: "hello" });
		prompt.cancel();
		const result = await prompt.completed;

		expect(result.resultEvent).toMatchObject({ subtype: "cancelled", is_error: false });
		resolveAgent?.(agent);
		await vi.waitFor(() => expect(agent.close).toHaveBeenCalledOnce());
		expect(agent.send).not.toHaveBeenCalled();
	});

	it("cancels a run that becomes available after cancellation", async () => {
		let resolveSend: ((run: ReturnType<typeof sdkRun>) => void) | undefined;
		const sendCompleted = new Promise<ReturnType<typeof sdkRun>>((resolve) => {
			resolveSend = resolve;
		});
		const run = sdkRun();
		const agent = {
			agentId: "agent-real",
			close: vi.fn(),
			send: vi.fn(() => sendCompleted),
		};
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);
		const prompt = runner.startPrompt({ workspace: "/tmp/project", prompt: "hello" });

		await vi.waitFor(() => expect(agent.send).toHaveBeenCalledOnce());
		prompt.cancel();
		resolveSend?.(run);
		const result = await prompt.completed;

		expect(run.cancel).toHaveBeenCalledOnce();
		expect(result.resultEvent).toMatchObject({ subtype: "cancelled", is_error: false });
	});

	it("retires an SDK agent when cancelled dispatch does not settle", async () => {
		vi.useFakeTimers();
		const agent = {
			agentId: "agent-real",
			close: vi.fn(),
			send: vi.fn(() => new Promise<never>(() => {})),
		};
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);
		const prompt = runner.startPrompt({ workspace: "/tmp/project", prompt: "hello" });
		while (agent.send.mock.calls.length === 0) {
			await Promise.resolve();
		}

		prompt.cancel();
		await vi.advanceTimersByTimeAsync(15_000);
		const result = await prompt.completed;

		expect(agent.close).toHaveBeenCalledOnce();
		expect(result.resultEvent).toMatchObject({ subtype: "cancelled", is_error: false });
	});

	it("drains final SDK events after cancellation before completing", async () => {
		let finishCancellation: (() => void) | undefined;
		const cancellation = new Promise<void>((resolve) => {
			finishCancellation = resolve;
		});
		let toolStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const run = {
			cancel: vi.fn(async () => finishCancellation?.()),
			async *stream() {
				yield {
					type: "tool_call",
					agent_id: "agent-real",
					run_id: "run-1",
					call_id: "call-1",
					name: "shell",
					args: { command: "sleep 10" },
					status: "running",
				};
				await cancellation;
				yield {
					type: "tool_call",
					agent_id: "agent-real",
					run_id: "run-1",
					call_id: "call-1",
					name: "shell",
					args: { command: "sleep 10" },
					status: "error",
					result: { message: "Cancelled" },
				};
			},
			wait: vi.fn(async () => ({ status: "cancelled" as const })),
		};
		const agent = {
			agentId: "agent-real",
			close: vi.fn(),
			send: vi.fn(async () => run),
		};
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);
		const events: CursorStreamEvent[] = [];
		const prompt = runner.startPrompt({
			workspace: "/tmp/project",
			prompt: "wait",
			onEvent: (event) => {
				events.push(event);
				if (event.type === "tool_call" && event.subtype === "started") {
					toolStarted?.();
				}
			},
		});

		await started;
		prompt.cancel();
		const result = await prompt.completed;

		expect(run.cancel).toHaveBeenCalledOnce();
		expect(events.map((event) => [event.type, event.subtype])).toEqual(
			expect.arrayContaining([
				["tool_call", "completed"],
				["result", "cancelled"],
			]),
		);
		expect(result.resultEvent).toMatchObject({ subtype: "cancelled", is_error: false });
	});
});
