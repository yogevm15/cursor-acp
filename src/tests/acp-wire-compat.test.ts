import { describe, expect, it } from "vitest";
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import {
	DEFAULT_ACP_MAX_MESSAGE_BYTES,
	getAcpMaxMessageBytes,
	normalizeIncomingAgentRequestParams,
	normalizeIncomingClientRequestParams,
	withLenientAgentRequests,
} from "../acp-wire-compat.js";

describe("normalizeIncomingAgentRequestParams", () => {
	it("adds missing mcpServers for session/new and session/load", () => {
		expect(normalizeIncomingAgentRequestParams("session/new", { cwd: "/tmp" })).toEqual({
			cwd: "/tmp",
			mcpServers: [],
		});
		expect(
			normalizeIncomingAgentRequestParams("session/load", { cwd: "/tmp", sessionId: "s" }),
		).toEqual({ cwd: "/tmp", sessionId: "s", mcpServers: [] });
	});

	it("drops malformed MCP servers and repairs missing arrays", () => {
		const params = normalizeIncomingAgentRequestParams("session/new", {
			cwd: "/tmp",
			mcpServers: [
				{ bogus: 1 },
				{ name: "stdio", command: "node", args: ["a", 2] },
				{ type: "http", name: "web", url: "https://example.com" },
				{ type: "http", name: "no-url" },
				{ type: "acp", name: "acp", serverId: "id" },
			],
		});
		expect(params.mcpServers).toEqual([
			{ name: "stdio", command: "node", args: ["a"], env: [] },
			{ type: "http", name: "web", url: "https://example.com", headers: [] },
			{ type: "acp", name: "acp", serverId: "id" },
		]);
	});

	it("keeps optional mcpServers omitted for session/resume and session/fork", () => {
		expect(
			normalizeIncomingAgentRequestParams("session/resume", { cwd: "/tmp", sessionId: "s" }),
		).toEqual({ cwd: "/tmp", sessionId: "s" });
	});

	it("filters additionalDirectories to strings", () => {
		const params = normalizeIncomingAgentRequestParams("session/new", {
			cwd: "/tmp",
			mcpServers: [],
			additionalDirectories: ["/a", 3, null],
		});
		expect(params.additionalDirectories).toEqual(["/a"]);
	});

	it("moves top-level session defaults into _meta without overriding _meta", () => {
		const params = normalizeIncomingAgentRequestParams("session/new", {
			cwd: "/tmp",
			mcpServers: [],
			modeId: "plan",
			default_model: "gpt-5.4",
			_meta: { modeId: "ask" },
		});
		expect(params._meta).toEqual({ modeId: "ask", default_model: "gpt-5.4" });
	});

	it("moves initialize defaults into _meta", () => {
		const params = normalizeIncomingAgentRequestParams("initialize", {
			protocolVersion: 1,
			default_mode: "plan",
		});
		expect(params._meta).toEqual({ default_mode: "plan" });
	});

	it("does not change other methods", () => {
		const params = { sessionId: "s", prompt: [], modeId: "plan" };
		expect(normalizeIncomingAgentRequestParams("session/prompt", params)).toBe(params);
	});
});

describe("normalizeIncomingClientRequestParams", () => {
	it("drops invalid fs/read_text_file line and limit values", () => {
		expect(
			normalizeIncomingClientRequestParams("fs/read_text_file", {
				sessionId: "s",
				path: "/a",
				line: "12",
				limit: "all",
			}),
		).toEqual({ sessionId: "s", path: "/a", line: 12 });
	});

	it("repairs terminal/create arrays", () => {
		expect(
			normalizeIncomingClientRequestParams("terminal/create", {
				sessionId: "s",
				command: "ls",
				args: ["-l", 1],
				env: [{ name: "A", value: "1" }, { name: "B" }],
				outputByteLimit: "x",
			}),
		).toEqual({
			sessionId: "s",
			command: "ls",
			args: ["-l"],
			env: [{ name: "A", value: "1" }],
		});
	});
});

describe("withLenientAgentRequests", () => {
	it("normalizes incoming requests and passes other messages through", async () => {
		const incoming: unknown[] = [
			{ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } },
			{ jsonrpc: "2.0", id: 2, result: {} },
			{ jsonrpc: "2.0", method: "session/cancel" },
		];
		const stream: Stream = {
			writable: new WritableStream<AnyMessage>(),
			readable: new ReadableStream<AnyMessage>({
				start(controller) {
					for (const message of incoming) {
						controller.enqueue(message as AnyMessage);
					}
					controller.close();
				},
			}),
		};

		const received: unknown[] = [];
		const reader = withLenientAgentRequests(stream).readable.getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			received.push(value);
		}

		expect(received).toEqual([
			{
				jsonrpc: "2.0",
				id: 1,
				method: "session/new",
				params: { cwd: "/tmp", mcpServers: [] },
			},
			{ jsonrpc: "2.0", id: 2, result: {} },
			{ jsonrpc: "2.0", method: "session/cancel" },
		]);
	});
});

describe("getAcpMaxMessageBytes", () => {
	it("uses the env value when valid and the default otherwise", () => {
		const original = process.env.CURSOR_ACP_MAX_MESSAGE_BYTES;
		try {
			process.env.CURSOR_ACP_MAX_MESSAGE_BYTES = "1024";
			expect(getAcpMaxMessageBytes()).toBe(1024);
			process.env.CURSOR_ACP_MAX_MESSAGE_BYTES = "nope";
			expect(getAcpMaxMessageBytes()).toBe(DEFAULT_ACP_MAX_MESSAGE_BYTES);
			delete process.env.CURSOR_ACP_MAX_MESSAGE_BYTES;
			expect(getAcpMaxMessageBytes()).toBe(DEFAULT_ACP_MAX_MESSAGE_BYTES);
		} finally {
			if (original === undefined) {
				delete process.env.CURSOR_ACP_MAX_MESSAGE_BYTES;
			} else {
				process.env.CURSOR_ACP_MAX_MESSAGE_BYTES = original;
			}
		}
	});
});
