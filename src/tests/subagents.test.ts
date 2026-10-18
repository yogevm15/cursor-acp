import { describe, expect, it } from "vitest";
import type { CursorStreamEvent } from "../cursor-runner.js";
import { SubagentTracker } from "../subagents.js";

function taskStarted(callId: string, args: Record<string, unknown>): CursorStreamEvent {
	return {
		type: "tool_call",
		subtype: "started",
		call_id: callId,
		tool_call: { taskToolCall: { args } },
	};
}

function taskCompleted(
	callId: string,
	result: Record<string, unknown> | undefined,
): CursorStreamEvent {
	return {
		type: "tool_call",
		subtype: "completed",
		call_id: callId,
		tool_call: { taskToolCall: { args: {}, ...(result ? { result } : {}) } },
	};
}

describe("SubagentTracker", () => {
	it("announces a running child and reports the delegated prompt", () => {
		const tracker = new SubagentTracker("parent");
		const notifications = tracker.handleEvent(
			taskStarted("call-1", {
				description: "Explore tests",
				prompt: "Find the failing test",
				subagentType: { kind: "explore" },
			}),
		);

		expect(notifications).toEqual([
			{
				sessionId: "parent",
				update: {
					sessionUpdate: "subagent_update",
					sessionId: "parent:subagent:call-1",
					title: "Explore tests",
					description: "explore",
					state: { state: "running" },
				},
			},
			{
				sessionId: "parent",
				update: {
					sessionUpdate: "session_message",
					messageId: "parent:subagent-message:1",
					senderSessionId: "parent",
					recipientSessionId: "parent:subagent:call-1",
					content: [{ type: "text", text: "Find the failing test" }],
				},
			},
		]);
		expect(tracker.hasRunningChildren).toBe(true);
	});

	it("reports idle end_turn and the child reply on success", () => {
		const tracker = new SubagentTracker("parent");
		tracker.handleEvent(taskStarted("call-1", { description: "Explore" }));
		const notifications = tracker.handleEvent(
			taskCompleted("call-1", { success: { agentId: "agent-9", text: "Done" } }),
		);

		expect(notifications.map((n) => n.update)).toEqual([
			{
				sessionUpdate: "subagent_update",
				sessionId: "parent:subagent:call-1",
				state: { state: "idle", stopReason: "end_turn" },
			},
			{
				sessionUpdate: "session_message",
				messageId: "parent:subagent-message:1",
				senderSessionId: "parent:subagent:call-1",
				recipientSessionId: "parent",
				content: [{ type: "text", text: "Done" }],
			},
		]);
		expect(tracker.hasRunningChildren).toBe(false);
	});

	it("reports idle error when the task fails", () => {
		const tracker = new SubagentTracker("parent");
		tracker.handleEvent(taskStarted("call-1", { description: "Explore" }));
		const [notification] = tracker.handleEvent(
			taskCompleted("call-1", { error: { message: "boom" } }),
		);

		expect(notification?.update).toEqual({
			sessionUpdate: "subagent_update",
			sessionId: "parent:subagent:call-1",
			state: {
				state: "idle",
				stopReason: "error",
				error: { code: -32603, message: "boom" },
			},
		});
	});

	it("reuses the child session when a task resumes the same Cursor subagent", () => {
		const tracker = new SubagentTracker("parent");
		tracker.handleEvent(taskStarted("call-1", { description: "Explore" }));
		tracker.handleEvent(taskCompleted("call-1", { success: { agentId: "agent-9" } }));

		const [announcement] = tracker.handleEvent(
			taskStarted("call-2", { description: "Explore more", resume: "agent-9" }),
		);
		expect(announcement?.update).toMatchObject({
			sessionUpdate: "subagent_update",
			sessionId: "parent:subagent:call-1",
		});
	});

	it("ignores other tools and reports remaining children on stopAll", () => {
		const tracker = new SubagentTracker("parent");
		expect(
			tracker.handleEvent({
				type: "tool_call",
				subtype: "started",
				call_id: "x",
				tool_call: { shellToolCall: { args: { command: "ls" } } },
			}),
		).toEqual([]);

		tracker.handleEvent(taskStarted("call-1", { description: "Explore" }));
		expect(tracker.stopAll({ state: "idle", stopReason: "cancelled" })).toEqual([
			{
				sessionId: "parent",
				update: {
					sessionUpdate: "subagent_update",
					sessionId: "parent:subagent:call-1",
					state: { state: "idle", stopReason: "cancelled" },
				},
			},
		]);
		expect(tracker.hasRunningChildren).toBe(false);
	});
});
