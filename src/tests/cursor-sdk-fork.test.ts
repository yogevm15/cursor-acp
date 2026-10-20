import { JsonlLocalAgentStore, type LocalAgentDocument } from "@cursor/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forkLocalAgent, type OpenLocalAgentStore } from "../cursor-sdk-fork.js";

const SOURCE_ID = "agent-11111111-1111-4111-8111-111111111111";

describe("forkLocalAgent", () => {
	let root: string;
	let stores: Map<string, JsonlLocalAgentStore>;
	let openStore: OpenLocalAgentStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "cursor-sdk-fork-"));
		stores = new Map();
		openStore = async (workspace) => {
			let store = stores.get(workspace);
			if (!store) {
				store = new JsonlLocalAgentStore(join(root, encodeURIComponent(workspace)));
				stores.set(workspace, store);
			}
			return store;
		};
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function seedSource(overrides: Partial<LocalAgentDocument> = {}) {
		const store = await openStore("/work/source");
		await store.checkpoints.create({
			agentId: SOURCE_ID,
			blobId: "blob-a",
			data: new Uint8Array([1, 2]),
		});
		await store.checkpoints.create({
			agentId: SOURCE_ID,
			blobId: "blob-b",
			data: new Uint8Array([3]),
		});
		await store.agents.create({
			agent: {
				agentId: SOURCE_ID,
				cwd: "/work/source",
				status: "idle",
				activeRunId: null,
				name: "Chat",
				createdAt: 1,
				updatedAt: 2,
				latestCheckpoint: { schemaVersion: 1, rootBlobId: "blob-b" },
				sdkMetadata: { blobEncryptionKey: "key" },
				...overrides,
			},
		});
		return store;
	}

	it("copies the blobs and the record to a new idle agent", async () => {
		const store = await seedSource();

		const forkId = await forkLocalAgent({
			agentId: SOURCE_ID,
			sourceWorkspace: "/work/source",
			workspace: "/work/source",
			openStore,
		});

		expect(forkId).toMatch(/^agent-[0-9a-f-]{36}$/);
		expect(forkId).not.toBe(SOURCE_ID);
		expect(await store.agents.get({ agentId: forkId! })).toMatchObject({
			cwd: "/work/source",
			status: "idle",
			activeRunId: null,
			name: "Chat (fork)",
			latestCheckpoint: { schemaVersion: 1, rootBlobId: "blob-b" },
			sdkMetadata: { blobEncryptionKey: "key" },
		});
		const blobs = await store.checkpoints.list({ filter: { agentIds: [forkId!] } });
		expect([...blobs.items].sort()).toEqual(["blob-a", "blob-b"]);
		const blob = await store.checkpoints.get({ agentId: forkId!, blobId: "blob-a" });
		expect(Array.from(blob ?? [])).toEqual([1, 2]);
	});

	it("writes the copy to the store of another workspace", async () => {
		await seedSource();

		const forkId = await forkLocalAgent({
			agentId: SOURCE_ID,
			sourceWorkspace: "/work/source",
			workspace: "/work/other",
			openStore,
		});

		const target = await openStore("/work/other");
		expect(await target.agents.get({ agentId: forkId! })).toMatchObject({ cwd: "/work/other" });
		const blobs = await target.checkpoints.list({ filter: { agentIds: [forkId!] } });
		expect(blobs.items).toHaveLength(2);
	});

	it("uses the last finished checkpoint when the source is running", async () => {
		const store = await seedSource({ status: "running", activeRunId: "run-3" });
		for (const [turnNumber, status, rootBlobId] of [
			[1, "finished", "blob-a"],
			[2, "finished", "blob-b"],
			[3, "running", "blob-c"],
		] as const) {
			await store.runs.create({
				run: {
					runId: `run-${turnNumber}`,
					agentId: SOURCE_ID,
					turnNumber,
					status,
					createdAt: turnNumber,
					updatedAt: turnNumber,
					latestCheckpointRef: { schemaVersion: 1, rootBlobId },
				},
			});
		}

		const forkId = await forkLocalAgent({
			agentId: SOURCE_ID,
			sourceWorkspace: "/work/source",
			workspace: "/work/source",
			openStore,
		});

		expect(await store.agents.get({ agentId: forkId! })).toMatchObject({
			status: "idle",
			latestCheckpoint: { schemaVersion: 1, rootBlobId: "blob-b" },
		});
	});

	it("returns undefined when the source agent is not in the store", async () => {
		await expect(
			forkLocalAgent({
				agentId: SOURCE_ID,
				sourceWorkspace: "/work/source",
				workspace: "/work/source",
				openStore,
			}),
		).resolves.toBeUndefined();
	});
});
