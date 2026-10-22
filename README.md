# cursor-acp

> **Why does this exist?** Cursor published their own ACP client ([docs](https://cursor.com/docs/cli/acp#ide-integrations)), but using it in Zed was rough as I somehow had to permit tool calls the whole time.

Disclaimer: I am not affiliated with Cursor or Zed. This project is a personal experiment and should not be considered an official product of either company. I am a big fan of both products and wanted to combine what I like with both of them: An amazing editor and a great AI coding agent (and composer-1, holy this model flies xD).

An [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol/agent-client-protocol) adapter for the [Cursor SDK](https://cursor.com/docs/sdk/typescript), enabling Cursor's coding agent in [Zed](https://zed.dev) and other ACP-compatible clients.

## About

This is an `ai-assisted` personal project aimed at bringing Cursor's agent into Zed. Prompt execution uses `@cursor/sdk`; the adapter adds ACP session persistence, history replay, model and mode controls, and Zed-friendly configuration options.

**Based on [claude-code-acp](https://github.com/zed-industries/claude-code-acp)** by Zed Industries - the original ACP adapter for Claude Code that served as the architectural foundation for this project.

## Features

### Cursor SDK backend

- **Smart Auto Review by default**: New sessions create local SDK agents with `local.autoReview: true`. Cursor's classifier runs approved calls and fails closed on the rest.
- **ACP permission fallback**: A call stopped by Auto Review is surfaced to the client. “Allow once” retries that turn with Auto Review disabled; “Always allow” switches the session to Yolo.
- **Correct SDK mode lifecycle**: Auto Review is an agent-level SDK option. Switching review policy closes and resumes the same SDK agent with the new policy; the SDK's unrelated crash-recovery `force` flag is never used as an approval bypass.
- **Stable prompt lifecycle**: Standalone Cursor transport diagnostics fail the ACP turn instead of being treated as successful replies. Cancellation drains final SDK events and retires an unresponsive agent after a bounded wait.
- **Automatic retry for temporary failures**: When Cursor rate-limits a run or the connection drops, the adapter retries once a second, up to 30 times, and sends a notice when it starts retrying. Cancel stops the wait. If tools already ran, the retry asks the model to check the current state and continue instead of resending the prompt. Usage-limit, sign-in, and conversation-length errors are not retried. Each of these errors says what happened and whether earlier edits were kept, and the raw SDK error (code, request id, model) is logged to stderr.
- **Model parameters**: Canonical SDK model IDs, thinking/reasoning/effort levels, fast values, context window sizes, and variants flow into SDK model selections. The adapter keeps the catalog's original parameter ids.
- **Context window and token usage**: Models with an SDK `context` parameter (for example `272k` / `1m`) get a **Context** selector. After each turn, the adapter returns the turn's token counts in the ACP prompt response (`usage`) and sends a `usage_update` with the tokens in context and the window size.
- **Session cost**: After each turn, and when a session is resumed or loaded, the adapter reads the billed cost of each SDK agent of the session (`Agent.getUsage`) and sends the total in `usage_update.cost`. `amount` is the amount Cursor charged, in USD (0 for usage included in your plan). `_meta.rawCostUsd` is the undiscounted model token cost. Cursor reports cost some seconds after a turn, so the adapter reads it again 10 s and 30 s after the turn. If the model has no `context` parameter, the update has `size: 0` (window size unknown). Cursor makes this data available only on some accounts. On other accounts the SDK returns `feature_unavailable`, and the adapter sends no cost.
- **MCP and images**: ACP-provided stdio/HTTP/SSE MCP servers and image chunks are forwarded to the SDK.
- **Agent, Plan, and Ask**: Plan uses the SDK's `plan` send mode. Ask creates a no-tools SDK agent.

### Wrapper compatibility

- **ACP session lifecycle**: Supports `new`, `resume`, and `fork` session operations
- **Session persistence & history replay**: Stores visible history locally and replays it on resume, load, and fork. Resume and load continue the saved local SDK agent, so the model keeps the full earlier context. If that agent is not in the SDK store, the adapter starts a new agent and sends a notice.
- **Session fork**: `session/fork` copies the source session's local SDK agent (its conversation checkpoint and record) to a new agent, and copies the visible history and the mode, model, and parameter settings. If the source is in a turn, the fork starts from the last finished turn. If the agent cannot be copied, the first prompt of the fork carries the visible history (the newest 100,000 characters) and the adapter sends a notice. The SDK has no fork API, so the copy uses the SDK's public `LocalAgentStore` interface.
- **Session listing**: Lists past local sessions with optional cwd filtering and pagination
- **Model listing and selection**: `/model` and ACP config options use the SDK catalog.
- **ACP 1.4 controls**: Clients that advertise boolean config support receive Fast and on/off Thinking parameters as native toggles; older clients receive a select fallback. Multi-level thinking/reasoning/effort parameters remain selectors. After `session/set_config_option`, the adapter sends `config_option_update` so dependent Fast and Thinking controls appear immediately.
- **SDK authentication**: `/login`, `/logout`, `/status`, `CURSOR_API_KEY`, and ACP terminal authentication use Cursor SDK credentials. Browser login is stored under `~/.cursor/sdk/auth.json`.
- **Optional Yolo mode** (`yolo`): Disables Auto Review for unrestricted local SDK execution.
- **Commit and PR attribution**: Honors Cursor's global `cli-config.json` attribution flags. Project `.cursor/cli.json` does not override them.

### Known limitations

- Cursor SDK authentication is separate from `cursor-agent` CLI authentication. Run `/login`, `cursor-acp login`, or set `CURSOR_API_KEY`.
- The SDK exposes no interactive per-tool approval callback. ACP approval therefore retries the complete turn without Auto Review; work completed before the blocked call may be repeated.
- Auto Review reduces confirmation noise but is not a security boundary. Use sandboxing and normal least-privilege practices for untrusted workspaces.
- `debug` mode is not exposed.
- Context usage is an estimate. The SDK reports one token sum for all model calls in a turn, so for turns with tool calls the adapter estimates the size of the last call. For models that do not advertise a `context` parameter, the SDK does not report the window size. Thus `usage_update` is sent for them only to carry the session cost, with `size: 0`.

## Breaking changes (SDK backend and Auto Review default)

Version 0.9.0 moves prompt turns to `@cursor/sdk` instead of `cursor-agent --print`. SDK authentication is separate from Cursor CLI authentication, and **Auto Review is the shipped default for new sessions**.

### Configuration defaults

Use ACP `default_config_options` with Zed versions that support ACP config defaults. The adapter still accepts legacy inline defaults and reads `CURSOR_ACP_DEFAULT_MODE`, `CURSOR_ACP_DEFAULT_MODEL`, and `CURSOR_ACP_DEFAULT_THINKING` as fallbacks.

### Legacy Yolo mode name aliases removed

Older builds accepted `bypassPermissions` and `autoRunAllCommands` as synonyms for **`yolo`** in `default_mode` and in `/mode`. Those names are **no longer accepted**—use **`yolo`** (or pick **Yolo** in the client).

### Auto-review mode (`auto-review`)

- **What it is**: Cursor SDK Smart Auto Review, enabled with `local.autoReview: true` on local agents.
- **Default**: The adapter starts in `auto-review` unless the client or environment explicitly chooses another mode. Legacy `default` values normalize to `auto-review`.
- **Remaining prompts**: Calls the classifier stops are offered to the ACP client. Choosing “Always allow” upgrades the session to Yolo.
- **What it is not**: Not Yolo, Bugbot/PR review, or a sandbox/security boundary.

### Yolo mode (`yolo`)

- **What it does**: Creates/resumes the local SDK agent with Auto Review disabled. This is the SDK's headless “run everything” behavior.
- **Configuration**: Set `default_config_options.mode` to `yolo` or choose Yolo in the mode picker. Do not use removed aliases such as `bypassPermissions` or `autoRunAllCommands`.

The same notice is linked from [`docs/breaking-changes.md`](docs/breaking-changes.md).

## Slash Commands

| Command   | Description                            |
| --------- | -------------------------------------- |
| `/help`   | Show available commands                |
| `/model`  | Switch or display the current model    |
| `/mode`   | Switch or display the current mode     |
| `/status` | Show authentication and session status |
| `/login`  | Authenticate with Cursor               |
| `/logout` | Sign out of Cursor                     |

Project and user slash commands/skills discovered by the adapter are added to the ACP command list. Skills are found in every `.cursor/skills` and `.agents/skills` directory in the workspace, including nested ones (hidden directories and `node_modules` are skipped). A skill nearer to the workspace root overrides a nested skill with the same name.

## Installation

```bash
nub install
nub run build
```

This compiles the project and produces the `cursor-acp` binary entry point at `./dist/index.js`. `nub install` also runs a guarded postinstall patch so the pinned `@cursor/sdk` honors global commit and PR attribution settings. If Cursor changes that runtime code, installation fails instead of silently ignoring the settings.

### Adding to PATH

For Zed to find the `cursor-acp` command, it needs to be available on your PATH. Choose one of the following options:

**Option A — npm link (recommended)**

Run `npm link` inside the repository root to symlink the `cursor-acp` binary globally:

```bash
npm link
```

**Option B — manual symlink**

Create a symlink manually:

```bash
ln -s "$(pwd)/dist/index.js" /usr/local/bin/cursor-acp
```

Verify the binary is accessible:

```bash
which cursor-acp
```

## Usage

### Run directly

```bash
nub run start
```

Or use the binary:

```bash
cursor-acp
```

### Authenticate

Authenticate the Cursor SDK in a browser before starting a session:

```bash
cursor-acp login
```

Run `cursor-acp logout` to remove the stored SDK credential. If `CURSOR_API_KEY` is set, it remains active until removed from the adapter process environment.

### Configuring Zed

Open your Zed settings file via the Command Palette (`zed: open settings`) and add a custom agent server entry under `agent_servers`:

```json
{
  "agent_servers": {
    "Cursor": {
      "type": "custom",
      "command": "cursor-acp",
      "args": [],
      "default_config_options": {
        "mode": "auto-review",
        "fast": false
      }
    }
  }
}
```

If `cursor-acp` is not on your PATH, use the full absolute path to the entry point instead:

```json
{
  "agent_servers": {
    "Cursor": {
      "type": "custom",
      "command": "/absolute/path/to/cursor-acp/dist/index.js",
      "args": [],
      "default_config_options": {
        "mode": "auto-review",
        "fast": false
      }
    }
  }
}
```

#### Default mode, model, Fast, and Thinking

Zed versions with ACP config defaults apply initial controls from `default_config_options`; they may send these as follow-up `session/set_config_option` requests after creating the session. The adapter then sends a `config_option_update` so dependent Fast and Thinking controls appear immediately. When the client also advertises boolean config support, Fast and on/off Thinking parameters appear as native toggles in the agent panel:

```json
{
  "agent_servers": {
    "Cursor": {
      "type": "custom",
      "command": "cursor-acp",
      "args": [],
      "default_config_options": {
        "mode": "auto-review",
        "model": "composer-2.5",
        "fast": false,
        "thinking": "high",
        "context": "1m"
      }
    }
  }
}
```

- `mode` — one of `auto-review`, `yolo`, `plan`, or `ask`. Omit it to use the shipped `auto-review` default; legacy `default` values still work as an alias.
- `model` — optional canonical model ID from the Cursor SDK catalog.
- `fast` — boolean toggle when the selected model advertises a `fast` parameter.
- `thinking` — ACP config id for the selected model's `thinking`, `reasoning_effort`, `reasoning`, or `effort` parameter. When a model has both an on/off `thinking` parameter and an effort parameter, this control sets the effort, and the adapter keeps the model's default thinking switch. For on/off parameters, use `true` or `false`. Multi-level parameters use catalog values (for example `none` / `low` / `medium` / `high` / `xhigh` / `max`, or Effort `low` / `high`). The picker label also comes from the SDK catalog.
- `context` — maximum context window, when the selected model advertises a `context` parameter. Use a catalog value such as `200k`, `272k`, `300k`, or `1m`. Values the model does not offer fall back to the model default.

Legacy Zed fields (`default_mode`, `default_model`, `default_fast`, `default_thinking`, and `default_context`) remain accepted for compatibility. There is no adapter-specific config file. Environment fallbacks are `CURSOR_ACP_DEFAULT_MODE`, `CURSOR_ACP_DEFAULT_MODEL`, `CURSOR_ACP_DEFAULT_THINKING`, and `CURSOR_ACP_DEFAULT_CONTEXT`.

The mode picker lists **Auto-review**, **Yolo**, **Ask**, and **Plan**. Model-specific **Fast** and **Thinking** controls appear when the SDK catalog advertises `fast`, `thinking`, `reasoning_effort`, `reasoning`, or `effort` parameters. The ACP config id stays `thinking` even when the SDK parameter is `reasoning_effort`, `reasoning`, or `effort`; the picker label follows the catalog (for example **Effort**). Clients that advertise boolean config support receive parameters offering exactly `true` and `false` as toggles. Other clients receive select controls, and multi-level reasoning parameters remain selectors on all clients. A **Context** selector appears when the SDK catalog advertises a `context` parameter for the selected model. Models and parameter values that run only in Max Mode show a **(Max Mode)** label.

### Prompts during a running turn

When you send a prompt while a turn is running, the adapter adds the text to the running turn (Cursor SDK steering). If the running turn cannot take the text, for example because the prompt has images, the prompt waits and runs as the next turn. `session/cancel` also cancels waiting prompts. Set `CURSOR_ACP_STEERING=0` to reject prompts during a running turn instead.

JetBrains Air does not send a second `session/prompt` during a turn. It uses its own extension instead. The adapter declares `agentInfo._meta.steering.supported` in the `initialize` response, so Air enables **Send now** for queued messages. Air then sends `_session/steering` with `{ sessionId, prompt }`. If the running turn takes the text, the adapter answers `{ "outcome": "injected" }`. If not (no running turn, a slash command, images, or a turn that waits for approval), the adapter answers "method not found", and Air sends the message as the next turn.

### Client capabilities

- **Notices** — clients that advertise `clientCapabilities.session.notices` receive `notice` updates for warnings such as a missing saved session, an Auto-review stop, a backend restart, or a Cursor rate-limit retry.
- **Subagents** — clients that advertise `clientCapabilities.subagents` receive `subagent_update` and `session_message` updates for Cursor `task` tool calls. The tool call itself still appears in the parent session.

The adapter accepts a `session/new` or `session/load` request without `mcpServers`, and it ignores malformed `mcpServers` entries. The maximum size of one incoming ACP message is 256 MiB. Set `CURSOR_ACP_MAX_MESSAGE_BYTES` to change it.

### Using in Zed

1. Open the Agent Panel with `Cmd+?` (macOS) or `Ctrl+?` (Linux)
2. Click the `+` button in the top right and select **Cursor**
3. On first use, select the Cursor SDK login method or run `/login`
4. Auto Review is already the default. Choose **Yolo** only when you explicitly want unrestricted local tool execution.

You can also bind a keyboard shortcut to quickly open a new Cursor thread by adding the following to your `keymap.json` (open via `zed: open keymap file`):

```json
[
  {
    "bindings": {
      "cmd-alt-u": ["agent::NewExternalAgentThread", { "agent": "Cursor" }]
    }
  }
]
```

### Debugging

If something isn't working, open Zed's Command Palette and run `dev: open acp logs` to inspect the ACP messages being sent between Zed and cursor-acp.

Set `CURSOR_ACP_DEBUG_LOG=1` if you also want the adapter to write extra debug traces to `~/.cursor-acp/logs/debug.log`.

### Development

```bash
nub run dev
```

### Testing

```bash
nub run test           # Run tests in watch mode
nub run test:run       # Run tests once
```

### Linting & Formatting

```bash
nub run lint          # Check with Oxlint
nub run lint:fix      # Apply safe Oxlint fixes
nub run format        # Format with Oxfmt
nub run format:check  # Verify formatting without writing files
nub run check         # Run lint and format checks
```

Oxlint and Oxfmt use their repository-level configurations. Source indentation uses tabs rendered at a width of four spaces, as configured in `.oxfmtrc.json` and `.editorconfig`.

## Migration Notes

- See **Breaking changes (SDK backend and Auto Review default)** when upgrading from the CLI-backed adapter.
- Commit and PR attribution is read only from the global Cursor CLI config; project `.cursor/cli.json` attribution is ignored.
- `auto-review`, `yolo`, `ask`, and `plan` are the advertised modes
- `default`, `acceptEdits`, `agent`, and `autoReview` are accepted as compatibility aliases for **`auto-review`**. For Yolo, use **`yolo`**—`bypassPermissions` and `autoRunAllCommands` are no longer accepted (see **Legacy Yolo mode name aliases removed**)
- `debug` is not exposed
- SDK settings are loaded from Cursor's user and project setting sources. The project source loads rules, skills, and `AGENTS.md` from the workspace, and it also enables project MCP servers and hooks in `.cursor/`.
- Workspace roots: the session `cwd`, the ACP `additionalDirectories`, and, when `cwd` is not inside a Git repository, each direct subfolder that is a Git repository or has `.cursor`, `.agents`, or `AGENTS.md`. The SDK treats rules in a subfolder of `cwd` as nested rules: they apply when the agent works with files in that subfolder. To apply a rule in all chats, put it in `<cwd>/.cursor/rules/` (a symlink to a folder inside the workspace also works).

## Project Structure

```
src/
├── index.ts              # CLI entry point
├── lib.ts                # Library exports
├── cursor-acp-agent.ts   # ACP lifecycle, persistence, and permissions
├── cursor-runner.ts      # Prompt execution interface
├── cursor-sdk-runner.ts  # Cursor SDK implementation
├── model-id.ts           # SDK model ids, thinking/reasoning/effort, fast, and context variants
├── context-usage.ts      # Turn token usage and context window estimates
├── cursor-cli-config.ts  # Global CLI attribution and config paths
├── cursor-sdk-event-adapter.ts # SDK-to-ACP event compatibility
├── prompt-conversion.ts  # ACP text, context, and image conversion
├── auth.ts               # Cursor SDK authentication
├── settings.ts           # Mode ids and normalization helpers
├── session-storage.ts    # Session persistence and history replay
├── slash-commands.ts     # Slash command handlers
├── tools.ts              # Tool definitions
├── utils.ts              # Utility functions
└── tests/                # Test files
scripts/
└── patch-cursor-sdk-attribution.mjs  # Postinstall SDK attribution patch
```

## Configuration

The adapter uses local Cursor SDK agents and keeps wrapper-level compatibility logic for ACP resume, list, and visible-history replay.

### Commit and PR attribution

cursor-acp honors Cursor's [global CLI attribution settings](https://cursor.com/docs/cli/reference/configuration#optional-fields). Defaults match the SDK: both commit trailers and PR attribution are enabled. To disable them, put this in `~/.cursor/cli-config.json` (or `$CURSOR_CONFIG_DIR/cli-config.json`):

```json
{
  "attribution": {
    "attributeCommitsToAgent": false,
    "attributePRsToAgent": false
  }
}
```

Attribution is global-only; Cursor project `.cursor/cli.json` files support permissions, not attribution.

### Session Storage

Sessions are persisted under `~/.cursor-acp/sessions/` (or `$CURSOR_ACP_CONFIG_DIR/sessions/` if set). Each project has an encoded subdirectory; session history is stored as JSONL files with user and assistant messages for resume and replay.

## Requirements

- [Zed](https://zed.dev)
- Node.js 22.13+ (required by the SDK's default local SQLite store)
- [Nub](https://nubjs.com/docs) (for package management and scripts)
- Valid Cursor subscription

## Acknowledgments

This project is based on [claude-code-acp](https://github.com/zed-industries/claude-code-acp) by Zed Industries. Their work on the original Claude Code ACP adapter provided the architectural patterns and protocol implementation that made this project possible.

Transport-failure detection and prompt-cancellation lifecycle hardening are adapted from [T3 Code](https://github.com/pingdotgg/t3code). See [NOTICE](NOTICE) for attribution.

## License

Copyright 2026 Raphael Lüthy. Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full license text. Third-party attributions are listed in [NOTICE](NOTICE).
