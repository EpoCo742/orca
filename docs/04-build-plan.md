# Orca Build Plan

Date: 2026-09-10
Status: Agreed with the owner. Supersedes the milestone list in `03-technical-spec.md` section 12.

## 1. Decisions that shape this plan

| Decision | Choice | Consequence |
|---|---|---|
| Agent runtime for v1 | **GitHub Copilot SDK** (`@github/copilot-sdk`) first | Uses the org's Copilot seats and policies; no Anthropic key needed. Claude Agent SDK adapter is deferred to M4 and optional |
| UI delivery | **Browser UI + local engine** (`orca dev`, open localhost) | No Electron until M5; secrets use an encrypted file until the keychain arrives |
| First runnable milestone | **Vertical slice with a real agent** | M1 includes canvas, engine, Copilot agent node, Shell, Loop, approvals, and the "fix until green" template, all working end to end |
| Test target | **Sample repo inside this monorepo** (`examples/sample-target`) | Tiny Node project with a deliberately failing test; repeatable and safe |
| Repo | **Private GitHub repo `EpoCo742/orca`, MIT** | Local folder stays `C:\source\agent-orch` |
| Work mode | **One milestone per check-in** | I build a whole milestone, commit as I go, stop and demo before the next |
| Name | **Orca** | CLI `orca`, packages `@orca/*`, config dir `.orca/`, env prefix `ORCA_` |

## 2. Environment facts (checked 2026-09-10)

- Node v24.20.0, pnpm 10.34.5, git 2.55, gh 2.98 installed. Claude Code 2.1.267 installed (useful later for the optional Claude CLI adapter).
- `gh` is logged in as `EpoCo742` with a **classic `ghp_` token**. The Copilot SDK rejects classic PATs, so Copilot auth will come from `copilot login` (bundled CLI) or a refreshed `gh auth login` OAuth token, not from the current credential.
- No `ANTHROPIC_API_KEY`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` in the environment.
- `@github/copilot-sdk` latest 1.0.13; engines `^20.19.0 || >=22.12.0`; bundles `@github/copilot-sdk-<platform>` runtime; `COPILOT_CLI_PATH` overrides. `@github/copilot` CLI latest 1.0.83.

## 3. Owner actions needed (the only things I cannot do myself)

| When | Action | Why |
|---|---|---|
| M0 (done 2026-09-10) | Copilot login via `pnpm orca auth login` (browser OAuth + GitHub Mobile sudo confirmation) | Establishes the OAuth token the SDK reuses; signed in as EpoCo742 |
| M0 (done) | Copilot CLI policy: confirmed working; 15 models allowed incl. `claude-sonnet-5` and `claude-haiku-4.5`, **no Claude Opus** | Default agent model for the Copilot adapter is `claude-sonnet-5` |
| M2 | Provide a GitHub fine-grained PAT (or approve using the `gh` OAuth token) for the GitHub MCP server and `gh pr create` | Issue-to-PR template |
| M3, optional | Atlassian site URL if you want the Jira preset exercised | Atlassian preset |
| M4, optional | `ANTHROPIC_API_KEY` if you want the Claude Agent SDK adapter built and tested | Otherwise that adapter stays stubbed |

## 4. Milestones

Each milestone ends with: all tests green, a tagged commit, a short demo script in `docs/demos/`, and a check-in.

### M0 Scaffold and Copilot spike (target: 1 to 2 days)

Deliverables
- pnpm workspace: `packages/shared`, `packages/engine`, `packages/ui`, `packages/cli`; root scripts `dev`, `build`, `test`, `lint`, `typecheck`.
- `examples/sample-target`: Node project (vitest) with one failing test and a `npm test` script.
- `orca dev` starts engine (Hono on 127.0.0.1, random token) and Vite UI, opens the browser with the token.
- Copilot spike script `packages/engine/src/adapters/copilot/spike.ts`: `CopilotClient` start, `listModels()`, one `createSession` with `onPermissionRequest`, `sendAndWait("say hello")`, print events. Records the real event and permission-request shapes into `docs/decisions/0002-copilot-sdk-contract.md`.
- `orca auth login` / `orca auth status` commands wrapping the bundled CLI login and `listModels()`.
- ADRs 0001 (naming and stack), 0002 (Copilot SDK contract as observed).

Acceptance
- `pnpm -r build && pnpm -r test && pnpm -r typecheck` green on Windows. **Met 2026-09-10.**
- Spike prints the model list and a completed assistant message using the owner's Copilot seat. **Met 2026-09-10** (claude-sonnet-5, one shell tool call with permission prompt, 2 premium requests, 4.6 s). Observations recorded in ADR 0002.

### M1 Vertical slice: "fix until green" (target: 1.5 to 2 weeks)

Deliverables
- `shared`: workflow document schema, node schemas for `trigger.manual`, `agent.copilot`, `action.shell`, `control.condition`, `control.loop`, `data.transform`; compiler with the validations in spec 2.7 (subset for these nodes); event and API types.
- `engine`: SQLite run log (spec 3.2), scheduler (spec 3.4) for linear, conditional, and Loop scopes; executors for the six nodes; QuickJS expression engine; permission broker; WebSocket fan-out; `CopilotAdapter` implementing spec 7B (prompt, system message append, model, MCP servers, tools allow/deny via permission handler, hooks for audit and hard-deny, transcript capture, turn and wall-clock caps, session id capture).
- `ui`: canvas with palette, inspector (schema-driven, CodeMirror prompt editor with `{{ }}` completion), edges with type validation, Loop container; Run mode with node status, live transcript panel, approvals queue; run history list.
- Template `fix-until-green.workflow.json` targeting `examples/sample-target`.
- Crash-resume: engine restart re-dispatches in-flight nodes, memoized nodes not re-run.

Acceptance
- From the UI: open the template, run it, watch the Shell node fail, the Copilot agent edit the sample repo, the Shell node pass, the Loop exit with `exited_by: until`. Total iterations shown.
- A shell command outside the allow list produces an approval prompt in the UI; Deny is honored and visible in the transcript.
- Kill the engine mid-run, restart, run resumes and completes.
- Contract tests with `FakeAdapter` cover success, max-turn cap, denied tool, adapter crash.

### M2 Isolation and review: "issue to PR" (target: 1.5 weeks)

Deliverables
- Worktree manager (spec 3.7) with Windows long-path handling; `isolation: worktree` on agent nodes; Shell `useUpstreamWorktree`.
- `action.git` ops: diff, commit, push, pr.create via `gh`; `control.gate` with markdown, JSON, and diff renderers; `action.notify` (browser notification + webhook); `agent.judge` via `submit_result` tool with zod schema -> `json` port.
- Diff viewer in the node panel; keep/discard worktree controls.
- GitHub MCP server configured for the agent node via the Copilot CLI's built-in GitHub MCP or explicit config with a token secret.
- Template `issue-to-pr.workflow.json`.

Acceptance
- Issue-to-PR runs against `examples/sample-target` on a branch: planner (read-only) -> gate shows plan -> implementer in worktree -> tests in that worktree -> loop (max 3) -> judge -> gate shows diff and findings -> commit -> draft PR created with `gh`. Rejecting at the diff gate removes the worktree and branch.

### M3 Scale-out and integrations (target: 1.5 weeks)

Deliverables
- `control.map` (concurrency, per-item worktrees), `control.join`, `workflow.sub`, `action.mcp_tool` (direct MCP client, no model).
- Secrets provider (encrypted file, `ORCA_MASTER_KEY`), `${SECRET:name}` substitution, redactor; secrets UI (names only).
- MCP presets: GitHub, Atlassian (via OAuth bridge), filesystem, Playwright; `POST /mcp/inspect` for tool autocomplete.
- Cost display: premium-request count per node and run for Copilot; USD for future adapters (cost unit abstraction).
- Templates `parallel-review`, `tournament`, `migration-fanout`.

Acceptance
- Parallel review runs one judge per changed file with concurrency 4 and merges findings; no secret value appears in any log, event, or transcript (automated check).

### M4 Hardening, CLI, optional Claude adapter (target: 1 week)

Deliverables
- Replay-from-node; `trigger.schedule` with croner; retention sweeps for runs and worktrees; `orca run`, `orca resume`, `orca validate` for CI with `--approve-gates`/auto-deny semantics.
- `ClaudeSdkAdapter` per spec 7 if an Anthropic key is provided; otherwise compiled but marked unavailable in the UI.
- Template `nightly-hygiene`.

Acceptance
- `orca run templates/fix-until-green.workflow.json --wait` exits 0 from PowerShell with no UI open. Schedule fires while `orca dev` is running.

### M5 Desktop packaging (target: 1 week)

Deliverables
- `packages/desktop` Electron shell: spawns engine, keychain secrets via `safeStorage`, native notifications, installers (nsis, dmg, AppImage) via electron-builder and GitHub Actions.

Acceptance
- Windows installer produced by CI; app launches, runs the fix-until-green template.

### v2 backlog (not scheduled)

`agent.copilot_cloud` node using `POST /agents/repos/{owner}/{repo}/tasks`; GitHub App server-to-server auth for unattended deployed runs; webhook triggers; native OAuth 2.1 for remote MCP; Codex and Gemini CLI adapters; export to Claude Code workflow scripts; evaluation harness; headless Docker deployment with Postgres.

## 5. Repository conventions

- Branch `main` protected by convention; I work on `main` directly during M0 and M1 (solo), feature branches from M2 on.
- Commits: conventional commits, one logical change each, attribution trailer per session rules.
- Tags: `m0`, `m1`, ... at each milestone check-in.
- Docs: ADRs in `docs/decisions/`, demo scripts in `docs/demos/`, this plan updated when scope changes.

## 6. Risks specific to this plan and how I will handle them

| Risk | Handling |
|---|---|
| Copilot SDK login on Windows through the bundled CLI behaves differently from docs | M0 spike resolves it before anything depends on it; fallback is `gh auth login` with the `copilot` scope if required |
| Org policy blocks Copilot CLI or restricts models | Surface the exact policy error in `orca auth status`; owner escalates to admin |
| No USD cost from Copilot | Count premium requests (one per user turn) and tool calls; show both; make budgets turn-based for this adapter |
| No structured output in Copilot SDK | `submit_result` tool with zod schema, with a one-retry nudge if the agent finishes without calling it |
| MCP tool naming differs (`<server>-<tool>` in Copilot vs `mcp__server__tool` in Claude) | Adapter normalizes to Orca's canonical `mcp:<server>/<tool>` in the UI and maps per adapter |
| Electron deferred means secrets are file-encrypted in M1 to M4 | Acceptable for local development; documented; keychain in M5 |
