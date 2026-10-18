import type { Usage } from "@agentclientprotocol/sdk";
import type { TokenUsage } from "@cursor/sdk";
import type { CursorStreamEvent } from "./cursor-runner.js";
import { isObject } from "./utils.js";

export interface TurnUsage {
	usage: TokenUsage;
	modelCalls: number;
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function turnUsageFromEvent(event: CursorStreamEvent): TurnUsage | undefined {
	if (event.type !== "usage" || !isObject(event.usage)) {
		return undefined;
	}
	const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens } =
		event.usage;
	if (
		!isTokenCount(inputTokens) ||
		!isTokenCount(outputTokens) ||
		!isTokenCount(cacheReadTokens) ||
		!isTokenCount(cacheWriteTokens) ||
		!isTokenCount(totalTokens)
	) {
		return undefined;
	}
	const reasoningTokens = event.usage.reasoningTokens;
	return {
		usage: {
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			totalTokens,
			...(isTokenCount(reasoningTokens) ? { reasoningTokens } : {}),
		},
		modelCalls:
			typeof event.model_calls === "number" && event.model_calls >= 1
				? Math.floor(event.model_calls)
				: 1,
	};
}

/**
 * Estimate the tokens in context after a turn.
 *
 * The SDK reports one sum over every model call in the turn, and `inputTokens` already
 * includes cached tokens. A single-call turn is exact. For multi-call turns, the prompt is
 * assumed to grow linearly from the previous turn's context to the last call.
 */
export function estimateContextTokens(
	{ usage, modelCalls }: TurnUsage,
	previousContextTokens?: number,
): number {
	const calls = Math.max(1, modelCalls);
	const averageInput = usage.inputTokens / calls;
	const firstInput = previousContextTokens ?? averageInput;
	const lastInput = Math.min(
		usage.inputTokens,
		Math.max(averageInput, 2 * averageInput - firstInput),
	);
	return Math.round(lastInput + usage.outputTokens / calls);
}

export function toAcpUsage(usage: TokenUsage): Usage {
	return {
		totalTokens: usage.totalTokens,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cachedReadTokens: usage.cacheReadTokens,
		cachedWriteTokens: usage.cacheWriteTokens,
		...(usage.reasoningTokens !== undefined ? { thoughtTokens: usage.reasoningTokens } : {}),
	};
}

export function addAcpUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
	if (!left || !right) {
		return left ?? right;
	}
	const sum = (a: number | null | undefined, b: number | null | undefined) =>
		a == null && b == null ? undefined : (a ?? 0) + (b ?? 0);
	const thoughtTokens = sum(left.thoughtTokens, right.thoughtTokens);
	return {
		totalTokens: left.totalTokens + right.totalTokens,
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		cachedReadTokens: sum(left.cachedReadTokens, right.cachedReadTokens) ?? 0,
		cachedWriteTokens: sum(left.cachedWriteTokens, right.cachedWriteTokens) ?? 0,
		...(thoughtTokens !== undefined ? { thoughtTokens } : {}),
	};
}
