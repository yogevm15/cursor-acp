import type { McpServer } from "@agentclientprotocol/sdk";
import type { SDKImage } from "@cursor/sdk";
import type { CursorModelDescriptor } from "./slash-commands.js";

type Environment = Record<string, string | undefined>;

export type CursorPromptImage = Extract<SDKImage, { data: string }>;

export interface CursorStreamEvent {
	type: string;
	subtype?: string;
	[key: string]: unknown;
}

export interface RunPromptOptions {
	workspace: string;
	prompt: string;
	images?: CursorPromptImage[];
	backendSessionId?: string;
	modelId?: string;
	modeId?: "plan" | "ask";
	reviewPolicy?: "auto-review" | "run-everything";
	streamPartialOutput?: boolean;
	env?: Environment;
	modelCatalog?: CursorModelDescriptor[];
	thinkingLevel?: string;
	fastValue?: string;
	contextValue?: string;
	mcpServers?: McpServer[];
	onEvent?: (event: CursorStreamEvent) => Promise<void> | void;
}

export interface RunPromptResult {
	events: CursorStreamEvent[];
	resultEvent?: CursorStreamEvent;
	stderr: string;
	exitCode: number;
}

/** `revert_to_followup` means the running turn did not take the text; send it as a new turn. */
export type SteerOutcome = "complete_delivered" | "revert_to_followup";

export interface CursorPromptRun {
	completed: Promise<RunPromptResult>;
	cancel: () => void;
	/** Adds text to the running turn. Runners without steering omit this. */
	steer?: (text: string) => Promise<SteerOutcome>;
}

export interface ForkChatOptions {
	backendSessionId: string;
	/** Workspace of the source session. */
	sourceWorkspace: string;
	/** Workspace of the new session. */
	workspace: string;
}

export interface CursorRunner {
	listModels(): Promise<CursorModelDescriptor[]>;
	createChat(): Promise<string>;
	startPrompt(options: RunPromptOptions): CursorPromptRun;
	/**
	 * Copies a backend chat and returns the ID of the copy. Returns `undefined` when the
	 * source has no backend chat to copy. Runners that cannot copy chats omit this.
	 */
	forkChat?(options: ForkChatOptions): Promise<string | undefined>;
}
