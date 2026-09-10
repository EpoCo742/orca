# ADR 0003: Worktree isolation, gates, and structured results

Date: 2026-09-10
Status: Accepted (M2)

## Worktrees

- One worktree per (run, owner node). An agent node with `isolation: worktree` owns one; any node with `worktreeOf: <owner>` runs inside it and creates it lazily if needed. Loop iterations reuse the owner's worktree, so a fix loop keeps working on the same branch.
- Location `<git toplevel>/<settings.worktree.dir>/<run8>-<owner>` (default `.orca/worktrees`), branch `orca/<workflow-slug>/<run8>/<owner>`, base `HEAD` of the main checkout (or `origin/HEAD` with `baseRef: default-branch`). The path is short on purpose (Windows path limits); `core.longpaths` is enabled per repo; `.orca/worktrees/` is added to `.git/info/exclude`.
- For a target that is a subdirectory of a larger repo, the worktree is created at the git toplevel and the node's cwd is the same subpath inside it.
- `settings.worktree.linkDirs` (e.g. `node_modules`) are junction/symlinked from the main checkout into the worktree; `settings.worktree.setupCommand` runs once after creation. This is how the sample repo runs vitest inside a worktree without a second install.
- Worktrees are locked while the run is active, recorded in the `worktrees` table (`active | kept | removed`), and removed by a `git worktree.remove` node or the Diff tab's discard button. No automatic sweep yet.

## Git node

`action.git` acts on another node's worktree: `diff` (intent-to-add so new files appear), `commit`, `push -u origin <branch>`, `pr.create` via `gh pr create --draft`, `worktree.remove`, `worktree.keep`. PR creation uses the `gh` CLI's own auth rather than a stored token.

## Gates

`control.gate` renders `show` items by evaluating expressions (markdown, text, json, diff) and creates an approval of kind `gate` through the same broker as tool permissions. Outputs `approved`/`rejected` trigger ports plus `decision`, `comment`, `decided_by`. Default timeout is 7 days.

## Structured results (Judge)

An agent node with `outputSchema` gets a `submit_result` custom tool (Copilot SDK `tools`, `skipPermission: true`). If the agent stops without calling it, `onAgentStop` blocks once with a reminder; a second miss fails the node with `schema_invalid`. The result lands on the `json` port, and `approve`, `score`, `verdict` are lifted to ports when present. No JSON Schema validation library is used yet; Copilot validates tool arguments against the schema on its side.

## Notifications

`notify` run events are broadcast over the WebSocket; the UI shows toasts and, when permitted, browser notifications. Gates emit a notify event automatically.
