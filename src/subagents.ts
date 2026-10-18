import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { CursorStreamEvent } from "./cursor-runner.js";
import {
	baseToolName,
	extractCursorToolPayload,
	extractToolResultOutputText,
	isRejectedToolResult,
} from "./tools.js";
import { isObject, sanitizeToolCallId } from "./utils.js";

type SessionUpdate = SessionNotification["update"];
type SubagentState = NonNullable<
	Extract<SessionUpdate, { sessionUpdate: "subagent_update" }>["state"]
>;

const INTERNAL_ERROR_CODE = -32603;

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Exposes Cursor `task` tool calls as ACP v1 subagent sessions. The parent tool call stays
 * in place; this adds the child association, its work state, and the delegation messages.
 * Send these updates only when the client advertised `clientCapabilities.subagents`.
 */
export class SubagentTracker {
	/** Cursor subagent `agentId` to child session ID, so resumed tasks keep their child. */
	private readonly childByAgentId = new Map<string, string>();
	/** Parent tool call ID to child session ID, for tasks that have not completed. */
	private readonly running = new Map<string, string>();
	private nextMessageNumber = 1;

	constructor(private readonly parentSessionId: string) {}

	get hasRunningChildren(): boolean {
		return this.running.size > 0;
	}

	handleEvent(event: CursorStreamEvent): SessionNotification[] {
		if (event.type !== "tool_call") {
			return [];
		}
		const payload = extractCursorToolPayload(event.tool_call);
		if (!payload || baseToolName(payload.toolName) !== "task") {
			return [];
		}

		const rawCallId = typeof event.call_id === "string" ? event.call_id : "";
		const toolCallId = sanitizeToolCallId(rawCallId || "tool-call");
		if (event.subtype === "started") {
			return this.started(toolCallId, payload.args);
		}
		if (event.subtype === "completed") {
			return this.completed(toolCallId, payload.result);
		}
		return [];
	}

	/**
	 * Reports the final state of children whose task did not complete in the parent turn:
	 * `idle`/`cancelled` after a cancel, or `unknown` when the adapter stops observing them.
	 */
	stopAll(state: SubagentState): SessionNotification[] {
		const notifications = [...this.running.values()].map((childSessionId) =>
			this.stateUpdate(childSessionId, state),
		);
		this.running.clear();
		return notifications;
	}

	private started(toolCallId: string, args: Record<string, unknown>): SessionNotification[] {
		const resumeId = nonEmptyString(args.resume) ?? nonEmptyString(args.agentId);
		const childSessionId =
			(resumeId ? this.childByAgentId.get(resumeId) : undefined) ??
			this.running.get(toolCallId) ??
			`${this.parentSessionId}:subagent:${toolCallId}`;
		if (resumeId) {
			this.childByAgentId.set(resumeId, childSessionId);
		}
		this.running.set(toolCallId, childSessionId);

		const subagentType = isObject(args.subagentType) ? args.subagentType : undefined;
		const role = nonEmptyString(subagentType?.name) ?? nonEmptyString(subagentType?.kind);
		const notifications: SessionNotification[] = [
			this.parentUpdate({
				sessionUpdate: "subagent_update",
				sessionId: childSessionId,
				title: nonEmptyString(args.description) ?? "Subagent",
				...(role ? { description: role } : {}),
				state: { state: "running" },
			}),
		];

		const prompt = nonEmptyString(args.prompt);
		if (prompt) {
			notifications.push(
				this.parentUpdate({
					sessionUpdate: "session_message",
					messageId: this.messageId(),
					senderSessionId: this.parentSessionId,
					recipientSessionId: childSessionId,
					content: [{ type: "text", text: prompt }],
				}),
			);
		}
		return notifications;
	}

	private completed(
		toolCallId: string,
		result: Record<string, unknown> | undefined,
	): SessionNotification[] {
		const childSessionId = this.running.get(toolCallId);
		if (!childSessionId) {
			return [];
		}
		this.running.delete(toolCallId);

		const success = result && isObject(result.success) ? result.success : undefined;
		const agentId = nonEmptyString(success?.agentId);
		if (agentId) {
			this.childByAgentId.set(agentId, childSessionId);
		}

		const outputText = extractToolResultOutputText(result);
		const failed = isRejectedToolResult(result) || (result ? isObject(result.error) : false);
		if (failed) {
			return [
				this.stateUpdate(childSessionId, {
					state: "idle",
					stopReason: "error",
					error: {
						code: INTERNAL_ERROR_CODE,
						message: outputText ?? "The subagent failed",
					},
				}),
			];
		}

		const notifications = [
			this.stateUpdate(childSessionId, { state: "idle", stopReason: "end_turn" }),
		];
		if (outputText) {
			notifications.push(
				this.parentUpdate({
					sessionUpdate: "session_message",
					messageId: this.messageId(),
					senderSessionId: childSessionId,
					recipientSessionId: this.parentSessionId,
					content: [{ type: "text", text: outputText }],
				}),
			);
		}
		return notifications;
	}

	private stateUpdate(childSessionId: string, state: SubagentState): SessionNotification {
		return this.parentUpdate({
			sessionUpdate: "subagent_update",
			sessionId: childSessionId,
			state,
		});
	}

	private parentUpdate(update: SessionUpdate): SessionNotification {
		return { sessionId: this.parentSessionId, update };
	}

	private messageId(): string {
		return `${this.parentSessionId}:subagent-message:${this.nextMessageNumber++}`;
	}
}
