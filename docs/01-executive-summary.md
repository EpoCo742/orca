# Orca: Visual Orchestration for Coding Agents

Executive Summary
Date: 2026-09-10
Working title: **Orca** (placeholder; rename freely)

---

## 1. The idea in one paragraph

Orca is a local-first desktop application that lets a developer draw a development workflow on a canvas and run it with real coding agents. Each box on the canvas is a full agent session (it can read and edit files, run the shell, use git, call MCP servers such as GitHub or Jira) or a deterministic step (run tests, evaluate a condition, wait for a human approval, fan out over a list, loop until a check passes). Arrows carry data between boxes. Runs are durable: every step's output is recorded, so a run can be paused at an approval gate, resumed after a crash, or replayed with one step changed. Workflow definitions live in the repository as JSON files, so they are versioned and shareable like code.

## 2. Why this is worth building

Developers are already running several coding agents at once. The tooling has split into two camps that do not talk to each other:

- **Visual agent builders** (Langflow, Flowise, Dify, n8n, Sim Studio) have great canvases with loops, conditions, and human-in-the-loop nodes, but their "agent" is a chat model with a few tools. They do not know what a repository, a worktree, a test suite, or a pull request is.
- **Coding-agent orchestrators** (Vibe Kanban, Conductor, Agent Orchestrator, Bernstein, Claude Squad, Microsoft Conductor) know all of that and isolate agents in git worktrees, but they coordinate through kanban boards, task queues, YAML, or tmux. A 2026 survey of nine open-source orchestrators found **none** offer a node graph for visually chaining agents.

Anthropic's own answer, Claude Code **dynamic workflows**, proves the execution model we want (scripts that fan out to dozens of subagents, memoize results, and resume) but it is authored as JavaScript by Claude, not drawn by a developer. GitHub's new Copilot **Canvases** prove that teams want agent work laid out on a durable, steerable surface with explicit approval checkpoints.

The gap is specific and real: **a canvas whose primitive is a full coding agent in an isolated worktree, with loops, gates, and fan-out, producing durable and reviewable runs.** Orca fills it.

## 3. Who uses it and how

Primary user: an individual developer or small team that already uses Claude Code (or another CLI agent) and wants to turn repeated multi-step agent sessions into something they can draw once, run many times, and trust.

Representative workflows (all ship as starter templates):

| Template | Shape | What it saves the developer |
|---|---|---|
| Issue to PR | Poll Jira/GitHub -> Planner (read-only) -> Approve plan -> Implementer in worktree -> Tests -> Loop until green (max 3) -> Reviewer -> Approve -> Open PR -> Comment on issue | The whole "babysit the agent for an hour" loop, with two explicit checkpoints |
| Fix until green | Run tests -> if failing, Agent fixes -> repeat up to N | Re-prompting after each failure |
| Parallel review | Changed files -> one read-only reviewer per file -> Judge merges and ranks findings | Review fatigue and single-reviewer blind spots |
| Migration fan-out | Discover files -> N agents, each in its own worktree -> Verifier -> PRs per slice | Merge conflicts and manual batching |
| Tournament | Same task to 3 agents with different prompts or models -> Judge selects -> Approve -> apply | Guessing which prompt or model works |
| Nightly hygiene | Schedule -> dependency audit -> flaky-test hunt loop -> Notify | Forgetting to do it |

Usage pattern observed in every comparable tool: author once, run with gates until trusted, then loosen permissions and trigger on schedule or event.

## 4. What exists, and what Orca borrows from each

| Source | What we take |
|---|---|
| Claude Agent SDK | The agent node itself: built-in file/shell/search tools, subagents, hooks, MCP, permission modes, `canUseTool` approval callback, sessions (resume and fork), structured JSON output, turn and dollar budgets, file checkpointing |
| Claude Code dynamic workflows | Execution semantics: memoize each agent's result, replay on resume, hard caps on concurrency and total agents, forbid nondeterminism in orchestration code |
| LangGraph, Temporal, Inngest, Mastra | Durable execution: event-sourced run log, checkpoint per step, suspend and resume at human interrupts |
| Langflow, Flowise, Sim Studio | Canvas ergonomics: typed ports, condition and loop nodes, human-in-the-loop node, run trace overlaid on the graph |
| Vibe Kanban, Conductor, Agent Orchestrator | Git worktree per agent, diff review before merge, per-agent cost display |
| GitHub Canvases | Phases and explicit approval gates as first-class objects |
| Official GitHub and Atlassian MCP servers | The integrations the user asked for, without writing API clients |

## 5. Feasibility

Feasible. The differentiated core is buildable on proven parts.

| Area | Risk | Mitigation |
|---|---|---|
| Canvas | Low | React Flow (xyflow), the library behind most visual builders |
| Agent node | Low | Claude Agent SDK (TypeScript) exposes every control we need |
| Isolation | Low to medium | git worktrees; Claude Code enforces worktree isolation itself, including Windows-specific handling |
| Durable runs | Medium | Event-sourced SQLite log and memoized node outputs, designed in from the first milestone |
| Runaway loops and cost | Medium | Mandatory per-node turn and dollar caps, per-run budget, iteration caps, live cost display |
| MCP OAuth (Atlassian) | Medium | The SDK does not run OAuth; v1 uses a stdio bridge that does, v2 implements OAuth 2.1 natively |
| Other agent CLIs (Codex, Gemini, Aider) | Medium | Adapter interface; only Claude is first class in v1 |
| Deployed version | Deferred | The engine is a headless service from day one; the desktop shell is thin |

Two constraints to know about up front:

- **Authentication.** The owner's organization uses GitHub Copilot, so v1's primary agent runtime is the **GitHub Copilot SDK**, which authenticates with GitHub identities, consumes Copilot seats, and obeys org policies; a GitHub App provides seat-less, org-billed auth for a deployed version. The Claude Agent SDK adapter is secondary: Anthropic's terms require API key authentication for third-party products (no claude.ai login), and branding rules allow "Claude Agent" or "Powered by Claude" but not "Claude Code".
- **Cost.** Every agent node is a full Claude Code session. A single implementer session on Claude Opus 5 typically costs tens of cents to a few dollars; a fan-out of ten agents in a loop can reach tens of dollars per run. Orca treats budgets as required configuration, not an option.

## 6. Recommended feature set

### v1 (the product)

**Canvas and authoring**
- Drag-and-drop nodes, typed input and output ports, connection validation, undo/redo, auto-layout, zoom to fit, keyboard shortcuts.
- Node palette: Manual trigger, Schedule trigger, Claude Agent, Judge (agent with JSON schema output), Shell, Git (worktree, commit, branch, PR), Condition, Loop (container with "until" condition and max iterations), Map (fan-out with concurrency), Join, Transform (sandboxed JavaScript), MCP Tool call (deterministic, no model), Approval Gate, Notify, Sub-workflow.
- Inspector panel per node: prompt with template variables, model, effort, tools allow/deny, permission mode, MCP servers, skills and instruction sources, subagents, structured output schema, turn and dollar caps, worktree isolation, retry policy.
- Workflow-level settings: target repository, default model, run budget, concurrency limit, secrets references.
- Definitions saved as JSON in `.orca/workflows/` inside the repo; validated against a versioned schema.

**Execution**
- Durable engine with event-sourced run log (SQLite), memoized node outputs, pause, resume, cancel, and replay-from-node.
- Live run view overlaid on the canvas: status per node, streaming transcript, tool calls, cost, elapsed time.
- Approval gates that persist across app restarts; permission prompts from agents routed to the UI with timeouts and default policies.
- Git worktree per agent node (opt-in per node, default on for writers), diff viewer, one-click keep or discard.
- Per-node and per-run cost accounting; budgets enforced by the SDK (`maxBudgetUsd`, `maxTurns`) and by the engine.

**Integration**
- MCP presets: GitHub (remote, token), Atlassian (remote, OAuth via bridge), filesystem, Playwright; arbitrary stdio/HTTP servers.
- Secrets in the OS keychain, referenced by name; never written to workflow files.
- Loads the project's `CLAUDE.md`, `.claude/agents`, skills, and `.mcp.json` when the node opts in.

**Packaging**
- Windows, macOS, Linux desktop app (Electron) bundling a local engine; a CLI (`orca run <workflow>`) for CI and scripts.

### v2 (expansion)
- Webhook and repository-event triggers; Jira and GitHub issue watchers.
- Additional agent adapters (Codex CLI, Gemini CLI, Aider) through the same interface.
- Native OAuth 2.1 for remote MCP servers.
- Export a workflow as a Claude Code dynamic-workflow script (`.claude/workflows/*.js`) for users who want to run without Orca.
- Evaluation harness: run a workflow N times, compare outputs, track pass rate and cost.
- Headless engine deployment (Docker), multi-user auth, shared run history, per-run sandboxed containers.

### Explicitly out of scope for v1
- Chat-style RAG apps, embeddings, vector stores (Langflow and Dify do this well).
- Non-developer end-user apps.
- Cloud hosting.

## 7. Recommended architecture in brief

- **TypeScript monorepo**, one language across UI, engine, and desktop shell, matching the Agent SDK.
- **Engine**: a headless Node service exposing REST and WebSocket APIs; owns scheduling, durability, worktrees, agent adapters, secrets. Runs as a child process of the desktop app today and as a container tomorrow.
- **UI**: React + React Flow web app, talks only to the engine API, so the same UI serves desktop and deployed modes.
- **Desktop shell**: Electron, spawns the engine, provides the OS keychain, file dialogs, notifications.
- **Storage**: workflow definitions in the repo (JSON); runs, events, and transcripts in SQLite under the user's data directory.
- **Agent runtime**: Claude Agent SDK as the primary adapter; Claude Code CLI (`claude -p --output-format stream-json`) as the secondary adapter; adapter interface for others.

Details are in `02-architecture.md`; the build-ready specification is in `03-technical-spec.md`.

## 8. Risks and how the plan addresses them

| Risk | Consequence | Plan |
|---|---|---|
| Agents produce more code than the developer can review (METR 2025: 19 percent slower with unreviewed AI output) | Tool creates work instead of saving it | Gates, diffs, and test evidence are first-class; templates default to at least one human gate before anything leaves a worktree |
| Agent SDK API churn (currently 0.3.x with frequent releases) | Breakage on upgrade | Thin adapter layer, pinned version, contract tests against the installed type definitions |
| Loop with a judgment-based exit never terminates | Burned budget | Iteration caps are mandatory; dollar and turn caps per node; run-level budget; kill switch in UI |
| Worktrees on Windows (long paths, junctions, locked files) | Confusing failures | Use Claude Code's own worktree behaviors where possible, enable `core.longpaths`, keep worktrees short-pathed under `.orca/worktrees` |
| OAuth for remote MCP servers | Atlassian integration blocked | stdio bridge in v1 (proven), native PKCE flow in v2 |
| Over-scoping into a general automation platform | Never ships | v1 scope is developer workflows on a repository; everything else is a node type someone can add later |

## 9. Recommendation

Build it, in the order below, with a usable product at the end of each milestone:

1. Canvas, schema, validation, and a deterministic engine (Shell, Condition, Loop, Transform) with manual runs. No model calls yet. Proves the durable-run core.
2. Claude Agent node through the Agent SDK: streaming transcript, permission prompts in the UI, budgets, structured output.
3. Worktrees, Git nodes, diff viewer, Approval Gate. Ship the "Fix until green" and "Issue to PR" templates.
4. Map and Join, MCP presets (GitHub, Atlassian), secrets, Judge node. Ship "Parallel review" and "Tournament".
5. Resume after crash, replay-from-node, schedule triggers, CLI, packaging for all three desktop platforms.

Estimated effort for a single experienced developer working with an AI coding agent: the five milestones are roughly one to two weeks each, about two to three months to a polished v1. The technical spec is written so the build can start immediately.

## 10. Open decisions for the owner

- **Name.** "Orca" is a placeholder.
- **License.** MIT or Apache-2.0 recommended if open source is intended; the Agent SDK itself is governed by Anthropic's commercial terms.
- **Default model tier.** Spec defaults agent nodes to Claude Opus 5 with effort `high`, judges and readers to Claude Sonnet 5, classifiers to Claude Haiku 4.5. Change if budget dictates.
- **Secondary adapter priority.** Whether the Claude Code CLI adapter ships in v1 (recommended, low cost) or waits.
