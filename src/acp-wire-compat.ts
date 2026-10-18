import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { isObject } from "./utils.js";

/** ACP SDK 1.9 closes the whole connection when one incoming line exceeds this limit. */
export const DEFAULT_ACP_MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

export function getAcpMaxMessageBytes(): number {
	const raw = process.env.CURSOR_ACP_MAX_MESSAGE_BYTES?.trim();
	if (!raw) {
		return DEFAULT_ACP_MAX_MESSAGE_BYTES;
	}
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ACP_MAX_MESSAGE_BYTES;
}

/** Top-level `LooseSessionDefaults` keys. The SDK strips unknown keys, so they move into `_meta`. */
const LOOSE_SESSION_DEFAULT_KEYS = [
	"modeId",
	"mode_id",
	"mode",
	"defaultModeId",
	"default_mode",
	"modelId",
	"model_id",
	"model",
	"defaultModelId",
	"default_model",
	"thinkingLevel",
	"thinking_level",
	"thinking",
	"defaultThinkingLevel",
	"default_thinking_level",
	"defaultThinking",
	"default_thinking",
	"fast",
	"defaultFast",
	"default_fast",
	"context",
	"defaultContext",
	"default_context",
	"defaultConfigOptions",
	"default_config_options",
	"cursor",
] as const;

const SESSION_SETUP_METHODS = new Set([
	"initialize",
	"session/new",
	"session/load",
	"session/resume",
	"session/fork",
]);

const MCP_SERVERS_REQUIRED_METHODS = new Set(["session/new", "session/load"]);
const MCP_SERVERS_OPTIONAL_METHODS = new Set(["session/resume", "session/fork"]);

function isNameValuePair(value: unknown): boolean {
	return isObject(value) && typeof value.name === "string" && typeof value.value === "string";
}

function repairMcpServer(server: unknown): Record<string, unknown> | undefined {
	if (!isObject(server) || typeof server.name !== "string") {
		return undefined;
	}

	if (server.type === "http" || server.type === "sse") {
		if (typeof server.url !== "string") {
			return undefined;
		}
		return {
			...server,
			headers: Array.isArray(server.headers) ? server.headers.filter(isNameValuePair) : [],
		};
	}

	if (server.type === "acp") {
		return typeof server.serverId === "string" ? server : undefined;
	}

	if (typeof server.command !== "string") {
		return undefined;
	}
	return {
		...server,
		args: Array.isArray(server.args)
			? server.args.filter((arg): arg is string => typeof arg === "string")
			: [],
		env: Array.isArray(server.env) ? server.env.filter(isNameValuePair) : [],
	};
}

function repairMcpServers(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map(repairMcpServer)
		.filter((server): server is Record<string, unknown> => server !== undefined);
}

function moveLooseDefaultsIntoMeta(params: Record<string, unknown>): Record<string, unknown> {
	const moved: Record<string, unknown> = {};
	for (const key of LOOSE_SESSION_DEFAULT_KEYS) {
		if (params[key] !== undefined) {
			moved[key] = params[key];
		}
	}
	if (Object.keys(moved).length === 0) {
		return params;
	}
	const meta = isObject(params._meta) ? params._meta : {};
	return { ...params, _meta: { ...moved, ...meta } };
}

/**
 * Restores the lenient session-setup parsing of ACP SDK 1.4: missing or malformed
 * `mcpServers` and `additionalDirectories` no longer reject the whole request.
 */
export function normalizeIncomingAgentRequestParams(
	method: string,
	params: Record<string, unknown>,
): Record<string, unknown> {
	if (!SESSION_SETUP_METHODS.has(method)) {
		return params;
	}

	let next = moveLooseDefaultsIntoMeta(params);

	if (MCP_SERVERS_REQUIRED_METHODS.has(method)) {
		next = { ...next, mcpServers: repairMcpServers(next.mcpServers) };
	} else if (MCP_SERVERS_OPTIONAL_METHODS.has(method) && next.mcpServers !== undefined) {
		next = { ...next, mcpServers: repairMcpServers(next.mcpServers) };
	}

	if (method !== "initialize" && next.additionalDirectories !== undefined) {
		next = {
			...next,
			additionalDirectories: Array.isArray(next.additionalDirectories)
				? next.additionalDirectories.filter(
						(directory): directory is string => typeof directory === "string",
					)
				: [],
		};
	}

	return next;
}

function optionalNumber(value: unknown): number | null | undefined {
	if (value === undefined || value === null) {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return undefined;
}

function withoutUndefined(params: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

/** Same leniency for requests that native `cursor-agent acp` sends to our client side. */
export function normalizeIncomingClientRequestParams(
	method: string,
	params: Record<string, unknown>,
): Record<string, unknown> {
	if (method === "fs/read_text_file") {
		return withoutUndefined({
			...params,
			line: optionalNumber(params.line),
			limit: optionalNumber(params.limit),
		});
	}

	if (method === "terminal/create") {
		return withoutUndefined({
			...params,
			args: Array.isArray(params.args)
				? params.args.filter((arg): arg is string => typeof arg === "string")
				: undefined,
			env: Array.isArray(params.env) ? params.env.filter(isNameValuePair) : undefined,
			cwd: typeof params.cwd === "string" || params.cwd === null ? params.cwd : undefined,
			outputByteLimit: optionalNumber(params.outputByteLimit),
		});
	}

	return params;
}

type ParamsNormalizer = (
	method: string,
	params: Record<string, unknown>,
) => Record<string, unknown>;

function normalizeMessage(message: unknown, normalize: ParamsNormalizer): unknown {
	if (Array.isArray(message)) {
		return message.map((entry) => normalizeMessage(entry, normalize));
	}
	if (!isObject(message) || typeof message.method !== "string") {
		return message;
	}
	const params = isObject(message.params) ? message.params : {};
	try {
		const normalized = normalize(message.method, params);
		return normalized === params ? message : { ...message, params: normalized };
	} catch {
		return message;
	}
}

function transformIncoming(stream: Stream, normalize: ParamsNormalizer): Stream {
	return {
		writable: stream.writable,
		readable: stream.readable.pipeThrough(
			new TransformStream<AnyMessage, AnyMessage>({
				transform(message, controller) {
					controller.enqueue(normalizeMessage(message, normalize) as AnyMessage);
				},
			}),
		),
	};
}

export function withLenientAgentRequests(stream: Stream): Stream {
	return transformIncoming(stream, normalizeIncomingAgentRequestParams);
}

export function withLenientClientRequests(stream: Stream): Stream {
	return transformIncoming(stream, normalizeIncomingClientRequestParams);
}
