# Orca Technical Specification (Build Spec)

Audience: the AI engineer (Claude) who will build this. Written for precision over readability.
Date: 2026-09-10
Status: v1 build spec. Sections marked **VERIFY** must be reconciled against the installed SDK type definitions before coding that area; the Agent SDK moves fast (0.3.267 at time of writing) and web docs summarized here may drift.

---

## 0. Ground rules for the build

0.1 Language: TypeScript 5.x, strict mode, ESM. Node 22 LTS. Package manager: pnpm 10 with workspaces. Monorepo.
0.2 Before writing any code that touches the Agent SDK, run `pnpm add @anthropic-ai/claude-agent-sdk@latest` in `packages/engine` and read `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (or the `dist/*.d.ts` entry point). Reconcile every type referenced in section 7 against it. Record the pinned version in `docs/decisions/0001-sdk-version.md`.
0.3 Models: default agent node model `claude-opus-5`; Judge default `claude-sonnet-5`; classifier-style nodes may use `claude-haiku-4-5`. `claude-fable-5-1` is selectable. Never append date suffixes to model IDs. SDK aliases (`opus`, `sonnet`, `haiku`, `fable`, `inherit`) are also accepted in `AgentDefinition.model`.
0.4 Adapters and authentication. **Primary adapter for v1 is the GitHub Copilot SDK** (section 7B), authenticated with the developer's GitHub identity (stored `copilot login` / `gh auth` OAuth token, or `COPILOT_GITHUB_TOKEN`; classic `ghp_` PATs are rejected). The Claude Agent SDK adapter (section 7) is secondary and needs `ANTHROPIC_API_KEY` or provider env (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, **VERIFY** names). The engine never prompts for a key; it reports a clear error and links to settings. Model defaults in 0.3 apply to the Claude adapter; for the Copilot adapter the default model is whatever `client.listModels()` reports as default or the first Claude model the org policy allows.
0.5 Windows is a first-class target (the owner develops on Windows 11). All path handling through `node:path`; spawn via `execa` with `windowsHide: true`; shell nodes run under the user's configured shell (PowerShell or bash); git invoked as a binary, never through a shell string.
0.6 Every feature lands with unit tests (Vitest). Engine has contract tests against a fake adapter. UI has component tests (Vitest + Testing Library) and a small Playwright smoke suite.
0.7 Conventional commits. Lint: ESLint flat config + Prettier. No `any` except at adapter boundaries with a `// VERIFY` comment.

---

## 1. Repository layout

```
agent-orch/
  package.json                 # pnpm workspace root, scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  .orca/                       # example workflows used by tests and templates
    workflows/*.workflow.json
  docs/                        # these documents + ADRs in docs/decisions/
  packages/
    shared/                    # zod schemas, types, constants, expression grammar docs
    engine/                    # Node service: API, scheduler, executors, adapters, storage
    ui/                        # React + React Flow app (Vite)
    desktop/                   # Electron shell (electron-vite)
    cli/                       # `orca` CLI
  templates/                   # starter workflows shipped with the app
  scripts/                     # build, release, codegen
```

### 1.1 Dependencies (pin exact versions at install; majors below are the intent)

shared: `zod@^3`, `json-schema-to-zod` (for Judge/outputFormat editing, optional), `nanoid`.
engine: `@anthropic-ai/claude-agent-sdk` (pin), `hono@^4` + `@hono/node-server` + `@hono/node-ws`, `better-sqlite3@^11`, `drizzle-orm`, `drizzle-kit`, `execa@^9`, `quickjs-emscripten@^0.31` (or `@sebastianwessel/quickjs`), `croner@^9` (cron), `pino`, `simple-git@^3` (thin helper; critical git calls still via execa), `keytar` alternative: in headless mode use `@napi-rs/keyring` or encrypted file with `node:crypto`; in desktop mode secrets are proxied to Electron `safeStorage`.
ui: `react@^19`, `react-dom`, `@xyflow/react@^12`, `zustand@^5`, `@tanstack/react-query@^5`, `@codemirror/*` (prompt and JS editors), `tailwindcss@^4`, `radix-ui` primitives (or shadcn/ui generated), `lucide-react`, `diff2html` or `react-diff-viewer-continued`, `dagre` or `elkjs` for auto-layout.
desktop: `electron@^3x` (current major), `electron-vite`, `electron-builder`.
cli: `commander@^13`.
dev: `typescript`, `vitest`, `@playwright/test`, `eslint`, `prettier`, `tsx`.

---

## 2. Domain model and schemas (`packages/shared`)

All schemas in zod; TypeScript types inferred. JSON Schema is generated from zod for the UI forms and for file validation in the CLI.

### 2.1 Identifiers

```ts
export const NodeId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);   // author-facing, stable, used in expressions
export const PortId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const WorkflowId = z.string().uuid();
export const RunId = z.string().uuid();
export const ScopePath = z.string(); // e.g. "" | "map_files[3]" | "loop_fix[2]/map_files[0]"
```

### 2.2 Expressions and templates

- **Template string**: any string field marked `template: true` may contain `{{ expr }}` segments. Rendered by evaluating `expr` in the sandbox and `String()`-ing the result (objects are JSON-stringified).
- **Expression**: a JavaScript expression (no statements) evaluated in the sandbox; must return a value.
- **Function**: a JavaScript function body `(ctx) => { ... return value }` for Transform nodes.

Sandbox context (frozen, structured-cloned):

```ts
interface ExprContext {
  inputs: Record<string, unknown>;          // workflow inputs
  nodes: Record<NodeId, Record<PortId, unknown>>; // outputs of completed nodes visible in scope
  item?: unknown;                            // current Map item
  index?: number;                            // current Map index
  iteration?: { index: number; previous?: Record<NodeId, Record<PortId, unknown>> };
  run: { id: string; startedAt: string; workflow: { id: string; name: string } };
  env: Record<string, string>;               // allow-listed non-secret env vars only
}
```

Rules: 50 ms CPU limit, 16 MB memory, no `Date.now()`/`Math.random()` (throw, same as Claude Code workflow scripts, to keep replays deterministic; pass timestamps in as inputs), no network, no filesystem. Implementation: `quickjs-emscripten` with `runtime.setInterruptHandler` and `setMemoryLimit`.

### 2.3 Workflow document

```ts
export const WorkflowDocument = z.object({
  schemaVersion: z.literal(1),
  id: WorkflowId,
  name: z.string().min(1),
  description: z.string().optional(),
  inputs: z.array(z.object({
    name: PortId,
    type: z.enum(['string','number','boolean','json','secretRef']),
    required: z.boolean().default(false),
    default: z.unknown().optional(),
    description: z.string().optional(),
  })).default([]),
  settings: z.object({
    repoPath: z.string().optional(),                 // absolute or relative to the .orca file; default = repo containing the file
    defaultModel: z.string().default('claude-opus-5'),
    defaultEffort: z.enum(['low','medium','high','xhigh','max']).default('high'),
    runBudgetUsd: z.number().positive().default(25),
    maxConcurrentAgents: z.number().int().min(1).max(16).default(4),
    unattended: z.boolean().default(false),          // required true to permit bypassPermissions on any node
    worktree: z.object({
      baseRef: z.enum(['default-branch','head']).default('head'),
      dir: z.string().default('.orca/worktrees'),
      include: z.array(z.string()).default([]),     // gitignored files to copy, mirrors .worktreeinclude semantics
    }).default({}),
    env: z.record(z.string()).default({}),           // non-secret env for shell + agents; values may be templates
    secrets: z.array(z.string()).default([]),        // names of secrets this workflow references
    mcpServers: z.record(McpServerConfig).default({}), // workflow-level servers, referenced by name from nodes
    retention: z.object({ runsDays: z.number().default(30), worktreesDays: z.number().default(7) }).default({}),
  }).default({}),
  nodes: z.array(Node),
  edges: z.array(Edge),
  ui: z.object({ viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional() }).default({}),
});
```

### 2.4 Nodes and edges

```ts
export const NodeBase = z.object({
  id: NodeId,
  type: z.string(),                                  // discriminator, one of NodeType
  label: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ w: z.number(), h: z.number() }).optional(), // containers
  parent: NodeId.optional(),                         // containing Loop/Map node id
  disabled: z.boolean().default(false),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(10).default(1),
    backoffMs: z.number().int().default(2000),
    retryOn: z.array(z.enum(['error','timeout','budget','nonzero_exit','schema_invalid'])).default(['error','timeout']),
  }).default({}),
  timeoutMs: z.number().int().positive().optional(),
  config: z.unknown(),                               // refined per type below
});

export const Edge = z.object({
  id: z.string(),
  from: z.object({ node: NodeId, port: PortId }),
  to: z.object({ node: NodeId, port: PortId }),
  // Optional guard. If present, the edge only carries data when the expression is truthy.
  when: z.string().optional(),
});
```

Port typing: each node type declares `inputs: PortDecl[]` and `outputs: PortDecl[]` with `type: 'string'|'number'|'boolean'|'json'|'any'|'trigger'`. The compiler validates edge type compatibility (`any` matches everything; `trigger` carries no data, only ordering).

Every node has an implicit input port `trigger` (type `trigger`) and implicit output ports `done` (trigger) and `error` (json: `{message, code}`). Connecting `error` enables error routing; otherwise an error fails the run (subject to retry).

### 2.5 Node type catalog with config schemas and ports

Notation: `in:` input ports, `out:` output ports. `T` means template-enabled.

**trigger.manual**
```ts
config: { inputsForm: z.array(PortId).default([]) }   // which workflow inputs to prompt for
out: inputs(json)
```

**trigger.schedule**
```ts
config: { cron: z.string(), timezone: z.string().default('UTC'), enabled: z.boolean().default(true), inputs: z.record(z.unknown()).default({}) }
out: firedAt(string), inputs(json)
```

**agent.claude**
```ts
config: z.object({
  adapter: z.enum(['copilot','claude-sdk','claude-cli']).default('copilot'),
  prompt: z.string(),                                  // T
  system: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('preset'), append: z.string().optional() }),   // systemPrompt: {type:'preset', preset:'claude_code', append}
    z.object({ mode: z.literal('custom'), text: z.string() }),               // T
  ]).default({ mode: 'preset' }),
  model: z.string().optional(),                        // falls back to settings.defaultModel
  effort: z.enum(['low','medium','high','xhigh','max']).optional(),
  settingSources: z.array(z.enum(['user','project','local'])).default(['project']),
  permissionMode: z.enum(['default','acceptEdits','plan','dontAsk','auto','bypassPermissions']).default('acceptEdits'),
  allowedTools: z.array(z.string()).default(['Read','Glob','Grep','Edit','Write','Bash(git *)','Bash(npm *)','Bash(pnpm *)']),
  disallowedTools: z.array(z.string()).default([]),
  approval: z.object({
    onUnresolved: z.enum(['ask','deny']).default('ask'),   // what the broker does when SDK leaves the decision to canUseTool
    timeoutSec: z.number().int().default(1800),
    onTimeout: z.enum(['deny','allow']).default('deny'),
    autoAllowReadOnly: z.boolean().default(true),
  }).default({}),
  mcpServers: z.array(z.union([z.string(), McpServerConfigNamed])).default([]), // by name (workflow-level) or inline
  agents: z.record(AgentDefinitionSchema).default({}),  // subagents
  plugins: z.array(z.string()).default([]),            // local plugin paths
  outputSchema: z.record(z.unknown()).optional(),      // JSON Schema; when set, `json` port is populated and validated
  maxTurns: z.number().int().min(1).default(50),
  maxBudgetUsd: z.number().positive().default(5),      // enforced by the Claude SDK; advisory for Copilot (no USD accounting)
  maxPremiumRequests: z.number().int().positive().default(30), // Copilot adapter: cap on model turns (each counts as a premium request)
  maxToolCalls: z.number().int().positive().default(400),      // adapter-agnostic hard stop
  subagentLimits: z.object({ depth: z.number().int().default(1), concurrency: z.number().int().default(4) }).default({}),
  isolation: z.enum(['none','worktree']).default('worktree'),
  cwdRelative: z.string().optional(),                  // subdirectory of repo/worktree
  session: z.object({
    mode: z.enum(['fresh','resume','fork']).default('fresh'),
    fromNode: NodeId.optional(),                       // take session_id from this node's output
  }).default({}),
  fileCheckpointing: z.boolean().default(false),       // only meaningful when isolation = none
  includePartialMessages: z.boolean().default(true),
  env: z.record(z.string()).default({}),               // T, merged over settings.env
})
in: trigger, context(any, optional; exposed to template as `inputs.context`)
out: text(string), json(json), files_changed(json: string[]), diff(string), cost_usd(number), session_id(string), num_turns(number), result_subtype(string), done, error
```

**agent.judge** (preset over agent.claude)
Same config as `agent.claude` with enforced: `outputSchema` required, `permissionMode: 'dontAsk'`, `allowedTools` default `['Read','Glob','Grep']`, `isolation: 'none'`, `model` default `claude-sonnet-5`, `maxTurns` default 15, `maxBudgetUsd` default 1.
out: json(json), score(number, if schema has numeric `score`), verdict(string, if schema has string `verdict`), plus base ports.

**action.shell**
```ts
config: { command: z.string() /*T*/, shell: z.enum(['auto','bash','powershell','cmd','sh']).default('auto'), cwdRelative: z.string().optional(), env: z.record(z.string()).default({}), timeoutMs: z.number().default(600000), failOnNonZero: z.boolean().default(false), captureLimitBytes: z.number().default(1_000_000), useUpstreamWorktree: NodeId.optional() }
out: exit_code(number), stdout(string), stderr(string), duration_ms(number)
```
If `useUpstreamWorktree` names an agent node with worktree isolation, the command runs inside that worktree (this is how "run tests on what the agent just did" works).

**action.git**
```ts
config: z.discriminatedUnion('op', [
  z.object({ op: z.literal('worktree.create'), name: z.string() /*T*/, baseRef: z.string().optional() }),
  z.object({ op: z.literal('worktree.remove'), target: NodeId, force: z.boolean().default(false) }),
  z.object({ op: z.literal('diff'), target: NodeId, base: z.string().optional() }),
  z.object({ op: z.literal('commit'), target: NodeId, message: z.string() /*T*/, addAll: z.boolean().default(true), allowEmpty: z.boolean().default(false) }),
  z.object({ op: z.literal('push'), target: NodeId, remote: z.string().default('origin'), setUpstream: z.boolean().default(true) }),
  z.object({ op: z.literal('merge'), target: NodeId, into: z.string().default('HEAD'), strategy: z.enum(['merge','squash','rebase']).default('squash') }),
  z.object({ op: z.literal('pr.create'), target: NodeId, title: z.string() /*T*/, body: z.string() /*T*/, base: z.string().optional(), draft: z.boolean().default(true), via: z.enum(['gh','mcp']).default('gh') }),
])
out: branch(string), commit(string), diff(string), pr_url(string), worktree_path(string), stats(json)
```
`target` refers to the node whose worktree the operation acts on.

**action.mcp_tool**
```ts
config: { server: z.union([z.string(), McpServerConfigNamed]), tool: z.string(), args: z.record(z.unknown()) /* values T */, timeoutMs: z.number().default(60000) }
out: result(json), is_error(boolean)
```
Implemented with `@modelcontextprotocol/sdk` client directly (no model). Tool list cached per server for the inspector's autocomplete.

**action.notify**
```ts
config: { channel: z.enum(['desktop','webhook','slack']), title: z.string() /*T*/, message: z.string() /*T*/, url: z.string().optional() /*T, webhook*/, secretRef: z.string().optional() }
out: delivered(boolean)
```

**control.condition**
```ts
config: { expression: z.string() }
out: true(trigger), false(trigger), value(boolean)
```
Exactly one of `true`/`false` fires.

**control.loop** (container)
```ts
config: { until: z.string() /* expression over body outputs; evaluated after each iteration */, maxIterations: z.number().int().min(1).max(100), budgetUsd: z.number().optional(), carry: z.array(z.object({ from: z.string() /*expr*/, as: PortId })).default([]) }
children: NodeId[]  (via node.parent)
out: last(json: body outputs of final iteration), iterations(number), exited_by(enum 'until'|'max'|'budget'|'error')
```
Body entry: child nodes with no incoming edges from other children start each iteration. Body exit: when all children are terminal. `iteration.previous` exposes the prior iteration's outputs; `carry` copies named values into `iteration.carried`.

**control.map** (container)
```ts
config: { items: z.string() /* expression returning array */, concurrency: z.number().int().min(1).max(16).default(4), isolationPerItem: z.boolean().default(false), failFast: z.boolean().default(false), itemAlias: PortId.default('item') }
out: results(json: array aligned to items; failed items are {error}), succeeded(number), failed(number)
```
Each item runs the body in scope `map_id[index]`. Container-level `maxBudgetUsd` is the sum of child budgets times items unless overridden by run budget.

**control.join**
```ts
config: { mode: z.enum(['all','any','n']).default('all'), n: z.number().int().optional() }
in: dynamic inputs (one per incoming edge)
out: merged(json: { [sourceNodeId]: payload })
```

**control.gate** (approval)
```ts
config: { title: z.string() /*T*/, instructions: z.string() /*T*/, show: z.array(z.object({ label: z.string(), expression: z.string(), render: z.enum(['text','markdown','json','diff']).default('markdown') })).default([]), editablePayload: z.boolean().default(false), payload: z.string().optional() /*expr*/, timeoutSec: z.number().optional(), onTimeout: z.enum(['reject','approve']).default('reject'), notify: z.boolean().default(true) }
out: approved(trigger), rejected(trigger), payload(json), decided_by(string), comment(string)
```

**data.transform**
```ts
config: { code: z.string() /* function body: (ctx) => value */ }
out: value(any)
```

**workflow.sub**
```ts
config: { workflowRef: z.string() /* path or id */, inputs: z.record(z.string()) /* T */ , inheritSecrets: z.boolean().default(true) }
out: outputs(json)
```

### 2.6 MCP and subagent schemas (mirror SDK shapes; **VERIFY** field names against sdk.d.ts)

```ts
export const McpServerConfig = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), command: z.string(), args: z.array(z.string()).default([]), env: z.record(z.string()).default({}) /* values may be ${SECRET:name} */ }),
  z.object({ type: z.literal('sse'),  url: z.string().url(), headers: z.record(z.string()).default({}) }),
  z.object({ type: z.literal('http'), url: z.string().url(), headers: z.record(z.string()).default({}) }),
]);
export const McpServerConfigNamed = z.object({ name: z.string(), config: McpServerConfig });

export const AgentDefinitionSchema = z.object({
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),             // 'opus'|'sonnet'|'haiku'|'fable'|'inherit'|full id
  skills: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
  maxTurns: z.number().int().optional(),
  background: z.boolean().optional(),
  effort: z.enum(['low','medium','high','xhigh','max']).optional(),
  permissionMode: z.enum(['default','acceptEdits','plan','dontAsk','auto','bypassPermissions']).optional(),
});
```

Secret references: the literal pattern `${SECRET:<name>}` anywhere in MCP `env`/`headers`, node `env`, or `action.notify.url`. Resolved by the engine immediately before process launch; never logged; redacted in any echo with `***`.

### 2.7 Compiler validations (errors block save-as-runnable; warnings shown in UI)

Errors:
- Unknown node type; config fails its schema.
- Edge references missing node/port; port type mismatch.
- Cycle among nodes outside a Loop container (cycles are only legal as Loop body iterations).
- Edge crossing a container boundary except: edges into a container's first-level children from outside (fan-in) and edges out of the container node itself. Children may not connect directly to nodes outside their container; they connect to the container's output ports implicitly via `last`/`results`.
- `permissionMode: 'bypassPermissions'` on a node while `settings.unattended` is false or `isolation` is `none`.
- Loop without `maxIterations`; Map `items` not an expression.
- Template references to `nodes.X` where X is not an ancestor or sibling-upstream in the same or enclosing scope.
- `agent.claude.session.fromNode` pointing to a node that is not upstream.
- Secret reference to a name not in `settings.secrets`.

Warnings:
- Agent node with writer tools and `isolation: 'none'`.
- No Gate between a writer agent and any `git.push`/`pr.create`.
- `maxBudgetUsd` times possible executions (loop max x map items estimate) exceeds `runBudgetUsd`.

---

## 3. Engine architecture (`packages/engine`)

### 3.1 Process model

Single Node process. Subsystems are classes wired in `createEngine(config)`; the same factory is used by the HTTP server, the CLI, and tests. Long-running child processes: Claude Code subprocess per agent node (spawned by the SDK), MCP stdio servers (spawned by Claude Code for agent nodes, by the engine for `action.mcp_tool`), shell commands.

Config:
```ts
interface EngineConfig {
  dataDir: string;           // ~/.orca (Windows: %APPDATA%/orca)
  dbPath: string;            // dataDir/orca.db
  port: number; host: '127.0.0.1';
  authToken: string;         // required bearer token
  maxConcurrentAgentsGlobal: number; // default 8
  secretsProvider: 'electron' | 'keyring' | 'file';
  logLevel: string;
}
```

### 3.2 Storage (SQLite, drizzle)

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,   -- absolute path of the .workflow.json
  repo_path TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_hash TEXT NOT NULL,
  workflow_snapshot TEXT NOT NULL,          -- full document JSON at start (for replay fidelity)
  status TEXT NOT NULL,                     -- queued|running|waiting|paused|completed|failed|cancelled
  inputs TEXT NOT NULL, trigger TEXT NOT NULL,
  started_at TEXT, finished_at TEXT, cost_usd REAL DEFAULT 0, error TEXT,
  parent_run_id TEXT, parent_node_id TEXT  -- for workflow.sub
);
CREATE TABLE run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, ts TEXT NOT NULL,
  type TEXT NOT NULL, node_id TEXT, scope TEXT, attempt INTEGER, payload TEXT NOT NULL
);
CREATE INDEX run_events_run ON run_events(run_id, seq);
CREATE TABLE node_outputs (                  -- memoization table (projection, rebuildable from events)
  run_id TEXT NOT NULL, node_id TEXT NOT NULL, scope TEXT NOT NULL, attempt INTEGER NOT NULL,
  status TEXT NOT NULL, outputs TEXT, inputs_hash TEXT NOT NULL, cost_usd REAL DEFAULT 0,
  started_at TEXT, finished_at TEXT, PRIMARY KEY (run_id, node_id, scope)
);
CREATE TABLE transcripts (                   -- agent message stream, one row per SDK message
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, node_id TEXT, scope TEXT, ts TEXT,
  kind TEXT NOT NULL, payload TEXT NOT NULL, parent_tool_use_id TEXT
);
CREATE INDEX transcripts_node ON transcripts(run_id, node_id, scope, seq);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, scope TEXT, kind TEXT NOT NULL,  -- gate|tool_permission|plan
  status TEXT NOT NULL,                     -- pending|approved|rejected|timeout
  request TEXT NOT NULL, response TEXT, created_at TEXT, decided_at TEXT, decided_by TEXT, expires_at TEXT
);
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, scope TEXT, repo_path TEXT, path TEXT, branch TEXT,
  status TEXT NOT NULL,                     -- active|kept|removed
  created_at TEXT, removed_at TEXT
);
CREATE TABLE schedules (
  id TEXT PRIMARY KEY, workflow_id TEXT, node_id TEXT, cron TEXT, timezone TEXT, enabled INTEGER, next_fire_at TEXT, last_fire_at TEXT
);
CREATE TABLE secrets_index (name TEXT PRIMARY KEY, created_at TEXT); -- values live in the secrets provider
```

Event types (`run_events.type`), payload shapes in `shared/events.ts`:
`run.created`, `run.started`, `run.status` {status}, `run.budget` {cost_usd}, `run.completed`, `run.failed` {error}, `run.cancelled`,
`node.scheduled`, `node.started` {attempt, inputs_hash, resolved_inputs (redacted)}, `node.progress` {summary}, `node.completed` {outputs, cost_usd}, `node.failed` {error, retryable}, `node.skipped` {reason}, `node.retry` {attempt, delay_ms},
`loop.iteration` {index}, `loop.exit` {exited_by}, `map.item.started`/`map.item.completed` {index},
`approval.requested` {approvalId, kind}, `approval.decided` {approvalId, status},
`worktree.created`/`worktree.removed` {path, branch},
`agent.session` {session_id}, `agent.cost` {cost_usd, usage}.

Transcript rows store the raw SDK message (`kind` = message.type, plus subtype) so the UI can render exactly what the agent did. Large tool results over 64 KB are stored in `dataDir/blobs/<sha256>` and referenced.

### 3.3 Compiler

Input: `WorkflowDocument`. Output: `ExecutionPlan`:

```ts
interface ExecutionPlan {
  nodes: Map<NodeId, PlannedNode>;          // includes container membership, depth
  edgesByTarget: Map<NodeId, Edge[]>;
  edgesBySource: Map<NodeId, Edge[]>;
  roots: NodeId[];                          // trigger nodes
  containers: Map<NodeId, { kind: 'loop'|'map'; children: NodeId[]; entry: NodeId[]; exit: NodeId[] }>;
  topo: NodeId[];                           // topological order of the flattened DAG (containers as single nodes)
  templateRefs: Map<NodeId, Set<NodeId>>;   // which node outputs each node reads (for replay invalidation)
}
```

Template references are extracted by parsing `{{ }}` segments and expressions with a tolerant JS tokenizer looking for `nodes.<id>` member accesses. Used both for validation and for replay-from-node invalidation.

### 3.4 Scheduler algorithm

State per run (in memory, rebuilt from events on load):

```ts
interface RunState {
  status; nodeStatus: Map<`${NodeId}@${ScopePath}`, 'pending'|'ready'|'running'|'waiting'|'completed'|'failed'|'skipped'>;
  outputs: Map<`${NodeId}@${ScopePath}`, Record<PortId, unknown>>;
  firedPorts: Map<`${NodeId}@${ScopePath}`, Set<PortId>>;   // which trigger-typed outputs fired (condition true/false, gate approved/rejected)
  iterations: Map<`${NodeId}@${ScopePath}`, number>;
  costUsd: number;
  inflightAgents: number;
}
```

Loop:
1. `ready(node@scope)` when: all incoming edges whose source is in the same scope either (a) have their source completed and, for trigger-typed ports or `when` guards, the port fired / guard true, or (b) the source was skipped. A node whose every incoming trigger edge comes from a non-fired port is `skipped`, and skipping propagates (a Condition's false branch skips the whole untaken branch).
2. Dispatch ready nodes subject to: `run.maxConcurrentAgents` and engine global cap for agent nodes; `map.concurrency` within a Map scope; run budget remaining > 0 (else fail run with `budget_exhausted`).
3. Execution: resolve inputs (render templates with `ExprContext` built from visible outputs in scope chain), compute `inputs_hash = sha256(canonical JSON)`, write `node.started`, call executor. On success write `node.completed` and outputs; on failure apply retry policy, else `node.failed`; if an `error` edge exists, fire `error` port and continue, else fail the run (cancel siblings with `failFast` semantics for Map; otherwise let independent branches finish, then mark failed).
4. Containers: Loop — on iteration completion evaluate `until`; if false and `index+1 < maxIterations` and budget ok, emit `loop.iteration` and reset child statuses under new scope `loop_id[index+1]`; else complete the loop node with `last` = outputs of final iteration's exit nodes. Map — evaluate `items`, emit per-item scopes, dispatch up to `concurrency`, collect `results`.
5. Gate — executor writes `approval.requested`, sets node `waiting` and run `waiting` if nothing else is running. Scheduler resumes on `approval.decided`.
6. Terminate: when no node is pending/ready/running/waiting -> `run.completed` (or `run.failed` if any required node failed).

Memoization/resume: on engine start, for runs in `running|waiting|paused`, rebuild state, then for every node with status `running` in the projection (in flight at crash) reset to `ready` and re-dispatch. Completed nodes are never re-executed within the same run.

Replay-from-node (`POST /runs/:id/replay {nodeId, scope?, overrides?}`): creates a **new run** with `parent_run_id`; copies `node.completed` outputs for all nodes not in the downstream closure of `nodeId` (computed from edges plus `templateRefs`), then schedules normally. Overrides allow editing the replayed node's config for this run only.

### 3.5 Executors

Interface:
```ts
interface NodeExecutor<C> {
  type: string;
  validate(config: unknown): C;
  execute(ctx: ExecContext<C>): Promise<ExecResult>;
}
interface ExecContext<C> {
  run: RunRef; node: PlannedNode; scope: ScopePath; attempt: number;
  config: C;                           // already template-rendered where marked T
  inputs: Record<PortId, unknown>;
  expr: ExprEvaluator;                 // bound to this node's context
  cwd: string;                         // repo root or worktree
  emit(event: NodeEvent): void;        // progress/transcript
  approvals: ApprovalBroker;
  secrets: SecretsResolver;
  worktrees: WorktreeManager;
  signal: AbortSignal;
  logger: Logger;
}
type ExecResult = { outputs: Record<PortId, unknown>; fired?: PortId[]; costUsd?: number };
```

Executors registered: `ManualTrigger`, `ScheduleTrigger`, `ClaudeAgent` (covers `agent.judge`), `Shell`, `Git`, `McpTool`, `Notify`, `Condition`, `Loop` (container driver lives in scheduler, executor computes outputs), `Map` (same), `Join`, `Gate`, `Transform`, `SubWorkflow`.

### 3.6 Shell executor

- `shell: auto` picks PowerShell on Windows, `bash` elsewhere; the command string is passed to that shell. Spawn via execa with `cwd`, merged env (`process.env` + settings.env + node env + resolved secrets), `timeout`, `maxBuffer` per `captureLimitBytes`, `windowsHide`.
- Stream stdout/stderr as `node.progress` events (chunked, throttled to 10 Hz) so the UI shows live output.
- Exit code always becomes output; `failOnNonZero` converts non-zero into a node failure (retryable with `nonzero_exit`).

### 3.7 Worktree manager

```ts
interface WorktreeManager {
  create(opts: { repoPath; runId; nodeId; scope; baseRef: 'default-branch'|'head'|string; name?: string }): Promise<Worktree>;
  diff(wt: Worktree, base?: string): Promise<{ patch: string; stats: { files: number; insertions: number; deletions: number }; files: string[] }>;
  commit(wt, message, opts): Promise<{ commit: string }>;
  push(wt, remote, setUpstream): Promise<void>;
  mergeInto(wt, into, strategy): Promise<{ commit?: string; conflicts?: string[] }>;
  remove(wt, force): Promise<void>;
  sweep(retentionDays): Promise<void>;
}
```
Implementation details:
- Path: `<repoPath>/<settings.worktree.dir>/<runId8>-<nodeId>[-<scopeSlug>]`. Keep under 60 chars after the repo path. On Windows run `git config core.longpaths true` once per repo (local config) and warn if the resulting absolute path exceeds 240 chars.
- Branch: `orca/<workflowSlug>/<runId8>/<nodeId>`.
- Base ref `default-branch`: resolve `origin/HEAD` (fetch with 5 s cap if last fetch > 24 h, mirror Claude Code's behavior); `head`: current HEAD of the main checkout.
- `git worktree add -b <branch> <path> <base>`; then `git worktree lock <path> --reason orca-run-<runId>`; copy `settings.worktree.include` files (glob over gitignored files, same semantics as `.worktreeinclude`) and honor the repo's own `.worktreeinclude` if present.
- Ensure `.orca/worktrees/` is in `.git/info/exclude` (not `.gitignore`, to avoid modifying the user's tracked files).
- `remove`: `git worktree unlock`, `git worktree remove [--force]`, `git branch -D` only if the branch has no unmerged commits or `force`.
- Diff: `git add -A -N` (intent-to-add so new files appear) then `git diff --patch --stat <base>`; revert the intent-to-add after (`git reset`). Alternative: `git diff HEAD` plus `git ls-files --others --exclude-standard` for untracked.
- Never run git through a shell; always `execa('git', [...], { cwd })`.

### 3.8 Permission broker

```ts
interface ApprovalBroker {
  requestToolPermission(req: { runId; nodeId; scope; toolName; input: unknown; suggestions?: unknown; policy: ApprovalPolicy }): Promise<PermissionDecision>;
  requestGate(req: GateRequest): Promise<GateDecision>;
  decide(approvalId: string, decision: { status: 'approved'|'rejected'; payload?: unknown; comment?: string; decidedBy: string; remember?: 'none'|'run'|'workflow' }): void;
}
```
Tool permission flow inside `canUseTool` (see 7.4):
1. Engine hard-deny list (regex over `Bash` commands: `rm -rf /`, `rm -rf ~`, `git push --force` to protected branches, `:(){ :|:& };:`, `format`, `del /s /q C:\`; path checks for `Edit/Write` outside `cwd` unless in `additionalDirectories`). Deny with reason.
2. If `approval.autoAllowReadOnly` and tool in {Read, Glob, Grep, WebFetch, WebSearch, ToolSearch, LS} or MCP tool annotated read-only (from cached tool list): allow.
3. If `approval.onUnresolved === 'deny'`: deny.
4. Else create `approvals` row (kind `tool_permission`), emit `approval.requested`, await decision or timeout. `remember: 'run'` adds an allow rule for the rest of the run (engine-side cache keyed by tool name and, for Bash, the first token of the command); `remember: 'workflow'` writes an `allowedTools` entry into the workflow document (requires UI confirmation).
5. Timeout -> `approval.onTimeout`.

### 3.9 Secrets

Provider interface: `get(name)`, `set(name, value)`, `delete(name)`, `list()`. Desktop: engine calls back into Electron over a local IPC socket (named pipe on Windows) which uses `safeStorage.encryptString` and stores ciphertext in `dataDir/secrets.json`. Headless: `@napi-rs/keyring` if available, else AES-256-GCM file encrypted with a key from `ORCA_MASTER_KEY` env. Redaction: a `Redactor` holds the set of resolved secret values for the current process and replaces them in every log line, event payload, and transcript row before persistence.

### 3.10 Triggers

- Manual: `POST /runs`.
- Schedule: on engine start and on workflow save, (re)register croner jobs for each enabled `trigger.schedule` node; fire -> create run with `trigger: {type:'schedule', nodeId, firedAt}`. Missed fires while the engine was down are not replayed (document this).

---

## 4. HTTP and WebSocket API (Hono)

All routes under `/api/v1`, `Authorization: Bearer <token>`. JSON bodies validated with zod from `shared/api.ts`.

Workflows
- `GET /workflows` list (from index; also scans `<repo>/.orca/workflows` for registered repos).
- `POST /workflows/import {path}` register a file; `POST /workflows {repoPath, document}` create file; `PUT /workflows/:id {document}` save (validates; returns diagnostics); `GET /workflows/:id`; `DELETE /workflows/:id {deleteFile?}`.
- `POST /workflows/:id/validate {document}` -> `{errors[], warnings[]}`.
- `GET /templates` -> bundled templates; `POST /workflows/from-template {templateId, repoPath, name}`.

Runs
- `POST /runs {workflowId, inputs, options?: {dryRun?: boolean}}` -> `{runId}`.
- `GET /runs?workflowId=&status=&limit=&cursor=`; `GET /runs/:id` (state projection: node statuses, outputs summary, cost); `GET /runs/:id/events?after=seq`; `GET /runs/:id/nodes/:nodeId/transcript?scope=&after=seq`; `GET /runs/:id/nodes/:nodeId/diff?scope=`.
- `POST /runs/:id/cancel`, `POST /runs/:id/pause` (stop dispatching; in-flight nodes finish), `POST /runs/:id/resume`, `POST /runs/:id/replay {nodeId, scope?, overrides?}` -> new runId.
- `POST /runs/:id/nodes/:nodeId/interrupt` (agent interrupt via `Query.interrupt()`).

Approvals
- `GET /approvals?status=pending`; `POST /approvals/:id/decide {status, payload?, comment?, remember?}`.

Worktrees
- `GET /worktrees?runId=`; `POST /worktrees/:id/remove {force}`; `POST /worktrees/:id/keep`.

Secrets
- `GET /secrets` (names); `PUT /secrets/:name {value}`; `DELETE /secrets/:name`.

MCP
- `POST /mcp/inspect {config}` -> `{tools: [{name, description, inputSchema, annotations}]}` (connects, lists, disconnects; 20 s timeout).
- `GET /mcp/presets` -> GitHub, Atlassian, filesystem, Playwright preset configs with required secret names.

System
- `GET /health`, `GET /system/auth-status` (SDK credential detection: env vars present; last successful call), `GET /system/models` (static list from this spec plus any from `GET /v1/models` if an API key is present).

WebSocket `/api/v1/ws?token=`: client sends `{subscribe: {runId}}` / `{unsubscribe}`; server pushes `run_events` and `transcripts` rows as `{channel:'run'|'transcript', runId, ...row}` plus `{channel:'approval', ...}` for all pending approvals. Backpressure: coalesce `node.progress` to at most 10 per second per node; never drop non-progress events.

---

## 5. UI specification (`packages/ui`)

### 5.1 Layout

- Top bar: workflow name, repo path, Save, Validate, Run, Run history, Settings, connection status.
- Left: Palette (grouped by category; drag to canvas) and Templates.
- Center: React Flow canvas. Custom node components per type; container nodes rendered as resizable groups (`parentId` + `extent: 'parent'` in React Flow). Edge labels show port names; guarded edges show a `?` badge with the `when` expression on hover.
- Right: Inspector (schema-driven; `@rjsf` is acceptable but a hand-built form per node type is preferred for prompt fields). Prompt fields use CodeMirror with a custom `{{ }}` highlighter and autocompletion populated from upstream outputs (`nodes.<id>.<port>`), `inputs.*`, `item`, `iteration.*`.
- Bottom drawer: Run console (events list), Approvals queue, Problems (diagnostics).

### 5.2 Run view

Toggle between Edit and Run modes. In Run mode the canvas is read-only and each node shows: status ring (pending grey, running animated, waiting amber, completed green, failed red, skipped dashed), elapsed time, cost, iteration or item counters for containers. Clicking a node opens a side panel with tabs: Inputs, Outputs, Transcript (virtualized list of assistant text, tool_use with collapsible input, tool_result, subagent groups by `parent_tool_use_id`, thinking summaries if present), Diff (rendered patch, file list), Events.

### 5.3 Approvals

A modal/queue item per approval: for `tool_permission` show tool name, formatted input (Bash command in a code block, Edit as a mini diff), the node's prompt excerpt, Allow / Allow for this run / Allow always (writes rule) / Deny with reason. For `gate` render the configured `show` items (markdown, JSON, diff) and an optional editable payload; Approve / Reject with comment. Desktop notification when an approval is created and the window is not focused.

### 5.4 Editor state

Zustand store `useEditorStore`: `document`, `selection`, `dirty`, `diagnostics`, `history` (undo stack of document snapshots via `zundo` or manual), `viewport`. Save writes through `PUT /workflows/:id`. Autosave every 10 s when dirty and valid-or-warning.

Run state store `useRunStore`: per run, projection updated from WS events; derived selectors for node status and cost.

### 5.5 Accessibility and keyboard

Delete/Backspace removes selection; Ctrl+Z/Y undo/redo; Ctrl+D duplicate; Ctrl+S save; Ctrl+Enter run; F2 rename; Space+drag pan; minimap toggle M. All inspector controls labelled; color status also conveyed by icon.

---

## 6. Desktop shell (`packages/desktop`) and CLI

Desktop:
- On launch: generate 32-byte token; spawn `engine` (bundled as an asar-unpacked Node entry, run with Electron's Node via `ELECTRON_RUN_AS_NODE=1` or `utilityProcess.fork`); wait for `/health`; load UI with token injected via preload.
- IPC: `secrets:get/set/delete/list` (safeStorage), `dialog:openDirectory`, `notify:show`, `shell:openExternal`, `app:version`.
- Single instance lock; tray optional; auto-update via electron-builder publish config (later).
- Packaging: electron-builder targets nsis (Windows), dmg (macOS), AppImage and deb (Linux). Bundle `@anthropic-ai/claude-agent-sdk` (it ships the Claude Code binary per platform; verify the asar-unpack globs so the binary remains executable; on Windows verify the `.exe` path resolution via `pathToClaudeCodeExecutable` if needed).

CLI (`orca`):
- `orca validate <file>`; `orca run <file|id> [--input k=v]... [--wait] [--json]` (prints run id, streams events to stderr, exits non-zero on failure; approvals auto-denied unless `--approve-all` or `--approve-gates` flags; intended for unattended workflows); `orca resume <runId>`; `orca export <file> --format claude-workflow` (v2).
- Uses `createEngine` in-process with `dataDir` default and no HTTP server unless `--serve`.

---

## 7. Claude Agent SDK adapter (primary) — **VERIFY every identifier against sdk.d.ts**

### 7.1 Adapter interface (engine-internal, adapter-agnostic)

```ts
interface AgentAdapter {
  id: 'copilot' | 'claude-sdk' | 'claude-cli';
  run(spec: AgentRunSpec, hooks: AdapterHooks): AgentHandle;
}
interface AgentRunSpec {
  prompt: string; system: { mode: 'preset'; append?: string } | { mode: 'custom'; text: string };
  model: string; effort?: Effort; cwd: string; additionalDirectories?: string[];
  permissionMode: PermissionMode; allowedTools: string[]; disallowedTools: string[];
  mcpServers: Record<string, McpServerConfigResolved>; agents: Record<string, AgentDefinition>;
  plugins: string[]; settingSources: ('user'|'project'|'local')[];
  outputSchema?: JSONSchema; maxTurns: number; maxBudgetUsd: number; timeoutMs: number;
  subagentLimits: { depth: number; concurrency: number };
  session: { mode: 'fresh' } | { mode: 'resume'|'fork'; sessionId: string };
  fileCheckpointing: boolean; includePartialMessages: boolean; env: Record<string,string>;
}
interface AdapterHooks {
  onMessage(msg: unknown /* raw SDK message */): void;
  canUseTool(toolName: string, input: unknown, meta: { toolUseId?: string; suggestions?: unknown }): Promise<PermissionDecision>;
  preToolUse(input: PreToolUseInput): Promise<'allow'|'deny'|'pass'>;   // engine hard-deny list + audit
  onCost(costUsd: number, usage: unknown): void;
}
interface AgentHandle {
  result: Promise<AgentResult>;
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  rewindFiles?(checkpointUuid: string): Promise<unknown>;
}
interface AgentResult {
  subtype: 'success'|'error_max_turns'|'error_max_budget_usd'|'error_during_execution'|'error_max_structured_output_retries'|string;
  text?: string; structured?: unknown; sessionId: string; costUsd: number; numTurns: number; durationMs: number;
  usage: unknown; modelUsage?: unknown; stopReason: string | null; firstUserMessageUuid?: string;
}
```

### 7.2 Mapping to `query()`

```ts
import { query, type Options, type SDKMessage, type HookCallback, type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

const abort = new AbortController();
const options: Options = {
  cwd: spec.cwd,
  additionalDirectories: spec.additionalDirectories,
  model: spec.model,
  effort: spec.effort,
  permissionMode: spec.permissionMode,
  allowDangerouslySkipPermissions: spec.permissionMode === 'bypassPermissions', // TS SDK requires this flag with bypassPermissions
  allowedTools: spec.allowedTools,
  disallowedTools: spec.disallowedTools,
  settingSources: spec.settingSources,
  systemPrompt: spec.system.mode === 'preset'
    ? { type: 'preset', preset: 'claude_code', append: spec.system.append }   // VERIFY shape
    : spec.system.text,
  mcpServers: spec.mcpServers,
  agents: spec.agents,
  plugins: spec.plugins.map(path => ({ type: 'local', path })),              // VERIFY SdkPluginConfig shape
  outputFormat: spec.outputSchema ? { type: 'json_schema', schema: spec.outputSchema } : undefined,
  maxTurns: spec.maxTurns,
  maxBudgetUsd: spec.maxBudgetUsd,
  includePartialMessages: spec.includePartialMessages,
  enableFileCheckpointing: spec.fileCheckpointing,
  extraArgs: spec.fileCheckpointing ? { 'replay-user-messages': null } : undefined,
  abortController: abort,
  env: {
    ...process.env,                                                           // TS SDK REPLACES the env; must spread
    ...spec.env,
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(spec.subagentLimits.depth),
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(spec.subagentLimits.concurrency),
  },
  resume: spec.session.mode !== 'fresh' ? spec.session.sessionId : undefined,
  forkSession: spec.session.mode === 'fork' ? true : undefined,
  canUseTool: async (toolName, input, ctx) => { /* see 7.4 */ },
  hooks: {
    PreToolUse: [{ hooks: [preToolUseHook] }],
    PostToolUse: [{ hooks: [postToolUseHook] }],
    Stop: [{ hooks: [stopHook] }],
    SubagentStop: [{ hooks: [subagentStopHook] }],
  },
};
const q = query({ prompt: spec.prompt, options });
```

Notes:
- `agent.judge` nodes set `permissionMode: 'dontAsk'`; with `dontAsk`, `canUseTool` is never invoked.
- When the node wants to ask the user questions (plan mode), `AskUserQuestion` arrives through `canUseTool` with `toolName === 'AskUserQuestion'`; the broker renders it as an approval of kind `question` and returns `{ behavior: 'allow', updatedInput: { ...input, answers } }` (**VERIFY** the answer shape in the SDK user-input docs before implementing; defer to M3).
- Timeouts: a wall-clock timer calls `abort.abort()` then `q.interrupt()`; result subtype becomes `error_during_execution`; node retry policy applies.

### 7.3 Consuming the stream

```ts
for await (const msg of q) {
  hooks.onMessage(msg);                               // persisted to transcripts (redacted)
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') { sessionId = msg.session_id; mcpStatuses = msg.mcp_servers; tools = msg.tools; }
      break;
    case 'assistant':                                  // msg.message.content[] blocks; msg.parent_tool_use_id for subagents
      for (const block of msg.message.content) {
        if (block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')) emit subagent spawn
        if (block.type === 'text') appendText(block.text)
      }
      break;
    case 'user':                                       // tool results; msg.uuid is a file checkpoint when replay-user-messages is on
      if (msg.uuid && !firstUserUuid) firstUserUuid = msg.uuid;
      break;
    case 'stream_event':                               // only with includePartialMessages; forward deltas for live typing
      break;
    case 'result':
      result = { subtype: msg.subtype, text: msg.subtype === 'success' ? msg.result : undefined,
                 structured: (msg as any).structured_output,            // VERIFY field name
                 sessionId: msg.session_id, costUsd: msg.total_cost_usd, numTurns: msg.num_turns,
                 durationMs: msg.duration_ms, usage: msg.usage, modelUsage: (msg as any).modelUsage, stopReason: msg.stop_reason };
      break;
  }
}
```
A single-shot `query()` **throws after yielding an error result** (for example when `maxTurns` is hit). Wrap the loop in try/catch; if `result` was already captured, treat the throw as informational. Iterate to completion rather than breaking on `result` (trailing system events may follow).

Outputs mapping: `text` <- result text; `json` <- `structured` (validated against `outputSchema` with Ajv; mismatch -> failure `schema_invalid`); `files_changed` and `diff` <- worktree manager (`isolation: worktree`) or from `PostToolUse` hook records of `Edit/Write/NotebookEdit` paths (`isolation: none`); `cost_usd`, `session_id`, `num_turns`, `result_subtype` direct.

### 7.4 `canUseTool` and hooks

```ts
// VERIFY: CanUseTool signature and PermissionResult shape in sdk.d.ts.
// Expected: (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; suggestions?: PermissionUpdate[]; toolUseID?: string })
//   => Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] } | { behavior: 'deny'; message: string; interrupt?: boolean }>
canUseTool: async (toolName, input, { signal, suggestions, toolUseID }) => {
  const d = await hooks.canUseTool(toolName, input, { toolUseId: toolUseID, suggestions });
  return d.allow ? { behavior: 'allow', updatedInput: d.updatedInput ?? input }
                 : { behavior: 'deny', message: d.reason, interrupt: d.interruptRun ?? false };
}

const preToolUseHook: HookCallback = async (input, toolUseID, { signal }) => {
  const i = input as PreToolUseHookInput;               // fields: tool_name, tool_input, session_id, cwd, agent_id?, agent_type?
  const verdict = await hooks.preToolUse(i);
  if (verdict === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Blocked by Orca policy' } };
  return {};
};
const postToolUseHook: HookCallback = async (input) => { record tool_name, tool_input, tool_response for files_changed; return {}; };
const stopHook: HookCallback = async () => ({});          // hook point for future "verify before stop" logic
const subagentStopHook: HookCallback = async (input) => { record agent_id/agent_type completion; return {}; };
```
Hooks for all matching matchers run in parallel; the most restrictive decision wins. Hook callbacks must be fast; offload logging.

### 7.5 MCP server config resolution

Node `mcpServers` entries by name resolve from `settings.mcpServers`; inline entries are used as-is. Before passing to the SDK, substitute `${SECRET:name}` in `env` and `headers`. For presets:

```ts
const presets = {
  github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${SECRET:GITHUB_TOKEN}' } },
  atlassian: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/sse'] },  // VERIFY current Atlassian MCP URL from github.com/atlassian/atlassian-mcp-server; bridge handles OAuth in a browser on first use
  filesystem: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${CWD}'] },
  playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
};
```
`${CWD}` expands to the node's `cwd`. MCP tool names are `mcp__<server>__<tool>`; the inspector offers `mcp__<server>__*` as a one-click allow rule. After `init`, servers with status `failed` or `needs-auth` produce a `node.progress` warning; `pending` is not an error.

### 7.6 Sessions

- `session.mode: 'resume'|'fork'` reads `session_id` from the referenced upstream node's outputs and passes `resume` (and `forkSession: true` for fork). The `cwd` must match the original run's cwd for the session file to be found in `~/.claude/projects/<encoded-cwd>/`; since worktrees have different paths, resume across nodes requires both nodes to share the same cwd (validate: warn otherwise).
- `persistSession` stays default `true` so transcripts exist for resume; retention is Claude Code's `cleanupPeriodDays`.

### 7.7 Cost accounting

Prefer `result.modelUsage` (whole tree including subagents) when present; fall back to `total_cost_usd`. Emit `agent.cost` on result. The scheduler adds it to `run.costUsd` and refuses to dispatch further agent nodes once `runBudgetUsd` is reached (in-flight nodes finish because the SDK enforces their own `maxBudgetUsd`).

---

## 7B. GitHub Copilot SDK adapter (primary for v1) — **VERIFY against `@github/copilot-sdk` types (pinned 1.0.x)**

Package `@github/copilot-sdk` (Node ^20.19 || >=22.12). The SDK spawns the bundled Copilot CLI (`@github/copilot-sdk-<platform>`) in server mode and talks JSON-RPC; `COPILOT_CLI_PATH` points at an existing install instead. The CLI enforces the org's Copilot policies (auth, model allow-list, MCP) before anything runs.

### 7B.1 Authentication

Resolution order inside the SDK: explicit `gitHubToken` option -> Copilot API env auth -> `COPILOT_GITHUB_TOKEN` -> `GH_TOKEN` -> `GITHUB_TOKEN` -> stored `copilot login` credential -> `gh auth` credential. Accepted token kinds: `gho_` (OAuth user), `ghu_` (GitHub App user), `github_pat_` (fine-grained). Classic `ghp_` is rejected. Server-to-server (deployed Orca, v2): GitHub App with **Copilot Requests: Read & write**, installation token `ghs_` (1 h expiry) passed via `COPILOT_GITHUB_TOKEN` with `useLoggedInUser: false`; requires org policy "Allow use of Copilot CLI billed to the organization"; usage bills to the org.

Engine behavior:
- `orca auth login`: runs the bundled CLI's `login` (device-code flow) so the credential lands in the system keychain; `orca auth status`: constructs `CopilotClient`, calls `listModels()`, reports identity and allowed models, and surfaces policy errors verbatim.
- Engine settings `copilot.auth`: `{ mode: 'logged-in-user' }` (default) | `{ mode: 'token', secretRef }` | `{ mode: 'github-app', appId, installationId, privateKeySecretRef }` (v2).

### 7B.2 Client and session lifecycle

One `CopilotClient` per engine process (`await client.start()`); one session per agent node execution.

```ts
import { CopilotClient, defineTool } from '@github/copilot-sdk';
import { z } from 'zod';

const client = new CopilotClient({ useLoggedInUser: true, logLevel: 'warning', workingDirectory: spec.cwd });
await client.start();

const session = await client.createSession({
  model: spec.model,                                        // from listModels(); validate before run
  streaming: true,
  workingDirectory: spec.cwd,
  systemMessage: spec.system.mode === 'preset'
    ? { mode: 'append', content: spec.system.append ?? '' }  // VERIFY field names
    : { mode: 'replace', content: spec.system.text },
  mcpServers: toCopilotMcpConfig(spec.mcpServers),          // VERIFY shape; tool names become `<server-key>-<tool>`
  customAgents: toCustomAgents(spec.agents),                // VERIFY shape
  tools: spec.outputSchema ? [submitResultTool(spec.outputSchema)] : [],
  infiniteSessions: { enabled: true },
  onPermissionRequest: async (request, invocation) => broker.decide(request, invocation), // 7B.4
  hooks: {
    onPreToolUse: async (input) => policy.preToolUse(input),   // hard-deny list + audit; return deny/allow per SDK contract
    onPostToolUse: async (input) => recorder.postToolUse(input),
    onPostToolUseFailure: async (input) => recorder.failure(input),
    onAgentStop: async (input) => judgeNudge(input),            // Judge: if submit_result not called, return { decision: 'block', reason } once
    onErrorOccurred: async (e) => ({ strategy: 'abort' }),      // VERIFY return shape
  },
});
```

Events consumed (`session.on(...)`): `assistant.message_delta` (live text), `assistant.message` (final text per turn), `tool.execution_start` / `tool.execution_complete` (transcript, tool-call counter, files-changed tracking for `write` kinds), `session.compaction_start/complete` (informational), `session.idle` (turn complete), `session.updated`. Persist every event as a transcript row with `kind = event.type`.

Run: `const done = await session.sendAndWait({ prompt: spec.prompt }, { timeout: spec.timeoutMs })` (**VERIFY** timeout option) or `send()` + wait for `session.idle`. Multi-turn nudging (Judge retry, budget warnings) uses additional `send()` calls on the same session. Capture `session.sessionId` (**VERIFY** property) for `session_id` output; resume via `client.resumeSession(sessionId, config)`.

Teardown: `await session.disconnect()`; on engine shutdown `await client.stop()`.

### 7B.3 Structured output (Judge)

No `outputFormat` exists. Define `submit_result` with `defineTool('submit_result', { description: 'Submit the final structured result. Call exactly once.', parameters: zodFromJsonSchema(spec.outputSchema), handler: async (args) => { captured = args; return 'Result recorded.'; } })`. Prompt suffix instructs the agent to finish by calling it. If the session goes idle without a capture, `onAgentStop` returns `{ decision: 'block', reason: 'Call submit_result with the final JSON.' }` once; a second miss fails the node with `schema_invalid`. Validate `captured` against the schema with Ajv before emitting `json`.

### 7B.4 Permission mapping

Copilot `onPermissionRequest(request, invocation)` where `request.kind` is one of `shell | write | read | mcp | custom-tool | url | memory | hook`, with `toolCallId`, `toolName`, `fileName`, `fullCommandText`, `managedApprovalRequired`. Decision results: `approve-once | approve-for-session | approve-for-location | approve-permanently | reject | user-not-available | no-result`.

Mapping from Orca node policy:
| Orca setting | Copilot behavior |
|---|---|
| `allowedTools` rules like `Bash(npm *)` | Engine matches `request.kind === 'shell'` and `fullCommandText` against the glob; `Edit(path)` rules match `write` with `fileName`; `mcp__server__*` matches `mcp` by server key |
| `approval.autoAllowReadOnly` | `read` and read-only `mcp` tools -> `approve-once` |
| `permissionMode: acceptEdits` | `write` inside `cwd` -> `approve-once`; shell still evaluated |
| `permissionMode: dontAsk` | Unresolved -> `reject` with feedback |
| `permissionMode: bypassPermissions` | Everything except hard-deny -> `approve-for-session` |
| `permissionMode: plan` | `write`/`shell` -> `reject` with feedback "planning only" |
| Unresolved + `approval.onUnresolved: ask` | Create approval row, await UI; `remember: run` -> `approve-for-session` |
| Hard-deny list | `onPreToolUse` hook denies regardless of mode |

### 7B.5 Budgets and cost

Copilot bills premium requests per user turn, not USD. Engine counts: turns (`send` calls + agent-initiated continuations observed via `assistant.message`), tool calls (`tool.execution_start`), wall-clock. Caps: `maxPremiumRequests`, `maxToolCalls`, `timeoutMs`. On cap: `session.abort()` (**VERIFY** method; else `disconnect()`), result subtype `error_max_turns`. Cost unit abstraction: `cost: { unit: 'usd' | 'premium_requests'; amount: number }` on node outputs and run totals; the UI labels accordingly. Run-level `runBudgetUsd` applies only to USD adapters; a parallel `runBudgetPremiumRequests` (default 200) applies to Copilot.

### 7B.6 MCP naming normalization

Copilot exposes MCP tools as `<server-key>-<tool-name>`; Claude as `mcp__<server>__<tool>`. Orca canonical form in documents and UI: `mcp:<server>/<tool>`; each adapter maps on the way in and out. GitHub MCP is built into Copilot CLI; the preset for the Copilot adapter therefore adds no server and only maps allow rules.

### 7B.7 Things to confirm in the M0 spike (write results to `docs/decisions/0002-copilot-sdk-contract.md`)

- Exact `createSession` option names: `systemMessage` shape, `mcpServers` shape, `customAgents` shape, `hooks` return shapes, timeout handling on `sendAndWait`.
- Session id property and `resumeSession` signature.
- Whether `listModels()` returns a default flag and model multipliers.
- Event payload fields for `tool.execution_start/complete` (tool name, arguments, result, file paths).
- How the bundled CLI login is invoked programmatically on Windows (binary path under `node_modules/@github/copilot-sdk-win32-x64`).
- Any per-session `abort`/`cancel` method.

## 8. Claude Code CLI adapter (tertiary) — **VERIFY flags with `claude --help`**

Spawn: `claude -p <prompt> --output-format stream-json --verbose [--model M] [--permission-mode MODE] [--allowedTools "A,B"] [--disallowedTools ...] [--max-turns N] [--mcp-config <tmpfile.json>] [--resume <id> | --continue] [--fork-session] [--append-system-prompt <text> | --system-prompt <text>] [--add-dir <dir>] [--json-schema <schema>]` with `cwd`. Read stdout line-delimited JSON; message shapes mirror the SDK (`system/init`, `assistant`, `user`, `result`). Permission prompts in `-p` mode cannot be answered interactively; use `--permission-prompt-tool mcp__orca__approve` backed by a tiny stdio MCP server the engine launches, which forwards to the ApprovalBroker and returns the decision (Claude Code's documented mechanism for non-interactive permission prompting). If that proves fragile on Windows, restrict the CLI adapter to `acceptEdits`/`dontAsk`/`bypassPermissions` modes in v1 and document it.

Budget: `--max-budget-usd` if available; else enforce by parsing `total_cost_usd` on result only (no mid-run cap) and warn in UI.

---

## 9. Expression engine

- Library: `quickjs-emscripten` (WASM). One `QuickJSRuntime` per engine, a fresh `QuickJSContext` per evaluation (cheap), interrupt handler enforcing 50 ms, memory limit 16 MB.
- API: `evaluate(expr: string, ctx: ExprContext): unknown`, `render(template: string, ctx): string`, `callFunction(body: string, ctx): unknown`.
- Context injection: `JSON.stringify(ctx)` -> `context.evalCode('globalThis.__ctx = JSON.parse(...)')`, then define `inputs`, `nodes`, `item`, `index`, `iteration`, `run`, `env` as frozen globals. Shadow `Date.now`, `Math.random`, `new Date()` (no-arg) to throw `OrcaDeterminismError`. Expose safe helpers: `JSON`, `Math` (except random), `String`, `Array`, `Object`, `Number`, `RegExp`, `encodeURIComponent`, `atob/btoa`, plus `orca.json(x)`, `orca.lines(s)`, `orca.truncate(s, n)`.
- Template grammar: `{{` ... `}}` non-greedy; `\{{` escapes. Unresolved identifier -> `ReferenceError` surfaced as node failure with the template location.

---

## 10. Security requirements

- Engine binds `127.0.0.1` only; bearer token required; CORS disabled except for the packaged UI origin in dev.
- Hard-deny list (section 3.8) applied via `PreToolUse` hook, which runs before SDK permission evaluation and applies even in `bypassPermissions`.
- Path confinement for `Edit/Write`: deny if resolved path is outside `cwd` and not under `additionalDirectories`.
- Secrets: never in documents, events, transcripts, or logs (Redactor). `GET /secrets` returns names only.
- Workflow files are trusted input from the repo owner, but the compiler still refuses `bypassPermissions` unless `settings.unattended` and isolation are set.
- Claude Code scans subagent output for instruction-shaped patterns; the engine additionally wraps upstream node outputs injected into prompts in a clearly delimited block (`<orca-input name="...">...</orca-input>`) and instructs the model to treat it as data.

---

## 11. Testing strategy

- `shared`: schema round-trips; fixture workflows in `.orca/workflows/` parse and validate; compiler error cases table-driven.
- `engine`: scheduler tests with a `FakeAdapter` that yields scripted SDK-shaped messages (including `result` with error subtypes and a thrown error after it); loop/map/condition/gate/join semantics; crash-resume test (kill mid-run by aborting, reopen DB, assert completed nodes not re-run); replay-from-node invalidation; worktree manager against a temp git repo (Windows CI too); expression sandbox limits (infinite loop interrupted, `Date.now()` throws); redactor.
- SDK contract test (opt-in, needs API key, `pnpm test:live`): one real `query()` with `maxTurns: 2`, `model: 'claude-haiku-4-5'`, asserting init/result shapes and that `canUseTool` is invoked for a Bash call in `default` mode. Run this first in M2 to validate all **VERIFY** items.
- `ui`: node components render statuses; inspector forms validate; approval modal flows; Playwright: create workflow from template, run with FakeAdapter engine flag (`ORCA_FAKE_ADAPTER=1`), approve a gate, see completion.

---

## 12. Milestones with acceptance criteria

> Superseded by `docs/04-build-plan.md` (Copilot SDK first, browser UI first, vertical slice in M1, Electron in M5). The list below is the original ordering and is kept for reference.

M0 Scaffold (1 to 2 days): monorepo, packages, lint/test/build scripts, engine `GET /health`, UI shell loads, Electron spawns engine. Criteria: `pnpm -r build && pnpm -r test` green on Windows and Linux CI.

M1 Canvas + deterministic engine: shared schemas and compiler; canvas with palette, inspector, edges, containers; executors Shell, Condition, Loop, Join, Transform, ManualTrigger; run log, WS streaming, run view. Criteria: template `fix-until-green-fake` (Shell writes a counter file; Transform fakes a fix; Loop until exit 0, max 5) runs end to end, can be cancelled, and a killed engine resumes it with completed iterations not re-run.

M2 Claude Agent node: SDK adapter, transcripts, permission broker + approval UI, budgets, outputSchema + Judge, live contract test. Criteria: `fix-until-green` against a real repo with a failing unit test completes with exit 0 within budget; an approval prompt for a non-allowlisted Bash command appears in the UI and its decision is honored; `maxBudgetUsd` trip produces `error_max_budget_usd` visible in the UI.

M3 Isolation and review: worktree manager, Git node ops, diff viewer, Gate, Notify(desktop). Criteria: `issue-to-pr` template runs: planner in plan mode -> gate shows plan markdown -> implementer in worktree -> tests run inside that worktree -> gate shows diff -> commit + draft PR via `gh`; rejecting at the second gate removes the worktree.

M4 Scale-out and integrations: Map, Join multi-input, MCP inspect + presets, secrets UI, `action.mcp_tool`, Sub-workflow. Criteria: `parallel-review` runs 1 reviewer per changed file with concurrency 4 and a Judge merges findings; `action.mcp_tool` lists GitHub issues using a stored token without the token appearing in any log.

M5 Hardening and release: replay-from-node, schedule trigger, CLI `orca run`, installers, retention sweeps, docs. Criteria: nightly schedule fires while the app is open; `orca run` exits non-zero when a gate is auto-denied; installers produced for win/mac/linux by CI.

---

## 13. Bundled templates (ship in `templates/`)

1. `fix-until-green.workflow.json` — Shell(test) -> Loop{ Condition(exit!=0) -> Agent(fix, worktree off, acceptEdits, allow `Bash(npm test*)`) -> Shell(test) } until exit==0 max 5 -> Gate(diff) -> Git commit.
2. `issue-to-pr.workflow.json` — Manual(input: issue text or URL) -> Agent planner (plan mode, read-only, `outputSchema` {summary, steps[], files[]}) -> Gate(plan) -> Agent implementer (worktree) -> Shell tests in worktree -> Loop fix (max 3) -> Agent reviewer (read-only, Judge schema {approve:boolean, findings[]}) -> Condition(approve) -> Gate(diff+findings) -> Git commit -> Git pr.create(draft) -> Notify.
3. `parallel-review.workflow.json` — Shell(`git diff --name-only origin/main...HEAD`) -> Transform(lines) -> Map(concurrency 4){ Judge per file } -> Judge merge/rank -> Transform(markdown) -> Notify.
4. `tournament.workflow.json` — Manual(task) -> Map over 3 configs (model/prompt variants), isolationPerItem -> Judge picks best index -> Gate -> Git merge chosen worktree -> remove others.
5. `migration-fanout.workflow.json` — Shell(glob) -> Map(concurrency 3, isolationPerItem){ Agent migrate file -> Shell typecheck } -> Join -> Judge summary -> Gate -> Git pr per item (Map over results).
6. `nightly-hygiene.workflow.json` — Schedule(0 2 * * *) -> Agent audit (read-only, Judge schema) -> Condition(findings>0) -> Notify.

Each template includes `description`, required inputs, required secrets, and comments in `ui.notes`.

---

## 14. Decision log (ADRs to write as `docs/decisions/NNNN-*.md` during build)

0001 Pin Agent SDK version and record reconciled types. 0002 Electron over Tauri. 0003 QuickJS for expressions. 0004 Loop container instead of free back-edges. 0005 Event-sourced run log in SQLite. 0006 Worktree path and branch naming. 0007 Secrets provider strategy per platform. 0008 CLI adapter permission strategy.

---

## 15. VERIFY checklist (complete during M0/M2 before relying on these)

- [ ] `Options` fields: `systemPrompt` preset shape; `plugins` element shape; `settingSources` values; `allowDangerouslySkipPermissions`; `permissionPrompts`; `effort` values; `thinking` option shape.
- [ ] `SDKMessage` union: `system` init fields (`session_id`, `tools`, `mcp_servers[{name,status}]`, `model`); `assistant`/`user` wrappers (`message.content`, `parent_tool_use_id`, `uuid`); `result` fields (`subtype`, `result`, `structured_output`?, `total_cost_usd`, `usage`, `modelUsage`, `num_turns`, `duration_ms`, `session_id`, `stop_reason`, `permission_denials`?).
- [ ] `CanUseTool` signature and `PermissionResult` shape; `PermissionUpdate` shape for `updatedPermissions` and `suggestions`.
- [ ] `HookCallback`, `HookCallbackMatcher`, `PreToolUseHookInput`, `PostToolUseHookInput`, `SubagentStopHookInput`, `HookJSONOutput` (`hookSpecificOutput.permissionDecision` values incl. `defer`).
- [ ] `AgentDefinition` fields (description, prompt, tools, disallowedTools, model, skills, memory, mcpServers, maxTurns, background, effort, permissionMode).
- [ ] `McpServerConfig` variants and whether `type: 'stdio'` is required or inferred; `headers` support on `sse`/`http`.
- [ ] `Query` methods: `interrupt`, `setPermissionMode`, `setModel`, `rewindFiles`, `mcpServerStatus`, `reconnectMcpServer`, `getContextUsage`.
- [ ] Env var names for Bedrock/Vertex/Foundry routing and `CLAUDE_CODE_MAX_*` caps.
- [ ] `claude` CLI flags used by the CLI adapter, incl. `--permission-prompt-tool`, `--json-schema`, `--max-budget-usd`.
- [ ] Atlassian remote MCP URL and recommended OAuth bridge; GitHub remote MCP auth header form.
- [ ] Electron packaging of the SDK's bundled Claude Code binary on Windows (asar unpack, execute permission, path).
