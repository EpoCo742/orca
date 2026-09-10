import path from 'node:path';
import fs from 'node:fs';
import { nodeKey, type CostAmount, type RunEvent, type RunProjection, type WorkflowDocument } from '@orca/shared';
import type { ExecutionPlan, PlannedNode } from '../compiler/compile.js';
import type { ExprContext, ExpressionSandbox } from '../expr/sandbox.js';
import type { ApprovalBroker } from '../approvals/broker.js';
import type { AgentAdapter, AdapterId } from '../adapters/types.js';
import type { RunStore } from './store.js';
import type { WorktreeManager } from './worktrees.js';
import type { Logger } from '../logger.js';

export interface EngineServices {
  store: RunStore;
  sandbox: ExpressionSandbox;
  approvals: ApprovalBroker;
  worktrees: WorktreeManager;
  adapters: Partial<Record<AdapterId, AgentAdapter>>;
  logger: Logger;
  /** Global cap on concurrently running agent sessions across all runs. */
  agentSlots: { max: number; used: number };
}

export interface ExecResult {
  outputs: Record<string, unknown>;
  fired?: string[];
  cost?: CostAmount;
}

export class NodeExecError extends Error {
  constructor(
    message: string,
    public readonly code: 'error' | 'timeout' | 'budget' | 'nonzero_exit' | 'schema_invalid' | 'cancelled' = 'error',
  ) {
    super(message);
    this.name = 'NodeExecError';
  }
}

export interface ExecContext<C = unknown> {
  runId: string;
  workflow: WorkflowDocument;
  plan: ExecutionPlan;
  node: PlannedNode;
  scope: string;
  attempt: number;
  /** Config with template fields rendered. */
  config: C;
  exprCtx: ExprContext;
  services: EngineServices;
  /** Working directory for this node (repo root plus cwdRelative). */
  cwd: string;
  signal: AbortSignal;
  emit(event: RunEvent): void;
  progress(kind: 'stdout' | 'stderr' | 'summary' | 'warning', text: string): void;
  transcript(kind: string, payload: unknown, summary?: string): void;
  /** Allow rules remembered for this run ("allow for this run"). */
  runAllowRules: string[];
}

export interface NodeExecutor<C = unknown> {
  type: string;
  execute(ctx: ExecContext<C>): Promise<ExecResult>;
}

/** Resolve the repository root a workflow acts on. */
export function resolveRepoPath(workflowPath: string, doc: WorkflowDocument): string {
  const dir = path.dirname(path.resolve(workflowPath));
  if (doc.settings.repoPath) return path.resolve(dir, doc.settings.repoPath);
  // <repo>/.orca/workflows/<file> -> <repo>
  const parts = dir.split(path.sep);
  const i = parts.lastIndexOf('.orca');
  if (i > 0 && parts[i + 1] === 'workflows') return parts.slice(0, i).join(path.sep);
  return dir;
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/** Build the expression context visible from a node at `scope`. */
export function buildExprContext(args: {
  proj: RunProjection;
  workflow: WorkflowDocument;
  scope: string;
  startedAt: string;
  portInputs: Record<string, unknown>;
  env: Record<string, string>;
}): ExprContext {
  const { proj, workflow, scope } = args;
  const nodes: Record<string, Record<string, unknown>> = {};
  for (const st of Object.values(proj.nodes)) {
    if (st.status !== 'completed' || !st.outputs) continue;
    if (st.scope === '' || st.scope === scope || scope.startsWith(st.scope + '/')) nodes[st.nodeId] = st.outputs;
  }
  let iteration: ExprContext['iteration'];
  if (scope) {
    const segs = scope.split('/');
    const last = segs[segs.length - 1]!;
    const m = /^([a-z][a-z0-9_]*)\[(\d+)\]$/.exec(last);
    if (m) {
      const loopId = m[1]!;
      const index = Number(m[2]);
      const parentScope = segs.slice(0, -1).join('/');
      const prevScope = parentScope ? `${parentScope}/${loopId}[${index - 1}]` : `${loopId}[${index - 1}]`;
      let previous: Record<string, Record<string, unknown>> | undefined;
      if (index > 0) {
        previous = {};
        for (const st of Object.values(proj.nodes)) if (st.scope === prevScope && st.status === 'completed' && st.outputs) previous[st.nodeId] = st.outputs;
      }
      iteration = { index, previous };
    }
  }
  const inputs: Record<string, unknown> = {};
  for (const def of workflow.inputs) if (def.default !== undefined) inputs[def.name] = def.default;
  Object.assign(inputs, proj.inputs, args.portInputs);
  return {
    inputs,
    nodes,
    iteration,
    run: { id: proj.id, startedAt: args.startedAt, workflow: { id: workflow.id, name: workflow.name } },
    env: args.env,
  };
}

export function stateKey(nodeId: string, scope: string): string {
  return nodeKey(nodeId, scope);
}
