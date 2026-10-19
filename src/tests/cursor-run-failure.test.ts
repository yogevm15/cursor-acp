import { describe, expect, it } from "vitest";
import {
	classifyCursorFailure,
	describeCursorFailure,
	failureFromResultEvent,
	failureFromThrown,
} from "../cursor-run-failure.js";

describe("classifyCursorFailure", () => {
	it.each([
		[{ message: "[resource_exhausted] Error" }, "rate_limit", true],
		[{ message: "Too many", code: "RATE_LIMITED" }, "rate_limit", true],
		[{ message: "Limit", code: "PRO_USER_USAGE_LIMIT" }, "usage_limit", false],
		[{ message: "[unauthenticated] Not logged in" }, "auth", false],
		[{ message: "Too long", code: "CONVERSATION_TOO_LONG" }, "conversation_too_long", false],
		[
			{ message: "[resource_exhausted] message size 1099801 is larger than configured max" },
			"message_too_large",
			false,
		],
		[{ message: "[unavailable] transport closed" }, "transient", true],
		[{ message: "Something odd", retryable: true }, "transient", true],
		[{ message: "Something odd" }, "unknown", false],
	])("classifies %o as %s", (input, kind, retryable) => {
		expect(classifyCursorFailure(input)).toMatchObject({ kind, retryable });
	});

	it("reads the code, request id, and transport flag from a result event", () => {
		expect(
			failureFromResultEvent({
				type: "result",
				subtype: "transport_error",
				is_error: true,
				result: "Error: RetriableError: WritableIterable is closed",
				request_id: "req-1",
			}),
		).toMatchObject({ kind: "transient", retryable: true, requestId: "req-1" });
	});

	it("reads structured fields from a thrown SDK error", () => {
		const error = Object.assign(new Error("Slow down"), {
			code: "resource_exhausted",
			isRetryable: true,
			requestId: "req-2",
		});
		expect(failureFromThrown(error)).toMatchObject({
			kind: "rate_limit",
			code: "resource_exhausted",
			requestId: "req-2",
		});
	});
});

describe("describeCursorFailure", () => {
	const rateLimit = classifyCursorFailure({ message: "[resource_exhausted] Error" });

	it("names the model and says nothing ran", () => {
		const { title, description } = describeCursorFailure(rateLimit, {
			modelName: "Opus 5.5",
			toolsRan: false,
			retries: 0,
		});
		expect(title).toBe("Cursor rate limit reached");
		expect(description).toContain("requests for Opus 5.5");
		expect(description).toContain("resend your message");
	});

	it("reports retries and kept work", () => {
		const { description } = describeCursorFailure(rateLimit, {
			modelName: "Opus 5.5",
			toolsRan: true,
			retries: 3,
		});
		expect(description).toContain("Retried 3 times.");
		expect(description).toContain("Send “continue”");
	});
});
