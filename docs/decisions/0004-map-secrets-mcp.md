# ADR 0004: Map fan-out, secrets, and direct MCP

Date: 2026-09-10
Status: Accepted (M3)

## Map

- `control.map` is a container like Loop. `items` is an expression returning an array (cap 4096). Each item runs the body in scope `map[i]` with `item` and `index` in the expression context. The scheduler starts new items only while fewer than `concurrency` items are in progress; a node already dispatched counts as in progress even before its `node.started` event lands.
- Item failures do not fail the run; they appear as `{ error, node }` entries in `results` (`continueOnError`, default true). With it off, the map node fails once every item settles; `failFast` additionally aborts running items and skips pending ones.
- Agent nodes in a map body with `isolation: worktree` get one worktree per item; the owner key is `<node>-<index>`. Git nodes outside the map address them by that key, and `target` is a template so `implement-{{ nodes.judge.json.winner }}` works.
- Loop and Map cannot nest yet (compiler error).

## Join

`control.join` with `mode: all` is ready only when every incoming edge is live; `any` when at least one is. Outputs `merged` keyed by source node id. Ordinary nodes keep the M1 rule (all sources settled, any live).

## Sub-workflow

`workflow.sub` starts a child run (parent id recorded on the run row), renders its `inputs` as templates, waits, and returns the child's top-level completed outputs. Cancelling the parent cancels the child. Self-reference is rejected.

## Secrets

- Names are UPPER_SNAKE_CASE. Stored AES-256-GCM in `<dataDir>/secrets.enc.json`; key from `ORCA_MASTER_KEY` (64 hex) or a generated `<dataDir>/master.key`. In-memory provider for tests and `:memory:` databases.
- `${SECRET:NAME}` is resolved only at the moment of use (MCP server env/headers, MCP tool args, agent MCP configs); never in the expression sandbox, never in templates.
- A `Redactor` holds every secret value (length >= 4) and rewrites every persisted run event and transcript row, so even an agent that echoes a secret cannot get it into the run log.
- The API returns names only.

## MCP

- Workflow settings carry named servers (`stdio`, `http`, `sse`). Agent nodes attach servers by name; the Copilot adapter forwards them as session `mcpServers`. Permission rules for their tools use `Mcp(<server>/<tool-glob>)`.
- `action.mcp_tool` uses `@modelcontextprotocol/sdk` directly (one connection per call). On Windows, `npx`/`npm` stdio commands are launched through `cmd /c` because they are `.cmd` shims.
- Presets: GitHub remote (PAT header), Atlassian via `mcp-remote` OAuth bridge, filesystem, Playwright. `POST /mcp/inspect` connects and lists tools for the inspector.
