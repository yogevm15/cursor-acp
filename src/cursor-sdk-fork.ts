import type { LocalAgentCheckpointRef, LocalAgentDocument, LocalAgentStore } from "@cursor/sdk";
import { randomUUID } from "node:crypto";

export type ForkableLocalAgentStore = LocalAgentStore & { dispose?: () => Promise<void> };

export type OpenLocalAgentStore = (workspace: string) => Promise<ForkableLocalAgentStore>;

const PAGE_SIZE = 500;

/** Opens the store that the SDK uses by default for this workspace. */
export async function openDefaultLocalAgentStore(
	workspace: string,
): Promise<ForkableLocalAgentStore> {
	const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");
	return await SqliteLocalAgentStore.open({ workspaceRef: workspace });
}

/**
 * Copies a local SDK agent to a new agent ID: its conversation blobs and its record.
 * The SDK has no fork API, so this uses the public `LocalAgentStore` interface.
 * Returns `undefined` when the source agent is not in the store.
 */
export async function forkLocalAgent(options: {
	agentId: string;
	sourceWorkspace: string;
	workspace: string;
	openStore?: OpenLocalAgentStore;
}): Promise<string | undefined> {
	const openStore = options.openStore ?? openDefaultLocalAgentStore;
	const source = await openStore(options.sourceWorkspace);
	let target: ForkableLocalAgentStore = source;
	try {
		if (options.workspace !== options.sourceWorkspace) {
			target = await openStore(options.workspace);
		}

		const record = await source.agents.get({ agentId: options.agentId });
		if (!record) {
			return undefined;
		}

		const agentId = `agent-${randomUUID()}`;
		const latestCheckpoint = await lastFinishedCheckpoint(source, record);
		try {
			await copyCheckpointBlobs(source, target, record.agentId, agentId);
			const now = Date.now();
			await target.agents.create({
				agent: {
					...record,
					agentId,
					cwd: options.workspace,
					status: "idle",
					activeRunId: null,
					name: record.name ? `${record.name} (fork)` : record.name,
					createdAt: now,
					updatedAt: now,
					latestCheckpoint,
				},
			});
		} catch (error) {
			await target.checkpoints
				.delete({ filter: { agentIds: [agentId] } })
				.catch(() => undefined);
			throw error;
		}
		return agentId;
	} finally {
		await source.dispose?.();
		if (target !== source) {
			await target.dispose?.();
		}
	}
}

/**
 * The checkpoint of a running agent can hold a partial turn. Then the fork uses the
 * checkpoint of the last finished run.
 */
async function lastFinishedCheckpoint(
	store: LocalAgentStore,
	record: LocalAgentDocument,
): Promise<LocalAgentCheckpointRef | null> {
	if (record.status !== "running" && !record.activeRunId) {
		return record.latestCheckpoint ?? null;
	}

	let latest: { turnNumber: number; checkpoint: LocalAgentCheckpointRef } | undefined;
	let cursor: string | undefined;
	do {
		const page = await store.runs.list({
			filter: { agentIds: [record.agentId], cursor, limit: PAGE_SIZE },
		});
		for (const run of page.items) {
			if (
				run.status === "finished" &&
				run.latestCheckpointRef &&
				(!latest || run.turnNumber > latest.turnNumber)
			) {
				latest = { turnNumber: run.turnNumber, checkpoint: run.latestCheckpointRef };
			}
		}
		cursor = page.nextCursor;
	} while (cursor);
	return latest?.checkpoint ?? null;
}

async function copyCheckpointBlobs(
	source: LocalAgentStore,
	target: LocalAgentStore,
	sourceAgentId: string,
	agentId: string,
): Promise<void> {
	let cursor: string | undefined;
	do {
		const page = await source.checkpoints.list({
			filter: { agentIds: [sourceAgentId], cursor, limit: PAGE_SIZE },
		});
		for (const blobId of page.items) {
			const data = await source.checkpoints.get({ agentId: sourceAgentId, blobId });
			if (!data) {
				throw new Error(`Checkpoint blob ${blobId} of ${sourceAgentId} is missing`);
			}
			await target.checkpoints.create({ agentId, blobId, data });
		}
		cursor = page.nextCursor;
	} while (cursor);
}
