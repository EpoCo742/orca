# Orca

Visual orchestration for coding agents. Draw a development workflow on a canvas, where each node is a full coding agent (files, shell, git, MCP) or a deterministic step (tests, conditions, loops, approval gates), and run it with durable, reviewable runs. Workflow definitions live in the repository as JSON.

Status: M0 (scaffold, Copilot spike) and M1 (vertical slice: canvas, engine, Copilot agent node, approvals, crash-resume) are done. Next is M2: worktree isolation, Git node, diff viewer, approval gates. See `docs/04-build-plan.md` and `docs/demos/`.

## Quick start

```powershell
pnpm install
pnpm orca auth login          # GitHub Copilot sign-in (browser + 2FA)
pnpm dev                      # engine + UI; opens the browser
pnpm orca run fix-until-green --approve-all   # headless run of a bundled template
```

## Documents

| File | Audience | Purpose |
|---|---|---|
| `docs/00-landscape-research.md` | Everyone | What exists today, feasibility, usage scenarios, differentiation, sources |
| `docs/01-executive-summary.md` | Product owner, stakeholders | Problem, solution, users, feature set, risks, recommendation |
| `docs/02-architecture.md` | Engineers, owner | Components, workflow model, execution model, agent node, permissions, isolation, deployment, technology choices |
| `docs/03-technical-spec.md` | The AI engineer building it | Build-ready spec: schemas, node catalog, engine algorithms, storage, API, UI, adapter contracts (Copilot SDK, Claude Agent SDK), tests, verification checklist |
| `docs/04-build-plan.md` | Owner and builder | Agreed decisions, environment facts, owner actions, milestones M0 to M5 with acceptance criteria |

## Stack (decided)

TypeScript monorepo (pnpm). Engine: Node service with Hono REST + WebSocket, SQLite event-sourced run log, QuickJS expression sandbox, git worktree isolation. UI: React + React Flow. Agent runtime: GitHub Copilot SDK first, Claude Agent SDK optional. Desktop: Electron in M5.

## License

MIT. See `LICENSE`.
