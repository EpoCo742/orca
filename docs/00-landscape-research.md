# Landscape Research: Visual Orchestration of AI Agents for Developer Workflows

Date: 2026-09-10
Status: Research complete. Feeds the executive summary, architecture, and technical spec.

## 1. What the user wants, restated

A local-first desktop application where a developer drops **agent processes** onto a canvas, wires them into graphs (chains, fan-out, loops, gates), and runs them to automate development and testing cycles. Agents must be controllable (instructions, skills, tools, MCP servers such as Git/GitHub and Atlassian), and the design should leave room for a deployed, multi-user version later.

This sits at the intersection of three existing product categories, none of which fully covers it.

## 2. The three categories that exist today

### 2.1 Visual LLM-app builders (canvas-first, chat/RAG-centric)

| Tool | Canvas model | Agent depth | MCP | License | Where it falls short for dev workflows |
|---|---|---|---|---|---|
| Langflow (DataStax / IBM) | Python LangChain canvas, 140k+ stars | Tool-calling agents, RAG, sequential/conditional | Yes; can publish flows as MCP servers | MIT | No native human-in-the-loop, no observability, no filesystem/git/worktree primitives, Python-only backend |
| Flowise (acquired by Workday) | LangChain.js canvas; Agent, Tool, Condition, Loop, Human-in-the-loop nodes | Multi-agent "AgentFlow V2" | Custom MCP Tool node | Apache 2.0 | Chat-centric; no coding-agent runtime, no repo isolation; acquisition raises OSS concerns |
| Dify | Visual workflow + chat app platform, 150k+ stars | Agent nodes, RAG pipelines | Yes | Apache-2.0 with conditions | Chat/RAG product surface; not built around code, tests, or git |
| n8n | 400+ integration workflow automation with AI Agent nodes | Agent as one step | Yes | Sustainable Use (fair-code, not OSS) | General automation, not agents with a repo; license blocks commercial embedding |
| Sim Studio | Figma-like typed canvas; sequential/parallel/conditional/loop; AI copilot | Agent nodes with 80+ integrations | Native | Apache 2.0 | Young; workflow-centric, no eval framework; no coding-agent runtime |
| Rivet (Ironclad) | Desktop node editor for prompt graphs; YAML graphs; remote debugger; TypeScript runtime library | Prompt chains | Partial | MIT | Prompt-graph tool, not a coding-agent orchestrator |
| LangGraph Studio | Graph **visualizer and debugger** for code-defined LangGraph graphs; v2 is browser-based | Full stateful agents, checkpoints, HITL, time travel | Via code | Platform pricing for hosted | Not an authoring canvas: the graph is defined in code; the Studio visualizes and steps through it |

Takeaway: these tools prove the canvas UX (nodes, typed ports, loops, HITL gates, run traces) and prove demand. None treats "a full coding agent with shell, files, git and MCP, running in an isolated worktree" as the node primitive.

### 2.2 Coding-agent orchestrators (repo-first, no canvas)

Surveyed in Augment Code's 2026 review of open-source orchestrators and multiple "best tools" roundups.

| Tool | UI model | Isolation | Agents supported | License | Notes |
|---|---|---|---|---|---|
| Agent Orchestrator | Desktop app + daemon | git worktrees, one PR per agent | 26 harnesses (Claude Code, Codex, Aider, Cursor, Copilot, ...) | Apache-2.0 | Milestone gates; no graph composition |
| Emdash | Electron desktop | worktrees + port isolation | 34 providers | Apache-2.0 | No agent-to-agent coordination |
| Vibe Kanban | Kanban web UI (community-maintained after Bloop shut down April 2026) | worktrees | 10+ agents | Apache-2.0 | Task board, not dataflow |
| Conductor (conductor.build) | macOS app, parallel worktrees | worktrees | Claude Code, Codex | Proprietary | macOS only |
| Microsoft Conductor | YAML workflows, parallel groups, conditional routing; CLI + web dashboard | worktrees | Copilot, Claude | MIT | Closest to "workflow as graph", but YAML/CLI, not a canvas |
| Bernstein | Planner -> task graph -> parallel agents -> verifier; TUI + web | worktrees | 49 adapters | Apache-2.0 | Deterministic scheduling; no visual authoring |
| Claude Squad | tmux TUI | worktrees | Claude Code, Codex, Aider, Gemini, OpenCode, Amp | AGPL-3.0 | No Windows |
| Nimbalyst (formerly Crystal) | Desktop with visual editing of docs/mockups | worktrees | Claude Code, Codex | repo-dependent | Session manager, not graph |

Augment's review states it directly: **none of these offer a node/graph canvas for visually chaining agents**; they coordinate via task queues, worktree isolation, or session management.

### 2.3 Agent frameworks and durable runtimes (code-first)

- **Claude Agent SDK** (TypeScript + Python): Claude Code's loop as a library. Built-in Read/Edit/Write/Bash/Glob/Grep/WebSearch/WebFetch, subagents (`agents`), hooks, MCP (stdio/sse/http/in-process), permission modes and `canUseTool`, sessions (resume/fork), file checkpointing, `maxTurns`/`maxBudgetUsd`, structured `outputFormat`, worktree isolation for subagents. Bundles the Claude Code binary. This is the best available "coding agent as a callable unit".
- **Claude Code dynamic workflows** (June 2026): Claude writes a JavaScript orchestration script (`agent()`, `pipeline()`, `parallel()`, `phase()`), the runtime executes it in the background with resumable memoized results, up to 16 concurrent agents and 1,000 agents per run, a `/workflows` progress view, and saved scripts in `.claude/workflows/`. Code-authored and Claude-authored, not visually authored. Strong precedent for execution semantics (memoize completed agents, replay on resume, forbid `Date.now()` for determinism).
- **Claude Code agent teams** (experimental, interactive sessions only): lead + teammates with shared task list and mailboxes. Not available through `-p` or the Agent SDK, so not a building block for an external orchestrator.
- **LangGraph**: graph-based state machines with checkpointing, HITL interrupts, time travel. Reference design for cyclic graphs with persistence.
- **OpenAI Agents SDK / Google ADK / Microsoft Agent Framework 1.0 / CrewAI**: handoff-, hierarchical-, graph-, role-based orchestration styles. Useful vocabulary; not coding-agent runtimes.
- **Durable execution** (Temporal, Inngest, Restate, Mastra): checkpoint each step's output; on failure re-run the function and replay cached step results. Mastra snapshots workflow state for suspend/resume. The consensus pattern for agent workflows is "record the LLM output the first time, reuse it on recovery"; this is exactly what Claude's workflow runtime does and what our engine should do.

### 2.4 Adjacent signals

- **GitHub Copilot Canvases** (GitHub blog, 2026-08-17): a durable shared surface where agents and developers collaborate through phases (Assess -> Remediate -> Validate -> Ship), explicit decision points, and approval gates. Validates the "make agent work visible and steerable at checkpoints" thesis. It is a document canvas, not a graph executor.
- **Official MCP servers** exist for the integrations the user named: GitHub (remote at `https://api.githubcopilot.com/mcp/`, PAT or OAuth) and Atlassian (official remote Rovo MCP server for Jira, Confluence, JSM, Bitbucket, Compass; OAuth 2.1 or API tokens).
- **Review burden is the real bottleneck.** METR's July 2025 RCT found experienced developers were 19 percent slower with AI tools, mostly due to reviewing and debugging agent output. An orchestrator that does not make review cheap (diffs, test evidence, gates) just produces more unreviewed code.

## 3. Feasibility assessment

| Dimension | Assessment | Evidence |
|---|---|---|
| Canvas UI | Low risk | React Flow (xyflow) is mature and used by Langflow, Flowise, Sim, n8n-style builders |
| Coding-agent node | Low risk | Claude Agent SDK exposes everything needed: streaming messages, `canUseTool`, hooks, MCP, subagents, budgets, sessions, structured output |
| Isolation | Low-medium risk | git worktrees are the proven pattern in every orchestrator; Claude Code enforces worktree isolation itself and has Windows-specific handling |
| Durable, resumable runs | Medium risk | Well-understood pattern (memoize node outputs, replay); must be designed in from day one |
| Loops with LLM judgment | Medium risk | Need hard caps (iterations, budget, turns) and structured-output judges to avoid runaway spend |
| MCP OAuth (Atlassian) | Medium risk | Agent SDK does not run OAuth flows; the app must run the OAuth 2.1 PKCE flow itself or use a stdio bridge that does |
| Multi-agent harness support | Medium risk | Only Claude via SDK is first class; other CLIs need adapters (stream-json or PTY parsing) |
| Deployed version | Deferred | Engine designed as a headless service from day one; UI is a web app; desktop shell is thin |
| Cost | Real | Each agent node is a full Claude Code session; a loop of three agents over ten files can spend tens of dollars. Budget caps and cost display are non-negotiable |

Verdict: feasible as a solo or small-team project. The differentiated core (visual graph of full coding agents with durable runs) is buildable on the Agent SDK in weeks, not months. The long tail (multi-harness, OAuth, cloud) is incremental.

## 4. How developers would actually use it

Concrete workflows we expect to be the first saved templates:

1. **Issue to PR**: Jira/GitHub issue poll -> Planner agent (read-only, plan mode) -> Gate (approve plan) -> Implementer agent in worktree -> Test runner (shell) -> Loop until tests pass (max 3) -> Reviewer agent -> Gate -> Commit and open PR via GitHub MCP -> Post summary to Jira.
2. **Fix-until-green**: Shell (`npm test`) -> if fail, Agent fixes with failure output as input -> loop until exit code 0 or 5 iterations.
3. **Parallel review**: Map over changed files -> one reviewer agent per file (read-only) -> Judge agent merges and ranks findings (structured output) -> Markdown report.
4. **Migration fan-out**: Discover files (Glob) -> Map with concurrency 4, each agent in its own worktree -> Verifier agent -> Merge branches or open per-slice PRs.
5. **Nightly hygiene**: Schedule trigger -> dependency audit agent -> flaky-test hunter loop -> Notify.
6. **Tournament**: Same task to N agents with different prompts or models -> Judge picks best -> Gate -> apply.

Usage pattern: developers author once on the canvas, run interactively with gates the first few times, then loosen permissions, save as a template, and trigger by schedule or event.

## 5. Differentiation summary

| Capability | Visual builders | Coding orchestrators | Claude workflows | This app |
|---|---|---|---|---|
| Drag-and-drop graph authoring | Yes | No | No (JS script) | Yes |
| Node = full coding agent (files, shell, git) | No | Yes (session) | Yes | Yes |
| Worktree isolation per node | No | Yes | Yes (subagents) | Yes |
| Loops, conditions, fan-out on canvas | Yes | No | In code | Yes |
| Human approval gates | Some | Per-edit prompts | No mid-run input | Yes, first class |
| Durable, resumable runs | Rare | No | Yes | Yes |
| Per-node cost, transcript, diff | Partial | Partial | Token view | Yes |
| Skills, instructions, MCP per node | Partial | Global | Global | Per node |
| Local-first, repo-stored definitions | Varies | Yes | Yes | Yes |
| Deployable engine | Varies | No | No | Designed for |

## 6. Sources

Visual builders and frameworks
- https://madappgang.com/blog/open-source-visual-agent-builders-compared-flowise-vs-langflow-vs-n8n-vs-sim-studio-in-2026/
- https://blckalpaca.at/en/knowledge-base/ai-agents/ai-agent-frameworks-comparison/langflow-vs-flowise-vs-n8n
- https://rapidclaw.dev/blog/low-code-ai-agent-platforms-compared-2026
- https://agentswarms.fyi/blog/flowise-vs-langflow-vs-dify-vs-n8n-vs-agentswarms
- https://rivet.ironcladapp.com/ and https://github.com/Ironclad/rivet
- https://www.langchain.com/blog/langgraph-studio-the-first-agent-ide
- https://www.workflowbuilder.io/blog/langgraph-studio-guide
- https://agentmelt.com/blog/ai-agent-frameworks-compared-2026/
- https://www.morphllm.com/ai-agent-framework

Coding-agent orchestrators
- https://www.augmentcode.com/tools/open-source-agent-orchestrators
- https://munderdiffl.in/blog/claude-code-orchestration-tools-compared/
- https://nimbalyst.com/blog/best-agent-management-tools-2026/
- https://www.tembo.io/blog/claude-code-multi-agent-orchestration
- https://addyosmani.com/blog/code-agent-orchestra/
- https://alexop.dev/posts/claude-code-workflows-deterministic-orchestration/

Claude Code and Agent SDK (official)
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/agent-loop
- https://code.claude.com/docs/en/agent-sdk/permissions
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://code.claude.com/docs/en/agent-sdk/sessions
- https://code.claude.com/docs/en/agent-sdk/hooks
- https://code.claude.com/docs/en/agent-sdk/mcp
- https://code.claude.com/docs/en/agent-sdk/file-checkpointing
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/workflows
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/worktrees
- https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md

Durable execution
- https://www.inngest.com/blog/durable-execution-key-to-harnessing-ai-agents
- https://mastra.ai/blog/what-are-durable-ai-agents
- https://zylos.ai/research/2026-04-24-durable-execution-agent-runtimes/
- https://wetheflywheel.com/en/comparisons/temporal-vs-inngest/

Adjacent
- https://github.blog/ai-and-ml/github-copilot/how-canvases-make-agentic-workflows-visible-steerable-and-cost-efficient/
- https://github.com/atlassian/atlassian-mcp-server
- https://github.com/github/github-mcp-server
- https://www.mindstudio.ai/blog/parallel-ai-coding-agents-git-worktrees
- https://reactflow.dev/ and https://github.com/xyflow/xyflow
- https://rustify.rs/articles/rust-tauri-vs-electron-2026
