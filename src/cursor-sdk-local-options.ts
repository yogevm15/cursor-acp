import type { LocalAgentOptions, SettingSource } from "@cursor/sdk";

export const LOCAL_SETTING_SOURCES: readonly SettingSource[] = ["user", "project"];

export function buildLocalAgentOptions(
	cwd: string,
	autoReview: boolean,
	workspaceRoots: readonly string[] = [],
): LocalAgentOptions {
	return {
		cwd,
		...(workspaceRoots.length > 1 ? { dirs: [...workspaceRoots] } : {}),
		autoReview,
		settingSources: [...LOCAL_SETTING_SOURCES],
	};
}
