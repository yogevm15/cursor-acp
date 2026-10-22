import { promises as fs } from "node:fs";
import path from "node:path";

const PROJECT_MARKERS = [".git", ".cursor", ".agents", "AGENTS.md"];
const SKIPPED_DIR_NAMES = new Set(["node_modules"]);

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function isInsideGitRepository(dir: string): Promise<boolean> {
	let current = path.resolve(dir);
	while (true) {
		if (await exists(path.join(current, ".git"))) {
			return true;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return false;
		}
		current = parent;
	}
}

async function findChildProjects(dir: string): Promise<string[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return [];
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));

	const projects: string[] = [];
	for (const entry of entries) {
		if (
			!entry.isDirectory() ||
			entry.name.startsWith(".") ||
			SKIPPED_DIR_NAMES.has(entry.name)
		) {
			continue;
		}
		const child = path.join(dir, entry.name);
		const markers = await Promise.all(
			PROJECT_MARKERS.map((marker) => exists(path.join(child, marker))),
		);
		if (markers.some(Boolean)) {
			projects.push(child);
		}
	}
	return projects;
}

/**
 * Workspace roots for the Cursor SDK, `cwd` first. The SDK loads project rules, skills,
 * and `AGENTS.md` per root, and it only searches a root for nested rules when the root
 * is in a Git repository. So when `cwd` is a plain folder of repositories, each direct
 * child that is a Git repository or has Cursor/agent config is added as its own root.
 */
export async function resolveWorkspaceRoots(
	cwd: string,
	additionalDirectories: readonly string[] = [],
): Promise<string[]> {
	const roots = [cwd, ...additionalDirectories];
	if (!(await isInsideGitRepository(cwd))) {
		roots.push(...(await findChildProjects(cwd)));
	}

	const seen = new Set<string>();
	return roots.filter((root) => {
		const key = path.resolve(root);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}
