import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findWorkspaceConfigDirs, loadCustomSkills } from "../skills.js";

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "SKILL.md"),
		["---", `name: ${name}`, `description: ${description}`, "---", `${name} body`].join("\n"),
		"utf8",
	);
}

describe("skills", () => {
	it("loads skills from nested .cursor and .agents directories in the workspace", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-skill-"));
		const workspace = path.join(tempRoot, "workspace");
		const home = path.join(tempRoot, "home");

		await writeSkill(path.join(workspace, ".cursor", "skills", "shared"), "shared", "Root");
		await writeSkill(
			path.join(workspace, "packages", "api", ".cursor", "skills", "shared"),
			"shared",
			"Nested",
		);
		await writeSkill(
			path.join(workspace, "packages", "api", ".agents", "skills", "api-skill"),
			"api-skill",
			"API skill",
		);
		await writeSkill(
			path.join(workspace, "packages", "web", "src", ".cursor", "skills", "web-skill"),
			"web-skill",
			"Web skill",
		);
		await writeSkill(
			path.join(workspace, "node_modules", "dep", ".cursor", "skills", "dep-skill"),
			"dep-skill",
			"Dependency skill",
		);
		await writeSkill(
			path.join(workspace, ".git", "nested", ".cursor", "skills", "hidden-skill"),
			"hidden-skill",
			"Hidden skill",
		);

		try {
			const skills = await loadCustomSkills(workspace, home);
			expect(skills.map((skill) => skill.name)).toEqual(["api-skill", "shared", "web-skill"]);
			expect(skills.every((skill) => skill.origin === "workspace")).toBe(true);
			expect(skills.find((skill) => skill.name === "shared")?.description).toBe("Root");
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("lists workspace config directories breadth-first and stops at the scan limit", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-skill-"));
		await mkdir(path.join(tempRoot, "a", "b", ".cursor"), { recursive: true });
		await mkdir(path.join(tempRoot, "z", ".agents"), { recursive: true });
		await mkdir(path.join(tempRoot, ".agents"), { recursive: true });
		await mkdir(path.join(tempRoot, ".cursor"), { recursive: true });

		try {
			expect(await findWorkspaceConfigDirs(tempRoot)).toEqual([
				path.join(tempRoot, ".cursor"),
				path.join(tempRoot, ".agents"),
				path.join(tempRoot, "z", ".agents"),
				path.join(tempRoot, "a", "b", ".cursor"),
			]);
			expect(await findWorkspaceConfigDirs(tempRoot, 1)).toEqual([
				path.join(tempRoot, ".cursor"),
				path.join(tempRoot, ".agents"),
			]);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("loads skills from workspace, user, and cursor roots", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-skill-"));
		const workspace = path.join(tempRoot, "workspace");
		const home = path.join(tempRoot, "home");

		const workspaceSkill = path.join(workspace, ".cursor", "skills", "workspace-skill");
		const userSkill = path.join(home, ".agents", "skills", "user-skill");
		const cursorSkill = path.join(home, ".cursor", "skills-cursor", "cursor-skill");

		await mkdir(workspaceSkill, { recursive: true });
		await mkdir(userSkill, { recursive: true });
		await mkdir(cursorSkill, { recursive: true });

		await writeFile(
			path.join(workspaceSkill, "SKILL.md"),
			[
				"---",
				"name: workspace-skill",
				"description: Workspace skill",
				"---",
				"Workspace skill body",
			].join("\n"),
			"utf8",
		);

		await writeFile(
			path.join(userSkill, "SKILL.md"),
			["---", "name: user-skill", "description: User skill", "---", "User skill body"].join(
				"\n",
			),
			"utf8",
		);

		await writeFile(
			path.join(cursorSkill, "SKILL.md"),
			[
				"---",
				"name: cursor-skill",
				"description: Cursor skill",
				"---",
				"Cursor skill body",
			].join("\n"),
			"utf8",
		);

		try {
			const skills = await loadCustomSkills(workspace, home);
			const names = skills.map((skill) => skill.name);
			expect(names).toEqual(["cursor-skill", "user-skill", "workspace-skill"]);

			const cursor = skills.find((skill) => skill.name === "cursor-skill");
			const user = skills.find((skill) => skill.name === "user-skill");
			const workspaceSkillLoaded = skills.find((skill) => skill.name === "workspace-skill");

			expect(cursor?.origin).toBe("cursor");
			expect(user?.origin).toBe("user");
			expect(workspaceSkillLoaded?.origin).toBe("workspace");
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});
