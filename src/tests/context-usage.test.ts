import { describe, expect, it } from "vitest";
import {
	addAcpUsage,
	estimateContextTokens,
	toAcpUsage,
	turnUsageFromEvent,
} from "../context-usage.js";

const usage = {
	inputTokens: 30_000,
	outputTokens: 300,
	cacheReadTokens: 20_000,
	cacheWriteTokens: 1_000,
	totalTokens: 51_300,
};

describe("context usage", () => {
	it("reads SDK usage events and ignores other events", () => {
		expect(turnUsageFromEvent({ type: "usage", usage, model_calls: 3 })).toEqual({
			usage,
			modelCalls: 3,
		});
		expect(turnUsageFromEvent({ type: "usage", usage })).toEqual({ usage, modelCalls: 1 });
		expect(turnUsageFromEvent({ type: "usage", usage: { inputTokens: 1 } })).toBeUndefined();
		expect(turnUsageFromEvent({ type: "assistant" })).toBeUndefined();
	});

	it("uses exact input and output for a single model call", () => {
		expect(estimateContextTokens({ usage, modelCalls: 1 }, 12_000)).toBe(30_300);
	});

	it("estimates the last call of a multi-call turn from the previous context", () => {
		// Calls of 9k, 10k, and 11k input tokens after a 9k context.
		expect(
			estimateContextTokens(
				{ usage: { ...usage, inputTokens: 30_000, outputTokens: 300 }, modelCalls: 3 },
				9_000,
			),
		).toBe(11_100);
		expect(estimateContextTokens({ usage, modelCalls: 3 })).toBe(10_100);
	});

	it("maps SDK usage to ACP usage and adds attempts", () => {
		const acpUsage = toAcpUsage({ ...usage, reasoningTokens: 50 });
		expect(acpUsage).toEqual({
			totalTokens: 51_300,
			inputTokens: 30_000,
			outputTokens: 300,
			cachedReadTokens: 20_000,
			cachedWriteTokens: 1_000,
			thoughtTokens: 50,
		});
		expect(addAcpUsage(acpUsage, toAcpUsage(usage))).toEqual({
			totalTokens: 102_600,
			inputTokens: 60_000,
			outputTokens: 600,
			cachedReadTokens: 40_000,
			cachedWriteTokens: 2_000,
			thoughtTokens: 50,
		});
		expect(addAcpUsage(undefined, acpUsage)).toBe(acpUsage);
	});
});
