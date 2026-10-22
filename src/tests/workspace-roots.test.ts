import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspaceRoots } from "../workspace-roots.js";

describe("resolveWorkspaceRoots", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-roots-"));
	});

	afterEach(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("adds child projects when the workspace is a plain folder of repositories", async () => {
		const workspace = path.join(tempRoot, "repos");
		await mkdir(path.join(workspace, "core", ".git"), { recursive: true });
		await mkdir(path.join(workspace, "ai", ".cursor", "rules"), { recursive: true });
		await mkdir(path.join(workspace, "infra", ".agents"), { recursive: true });
		await mkdir(path.join(workspace, "runner"), { recursive: true });
		await writeFile(path.join(workspace, "runner", "AGENTS.md"), "# Runner", "utf8");
		await mkdir(path.join(workspace, "notes"), { recursive: true });
		await mkdir(path.join(workspace, "node_modules", "dep", ".git"), { recursive: true });
		await mkdir(path.join(workspace, ".idea", ".git"), { recursive: true });

		expect(await resolveWorkspaceRoots(workspace, ["/extra", workspace])).toEqual([
			workspace,
			"/extra",
			path.join(workspace, "ai"),
			path.join(workspace, "core"),
			path.join(workspace, "infra"),
			path.join(workspace, "runner"),
		]);
	});

	it("does not add child projects inside a Git repository", async () => {
		const repo = path.join(tempRoot, "repo");
		await mkdir(path.join(repo, ".git"), { recursive: true });
		await mkdir(path.join(repo, "packages", "api", ".cursor"), { recursive: true });

		expect(await resolveWorkspaceRoots(repo)).toEqual([repo]);
		expect(await resolveWorkspaceRoots(path.join(repo, "packages"))).toEqual([
			path.join(repo, "packages"),
		]);
	});
});
