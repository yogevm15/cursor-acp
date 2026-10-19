import type { CursorStreamEvent } from "./cursor-runner.js";
import { isObject } from "./utils.js";

export type CursorFailureKind =
	| "rate_limit"
	| "usage_limit"
	| "auth"
	| "conversation_too_long"
	| "message_too_large"
	| "transient"
	| "unknown";

export interface CursorRunFailure {
	kind: CursorFailureKind;
	/** Whether waiting and retrying the same request can succeed. */
	retryable: boolean;
	/** The raw diagnostic from Cursor or the SDK. */
	message: string;
	/** Lowercase gRPC code (`resource_exhausted`) or Cursor error name (`pro_user_usage_limit`). */
	code?: string;
	requestId?: string;
}

const USAGE_LIMIT_CODES = new Set([
	"free_user_usage_limit",
	"pro_user_usage_limit",
	"usage_pricing_required",
	"usage_pricing_required_changeable",
]);

const RATE_LIMIT_CODES = new Set([
	"resource_exhausted",
	"free_user_rate_limit_exceeded",
	"pro_user_rate_limit_exceeded",
	"openai_rate_limit_exceeded",
	"generic_rate_limit_exceeded",
	"gpt_4_vision_preview_rate_limit",
	"api_key_rate_limit",
	"rate_limited",
	"rate_limited_changeable",
]);

const AUTH_CODES = new Set([
	"unauthenticated",
	"not_logged_in",
	"invalid_auth_id",
	"agent_requires_login",
	"auth_token_not_found",
	"auth_token_expired",
	"unauthorized",
	"bad_api_key",
	"bad_user_api_key",
]);

const TRANSIENT_CODES = new Set([
	"unavailable",
	"aborted",
	"deadline_exceeded",
	"timeout",
	"network_error",
]);

const CONVERSATION_TOO_LONG_CODES = new Set(["conversation_too_long"]);

/** gRPC's local size check, e.g. "message size 1099801 is larger than configured max". */
const MESSAGE_TOO_LARGE = /\blarger than (?:the )?(?:configured )?max/i;
const BRACKETED_CODE = /\[([a-z_]+)\]/;

function classify(code: string | undefined, message: string): CursorFailureKind {
	if (code && USAGE_LIMIT_CODES.has(code)) return "usage_limit";
	if (code && AUTH_CODES.has(code)) return "auth";
	if (code && CONVERSATION_TOO_LONG_CODES.has(code)) return "conversation_too_long";
	if (MESSAGE_TOO_LARGE.test(message)) return "message_too_large";
	if (code && RATE_LIMIT_CODES.has(code)) return "rate_limit";
	if (code && TRANSIENT_CODES.has(code)) return "transient";
	return "unknown";
}

export function classifyCursorFailure(input: {
	message: string;
	code?: string;
	requestId?: string;
	/** The SDK's own retry hint, when it gave one. */
	retryable?: boolean;
	/** Set for a standalone transport diagnostic in the assistant reply. */
	transport?: boolean;
}): CursorRunFailure {
	const message = input.message.trim() || "Cursor failed";
	// ConnectError messages read "[resource_exhausted] Error" when no structured code survived.
	const code = (input.code ?? BRACKETED_CODE.exec(message)?.[1])?.toLowerCase();
	let kind = classify(code, message);
	if (kind === "unknown" && (input.transport || input.retryable)) {
		kind = "transient";
	}
	return {
		kind,
		retryable: kind === "rate_limit" || kind === "transient",
		message,
		...(code ? { code } : {}),
		...(input.requestId ? { requestId: input.requestId } : {}),
	};
}

/** Reads the failure carried on a runner `result` event. */
export function failureFromResultEvent(event: CursorStreamEvent): CursorRunFailure {
	const subtype = typeof event.subtype === "string" ? event.subtype : "";
	return classifyCursorFailure({
		message: typeof event.result === "string" && event.result ? event.result : subtype,
		code: typeof event.error_code === "string" ? event.error_code : undefined,
		requestId: typeof event.request_id === "string" ? event.request_id : undefined,
		retryable: typeof event.retryable === "boolean" ? event.retryable : undefined,
		transport: subtype === "transport_error",
	});
}

/** Reads `code`, `isRetryable`, and `requestId` from a thrown `CursorSdkError` or `ConnectError`. */
export function failureFromThrown(error: unknown): CursorRunFailure {
	const message = error instanceof Error ? error.message : String(error);
	if (!isObject(error)) {
		return classifyCursorFailure({ message });
	}
	return classifyCursorFailure({
		message,
		code: typeof error.code === "string" ? error.code : undefined,
		requestId: typeof error.requestId === "string" ? error.requestId : undefined,
		retryable: typeof error.isRetryable === "boolean" ? error.isRetryable : undefined,
	});
}

/** A failed Cursor run, with whether any tool call ran before it failed. */
export class CursorRunError extends Error {
	constructor(
		readonly failure: CursorRunFailure,
		readonly toolsRan: boolean,
	) {
		super(failure.message);
		this.name = "CursorRunError";
	}
}

export function describeCursorFailure(
	failure: CursorRunFailure,
	context: { modelName: string; toolsRan: boolean; retries: number },
): { title: string; description: string } {
	const { modelName } = context;
	let title: string;
	let advice: string;
	switch (failure.kind) {
		case "rate_limit":
			title = "Cursor rate limit reached";
			advice = `Cursor is limiting requests for ${modelName}. Wait a minute or two before retrying, or switch to another model. If this keeps happening, check your Cursor plan's usage limits.`;
			break;
		case "usage_limit":
			title = "Cursor usage limit reached";
			advice = `Your Cursor plan has reached its usage limit for ${modelName}. Switch to another model, or check usage in your Cursor dashboard.`;
			break;
		case "auth":
			title = "Cursor sign-in required";
			advice = "Run `cursor-acp login` or set CURSOR_API_KEY, then try again.";
			break;
		case "conversation_too_long":
			title = "Conversation too long for Cursor";
			advice = "Start a new session, or switch to a model with a larger context window.";
			break;
		case "message_too_large":
			title = "Request too large for Cursor";
			advice =
				"A message or attachment exceeded Cursor's size limit. Start a new session or attach less content.";
			break;
		case "transient":
			title = "Cursor connection problem";
			advice = "Cursor's servers did not complete the request. Try again shortly.";
			break;
		case "unknown":
			title = "Cursor request failed";
			advice = `Cursor returned: ${failure.message}`;
			break;
	}

	const parts = [advice];
	if (context.retries > 0) {
		parts.push(`Retried ${context.retries} ${context.retries === 1 ? "time" : "times"}.`);
	}
	parts.push(
		context.toolsRan
			? "Tool calls and edits made before the error were kept. Send “continue” to pick up where it stopped."
			: "Nothing ran before the error, so you can resend your message.",
	);
	return { title, description: parts.join(" ") };
}

/** Sent instead of the original prompt when tools already ran in a failed attempt. */
export function continuationPrompt(originalPrompt: string): string {
	return [
		"Your previous response was interrupted by a temporary Cursor server error.",
		"Some of its tool calls may already have run, so check the current state before repeating any action, then continue the task.",
		"The original request was:",
		"",
		originalPrompt,
	].join("\n");
}
