import { describe, expect, it } from "vitest";
import {
	applyFastValue,
	applyThinkingValue,
	buildSdkModelSelection,
	contextWindowTokens,
	getFastParameterForModel,
	getThinkingParameter,
	inferFastValueFromModelId,
	mergeModelCatalogs,
	modelRequiresMaxMode,
	normalizeModelId,
	parameterValueRequiresMaxMode,
	resolveModelId,
	withCliModelParameters,
	withMaxModeLabel,
} from "../model-id.js";

describe("model id normalization", () => {
	it("keeps current model ids unchanged", () => {
		expect(normalizeModelId("composer-2-fast")).toBe("composer-2-fast");
		expect(normalizeModelId("gpt-5.4-medium")).toBe("gpt-5.4-medium");
	});

	it("maps default model aliases to auto", () => {
		expect(normalizeModelId("default")).toBe("auto");
		expect(normalizeModelId("default[]")).toBe("auto");
		expect(normalizeModelId("default[fast=true]")).toBe("auto");
	});

	it("converts legacy fast syntax to Cursor CLI model ids", () => {
		expect(normalizeModelId("composer-2[fast=true]")).toBe("composer-2-fast");
		expect(normalizeModelId("composer-2-fast[fast=false]")).toBe("composer-2");
	});

	it("resolves legacy model ids against the listed models", () => {
		expect(
			resolveModelId("composer-2[fast=true]", [
				{ modelId: "composer-2", name: "Composer 2" },
				{ modelId: "composer-2-fast", name: "Composer 2 Fast" },
			]),
		).toBe("composer-2-fast");
	});

	it("resolves default aliases against listed models", () => {
		expect(
			resolveModelId("default[]", [
				{ modelId: "auto", name: "Auto" },
				{ modelId: "gpt-5.4-medium", name: "GPT-5.4" },
			]),
		).toBe("auto");
	});

	it("infers fast and thinking parameters from Cursor CLI model variants", () => {
		const models = withCliModelParameters([
			{ modelId: "gpt-5.5-none", name: "GPT-5.5 None" },
			{ modelId: "gpt-5.5-medium", name: "GPT-5.5" },
			{ modelId: "gpt-5.5-medium-fast", name: "GPT-5.5 Fast" },
			{ modelId: "gpt-5.5-high", name: "GPT-5.5 High" },
			{ modelId: "gpt-5.5-high-fast", name: "GPT-5.5 High Fast" },
		]);

		const medium = models.find((model) => model.modelId === "gpt-5.5-medium");
		expect(medium?.parameters?.map((parameter) => parameter.id)).toEqual(["fast", "thinking"]);
		expect(
			medium?.parameters?.find((parameter) => parameter.id === "thinking")?.values,
		).toEqual([
			{ value: "none", displayName: "None" },
			{ value: "medium", displayName: "Medium" },
			{ value: "high", displayName: "High" },
		]);
	});

	it("maps fast and thinking parameter values back to concrete CLI model ids", () => {
		const models = withCliModelParameters([
			{ modelId: "gpt-5.5-medium", name: "GPT-5.5" },
			{ modelId: "gpt-5.5-medium-fast", name: "GPT-5.5 Fast" },
			{ modelId: "gpt-5.5-high", name: "GPT-5.5 High" },
			{ modelId: "gpt-5.5-high-fast", name: "GPT-5.5 High Fast" },
		]);

		expect(applyFastValue(models, "gpt-5.5-medium", "true")).toBe("gpt-5.5-medium-fast");
		expect(applyThinkingValue(models, "gpt-5.5-medium-fast", "high")).toBe("gpt-5.5-high-fast");
	});

	it("supports legacy bracket syntax with thinking and fast values", () => {
		expect(
			resolveModelId("gpt-5.5[thinking=high,fast=true]", [
				{ modelId: "gpt-5.5-medium", name: "GPT-5.5" },
				{ modelId: "gpt-5.5-medium-fast", name: "GPT-5.5 Fast" },
				{ modelId: "gpt-5.5-high", name: "GPT-5.5 High" },
				{ modelId: "gpt-5.5-high-fast", name: "GPT-5.5 High Fast" },
			]),
		).toBe("gpt-5.5-high-fast");
	});

	it("infers fast config when only the base model variant is listed", () => {
		const catalog = withCliModelParameters([{ modelId: "composer-2.5", name: "Composer 2.5" }]);

		expect(getFastParameterForModel(catalog, "composer-2.5-fast")).toMatchObject({
			id: "fast",
		});
		expect(inferFastValueFromModelId(catalog, "composer-2.5-fast")).toBe("true");
	});

	it("merges sibling variants from an earlier model listing", () => {
		const merged = mergeModelCatalogs(
			[{ modelId: "composer-2.5-fast", name: "Composer 2.5 Fast", current: true }],
			withCliModelParameters([
				{ modelId: "composer-2.5", name: "Composer 2.5" },
				{ modelId: "composer-2.5-fast", name: "Composer 2.5 Fast" },
			]),
		);

		expect(
			getFastParameterForModel(withCliModelParameters(merged), "composer-2.5-fast"),
		).toMatchObject({ id: "fast" });
	});

	it("builds the SDK parameterized model selection used by Zed controls", () => {
		const catalog = [
			{
				modelId: "composer-2.5",
				name: "Composer 2.5",
				parameters: [
					{
						id: "fast",
						values: [{ value: "false" }, { value: "true" }],
					},
					{
						id: "thinking",
						values: [{ value: "medium" }, { value: "high" }],
					},
				],
			},
		];

		expect(buildSdkModelSelection("composer-2.5", catalog, "high", "true")).toEqual({
			id: "composer-2.5",
			params: [
				{ id: "thinking", value: "high" },
				{ id: "fast", value: "true" },
			],
		});
	});

	it("preserves the SDK reasoning parameter id behind the thinking selector", () => {
		const catalog = [
			{
				modelId: "gpt-5.6-sol",
				name: "GPT-5.6 Sol",
				parameters: [
					{
						id: "reasoning",
						values: [{ value: "low" }, { value: "high" }],
					},
					{
						id: "fast",
						values: [{ value: "false" }, { value: "true" }],
					},
				],
			},
		];

		expect(buildSdkModelSelection("gpt-5.6-sol", catalog, "high", "true")).toEqual({
			id: "gpt-5.6-sol",
			params: [
				{ id: "reasoning", value: "high" },
				{ id: "fast", value: "true" },
			],
		});
	});

	it("sends the selected context window and ignores values the model does not offer", () => {
		const catalog = [
			{
				modelId: "gpt-5.6-sol",
				name: "GPT-5.6 Sol",
				parameters: [
					{
						id: "context",
						values: [{ value: "272k" }, { value: "1m" }],
					},
				],
			},
		];

		expect(buildSdkModelSelection("gpt-5.6-sol", catalog, undefined, undefined, "1m")).toEqual({
			id: "gpt-5.6-sol",
			params: [{ id: "context", value: "1m" }],
		});
		expect(buildSdkModelSelection("gpt-5.6-sol", catalog, undefined, undefined, "2m")).toEqual({
			id: "gpt-5.6-sol",
		});
	});

	it("converts SDK context values to token counts", () => {
		expect(contextWindowTokens("272k")).toBe(272_000);
		expect(contextWindowTokens("1m")).toBe(1_000_000);
		expect(contextWindowTokens("1.5M")).toBe(1_500_000);
		expect(contextWindowTokens("200000")).toBe(200_000);
		expect(contextWindowTokens("max")).toBeUndefined();
		expect(contextWindowTokens(undefined)).toBeUndefined();
	});
});

describe("thinking parameter selection", () => {
	const claude = {
		modelId: "claude-opus-5",
		name: "Opus 5",
		parameters: [
			{ id: "thinking", values: [{ value: "false" }, { value: "true" }] },
			{ id: "effort", values: [{ value: "low" }, { value: "max" }] },
		],
		variants: [
			{
				params: [
					{ id: "thinking", value: "false" },
					{ id: "effort", value: "low" },
				],
			},
			{
				params: [
					{ id: "thinking", value: "true" },
					{ id: "effort", value: "low" },
				],
				isDefault: true,
			},
			{
				params: [
					{ id: "thinking", value: "true" },
					{ id: "effort", value: "max" },
				],
			},
		],
	};

	it("prefers a multi-level effort parameter over an on/off thinking parameter", () => {
		expect(getThinkingParameter(claude)?.id).toBe("effort");
	});

	it("recognizes reasoning_effort", () => {
		expect(
			getThinkingParameter({
				modelId: "grok",
				name: "Grok",
				parameters: [
					{ id: "reasoning_effort", values: [{ value: "low" }, { value: "high" }] },
				],
			})?.id,
		).toBe("reasoning_effort");
	});

	it("keeps an on/off thinking parameter when it is the only one", () => {
		expect(
			getThinkingParameter({
				modelId: "claude-haiku-4-5",
				name: "Haiku",
				parameters: [{ id: "thinking", values: [{ value: "false" }, { value: "true" }] }],
			})?.id,
		).toBe("thinking");
	});

	it("sends the default thinking switch value with the selected effort", () => {
		expect(buildSdkModelSelection("claude-opus-5", [claude], "low")).toEqual({
			id: "claude-opus-5",
			params: [
				{ id: "effort", value: "low" },
				{ id: "thinking", value: "true" },
			],
		});
		expect(buildSdkModelSelection("claude-opus-5", [claude], "max").params).toContainEqual({
			id: "thinking",
			value: "true",
		});
	});
});

describe("Max Mode metadata", () => {
	const catalog = [
		{
			modelId: "claude-opus",
			name: "Opus",
			parameters: [
				{
					id: "context",
					values: [{ value: "200k" }, { value: "1m" }],
				},
			],
			variants: [
				{ params: [{ id: "context", value: "200k" }], isDefault: true },
				{ params: [{ id: "context", value: "1m" }], isMaxMode: true },
			],
		},
		{
			modelId: "max-only",
			name: "Max only",
			variants: [{ params: [], isMaxMode: true }],
		},
	];

	it("marks parameter values whose variants all need Max Mode", () => {
		expect(parameterValueRequiresMaxMode(catalog, "claude-opus", "context", "1m")).toBe(true);
		expect(parameterValueRequiresMaxMode(catalog, "claude-opus", "context", "200k")).toBe(
			false,
		);
		expect(parameterValueRequiresMaxMode(catalog, "claude-opus", "context", "5m")).toBe(false);
	});

	it("marks models whose variants all need Max Mode", () => {
		expect(modelRequiresMaxMode(catalog, "max-only")).toBe(true);
		expect(modelRequiresMaxMode(catalog, "claude-opus")).toBe(false);
		expect(modelRequiresMaxMode(catalog, "unknown")).toBe(false);
	});

	it("adds a label only when Max Mode is required", () => {
		expect(withMaxModeLabel("1M", true)).toBe("1M (Max Mode)");
		expect(withMaxModeLabel("200K", false)).toBe("200K");
	});
});
