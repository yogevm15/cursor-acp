import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type SkillOrigin = "workspace" | "user" | "cursor";

const WORKSPACE_CONFIG_DIR_NAMES = [".cursor", ".agents"];
const SKIPPED_WORKSPACE_DIR_NAMES = new Set(["node_modules"]);
const MAX_WORKSPACE_DIRS_SCANNED = 10_000;

export interface CustomSkill {
	name: string;
	description: string;
	template: string;
	sourcePath: string;
	origin: SkillOrigin;
}

async function collectSkillFiles(dir: string): Promise<string[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
	} catch (error: unknown) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: string }).code === "ENOENT"
		) {
			return [];
		}
		throw error;
	}

	entries.sort((a, b) => a.name.localeCompare(b.name));

	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectSkillFiles(fullPath)));
			continue;
		}

		if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
			files.push(fullPath);
		}
	}

	return files;
}

function parseFrontmatter(markdown: string): {
	metadata: Record<string, string>;
	body: string;
} {
	const lines = markdown.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") {
		return { metadata: {}, body: markdown };
	}

	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i]?.trim() === "---") {
			end = i;
			break;
		}
	}

	if (end === -1) {
		return { metadata: {}, body: markdown };
	}

	const metadata: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const delimiter = line.indexOf(":");
		if (delimiter <= 0) {
			continue;
		}
		const key = line.slice(0, delimiter).trim().toLowerCase();
		const value = line.slice(delimiter + 1).trim();
		if (key && value) {
			metadata[key] = value;
		}
	}

	return {
		metadata,
		body: lines.slice(end + 1).join("\n"),
	};
}

function firstHeading(markdown: string): string | undefined {
	const match = markdown.match(/^\s*#\s+(.+)$/m);
	if (!match?.[1]) {
		return undefined;
	}
	const heading = match[1].trim();
	return heading.length > 0 ? heading : undefined;
}

function cleanMetadataValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed === "''" || trimmed === '""') {
		return undefined;
	}
	return trimmed.replace(/^['"](.+)['"]$/, "$1").trim() || undefined;
}

async function readSkill(filePath: string, origin: SkillOrigin): Promise<CustomSkill | null> {
	const raw = await fs.readFile(filePath, "utf8");
	const { metadata, body } = parseFrontmatter(raw);
	const template = body.trim();
	if (!template) {
		return null;
	}

	const heading = firstHeading(body);
	const dirName = path.basename(path.dirname(filePath)).trim();
	const name = cleanMetadataValue(metadata.name) || heading || dirName;
	if (!name) {
		return null;
	}

	const description =
		cleanMetadataValue(metadata.description) ||
		(heading && heading !== name ? heading : undefined) ||
		`Skill from ${dirName || path.basename(filePath)}`;

	return {
		name,
		description,
		template,
		sourcePath: filePath,
		origin,
	};
}

/**
 * Find every `.cursor` and `.agents` directory under `workspace`, breadth-first so
 * shallower directories come first. Hidden directories and `node_modules` are not
 * searched, and symlinked directories are not followed. The scan stops after
 * `maxDirs` directories so a huge workspace (such as a home directory) cannot stall
 * session setup.
 */
export async function findWorkspaceConfigDirs(
	workspace: string,
	maxDirs: number = MAX_WORKSPACE_DIRS_SCANNED,
): Promise<string[]> {
	const found: string[] = [];
	let scanned = 0;
	let level = [workspace];
	while (level.length > 0) {
		const next: string[] = [];
		for (const dir of level) {
			if (scanned >= maxDirs) {
				return found;
			}
			scanned += 1;
			let entries: import("node:fs").Dirent[];
			try {
				entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
			} catch {
				continue;
			}
			entries.sort((a, b) => a.name.localeCompare(b.name));

			const subdirs = entries.filter((entry) => entry.isDirectory());
			for (const name of WORKSPACE_CONFIG_DIR_NAMES) {
				if (subdirs.some((entry) => entry.name === name)) {
					found.push(path.join(dir, name));
				}
			}
			for (const entry of subdirs) {
				if (entry.name.startsWith(".") || SKIPPED_WORKSPACE_DIR_NAMES.has(entry.name)) {
					continue;
				}
				next.push(path.join(dir, entry.name));
			}
		}
		level = next;
	}
	return found;
}

export async function loadCustomSkills(
	workspace: string,
	homeDirectory: string = os.homedir(),
): Promise<CustomSkill[]> {
	const workspaceConfigDirs = await findWorkspaceConfigDirs(workspace);
	const skillRoots: Array<{ root: string; origin: SkillOrigin }> = [
		...workspaceConfigDirs.map((dir) => ({
			root: path.join(dir, "skills"),
			origin: "workspace" as const,
		})),
		{ root: path.join(homeDirectory, ".agents", "skills"), origin: "user" },
		{ root: path.join(homeDirectory, ".cursor", "skills"), origin: "user" },
		{
			root: path.join(homeDirectory, ".cursor", "skills-cursor"),
			origin: "cursor",
		},
	];

	const byName = new Map<string, CustomSkill>();
	for (const { root, origin } of skillRoots) {
		const files = await collectSkillFiles(root);
		for (const file of files) {
			let skill: CustomSkill | null;
			try {
				skill = await readSkill(file, origin);
			} catch {
				continue;
			}
			if (!skill) {
				continue;
			}
			const key = skill.name.toLowerCase();
			if (!byName.has(key)) {
				byName.set(key, skill);
			}
		}
	}

	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveSkillPrompt(commandName: string, skills: CustomSkill[]): string | null {
	const normalized = commandName.toLowerCase();
	const stripped = normalized.startsWith("skill:")
		? normalized.slice("skill:".length)
		: normalized.startsWith("skills:")
			? normalized.slice("skills:".length)
			: normalized.startsWith("skills/")
				? normalized.slice("skills/".length)
				: normalized;
	const match = skills.find((skill) => skill.name.toLowerCase() === stripped);
	return match?.template ?? null;
}
