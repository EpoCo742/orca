import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  applyRunEvent,
  childScope,
  getPath,
  nodeKey,
  nodeOutputs,
  setPath,
  type Edge,
  type LoopConfig,
  type NodeRunState,
  type RunEvent,
  type RunProjection,
  type WorkflowDocument,
} from '@orca/shared';
import type { ExecutionPlan, PlannedNode } from '../compiler/compile.js';
import { buildExprContext, NodeExecError, resolveRepoPath, type EngineServices, type ExecContext, type ExecResult, type NodeExecutor } from './context.js';

type Readiness = 'wait' | 'ready' | 'dead';

export interface RunExecutionDeps {
  services: EngineServices;
  executors: Map<string, NodeExecutor>;
  workflow: WorkflowDocument;
  workflowPath: string;
  plan: ExecutionPlan;
  projection: RunProjection;
  onFinished?: (runId: string) => void;
}

/**
 * Drives one run: readiness evaluation, dispatch, loop iterations, retries, failure, cancellation.
 * All state changes go through `emit`, which persists the event and applies it to the projection.
 */
export class RunExecution {
  readonly runId: string;
  readonly proj: RunProjection;
  private readonly running = new Map<string, AbortController>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private readonly runAllowRules: string[] = [];
  private failedError: string | undefined;
  private cancelled = false;
  private finished = false;
  private ticking = false;
  private tickAgain = false;
  private readonly repoPath: string;
  private readonly startedAt: string;

  constructor(private readonly deps: RunExecutionDeps) {
    this.proj = deps.projection;
    this.runId = this.proj.id;
    this.repoPath = resolveRepoPath(deps.workflowPath, deps.workflow);
    this.startedAt = this.proj.startedAt ?? new Date().toISOString();
  }

  get services(): EngineServices {
    return this.deps.services;
  }

  async start(): Promise<void> {
    if (this.proj.status === 'queued') this.emit({ type: 'run.started' });
    await this.tick();
  }

  /** Re-attach to a run after an engine restart: in-flight nodes are re-dispatched. */
  async resume(): Promise<void> {
    for (const st of Object.values(this.proj.nodes)) {
      if (st.status === 'running' || st.status === 'waiting') {
        const def = this.deps.plan.nodes.get(st.nodeId)?.def;
        if (def?.container) continue; // loops are re-derived from their children
        st.status = 'ready';
      }
    }
    if (this.proj.status === 'waiting') this.emit({ type: 'run.status', status: 'running' });
    await this.tick();
  }

  cancel(): void {
    if (this.finished) return;
    this.cancelled = true;
    for (const t of this.retryTimers) clearTimeout(t);
    for (const ac of this.running.values()) ac.abort();
    if (this.running.size === 0) this.finish();
  }

  private emit(event: RunEvent): void {
    const stored = this.services.store.append(this.runId, event);
    applyRunEvent(this.proj, stored);
  }

  // ---------------------------------------------------------------- scheduling
  private async tick(): Promise<void> {
    if (this.finished) return;
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      let changed = true;
      let guard = 0;
      while (changed && guard++ < 1000) {
        changed = false;
        if (!this.cancelled && !this.failedError) {
          for (const { scope, siblings } of this.activeScopes()) {
            for (const nodeId of siblings) {
              const st = this.state(nodeId, scope);
              if (st && st.status !== 'pending') continue;
              const r = this.readiness(nodeId, scope);
              if (r === 'ready') {
                this.emit({ type: 'node.scheduled', nodeId, scope });
                changed = true;
              } else if (r === 'dead') {
                this.emit({ type: 'node.skipped', nodeId, scope, reason: 'no live incoming edge' });
                changed = true;
              }
            }
          }
          if (this.advanceLoops()) changed = true;
          if (this.dispatchReady()) changed = true;
        }
      }
      this.checkTerminal();
    } finally {
      this.ticking = false;
      if (this.tickAgain) {
        this.tickAgain = false;
        void this.tick();
      }
    }
  }

  private state(nodeId: string, scope: string): NodeRunState | undefined {
    return this.proj.nodes[nodeKey(nodeId, scope)];
  }

  private activeScopes(): Array<{ scope: string; siblings: string[] }> {
    const out: Array<{ scope: string; siblings: string[] }> = [{ scope: '', siblings: this.deps.plan.topLevel }];
    for (const st of Object.values(this.proj.nodes)) {
      if (st.status !== 'running') continue;
      const pn = this.deps.plan.nodes.get(st.nodeId);
      if (!pn?.def.container) continue;
      const index = this.proj.iterations[nodeKey(st.nodeId, st.scope)];
      if (index === undefined) continue;
      out.push({ scope: childScope(st.scope, st.nodeId, index), siblings: this.deps.plan.children.get(st.nodeId) ?? [] });
    }
    return out;
  }

  private readiness(nodeId: string, scope: string): Readiness {
    const edges = this.deps.plan.edgesByTarget.get(nodeId) ?? [];
    if (edges.length === 0) return 'ready';
    let anyLive = false;
    for (const e of edges) {
      const src = this.state(e.from.node, scope);
      if (!src || src.status === 'pending' || src.status === 'ready' || src.status === 'running' || src.status === 'waiting') return 'wait';
      let live = this.edgeLive(e, src);
      if (live && e.when) {
        try {
          const ctx = buildExprContext({ proj: this.proj, workflow: this.deps.workflow, scope, startedAt: this.startedAt, portInputs: {}, env: this.envFor() });
          live = Boolean(this.services.sandbox.evaluate(e.when, ctx));
        } catch (err) {
          this.services.logger.warn({ edge: e.id, err: String(err) }, 'edge guard failed; treating as false');
          live = false;
        }
      }
      if (live) anyLive = true;
    }
    return anyLive ? 'ready' : 'dead';
  }

  private edgeLive(e: Edge, src: NodeRunState): boolean {
    const port = e.from.port;
    if (src.status === 'failed') return port === 'error';
    if (src.status !== 'completed') return false;
    if (port === 'error') return false;
    if (port === 'done') return true;
    if (src.fired?.includes(port)) return true;
    const def = this.deps.plan.nodes.get(src.nodeId)?.def;
    const decl = def ? nodeOutputs(def).find((p) => p.id === port) : undefined;
    return !!decl && decl.type !== 'trigger';
  }

  /** Loops whose current iteration finished: exit or start the next iteration. */
  private advanceLoops(): boolean {
    let changed = false;
    for (const st of Object.values(this.proj.nodes)) {
      if (st.status !== 'running') continue;
      const pn = this.deps.plan.nodes.get(st.nodeId);
      if (pn?.def.container !== 'loop') continue;
      const key = nodeKey(st.nodeId, st.scope);
      const index = this.proj.iterations[key];
      if (index === undefined) continue;
      const cs = childScope(st.scope, st.nodeId, index);
      const children = this.deps.plan.children.get(st.nodeId) ?? [];
      const states = children.map((c) => this.state(c, cs));
      const allTerminal = states.every((s) => s && (s.status === 'completed' || s.status === 'skipped' || s.status === 'failed'));
      if (!allTerminal) continue;
      const cfg = pn.config as LoopConfig;
      const failedChild = states.find((s) => s?.status === 'failed');
      if (failedChild) {
        this.emit({ type: 'loop.exit', nodeId: st.nodeId, scope: st.scope, exitedBy: 'error', iterations: index + 1 });
        this.emit({ type: 'node.failed', nodeId: st.nodeId, scope: st.scope, attempt: st.attempt, error: `body node ${failedChild.nodeId} failed: ${failedChild.error ?? ''}`, retryable: false });
        this.failedError = this.failedError ?? `loop ${st.nodeId} failed`;
        changed = true;
        continue;
      }
      let exit = false;
      let exitedBy: 'until' | 'max' = 'max';
      try {
        const ctx = buildExprContext({ proj: this.proj, workflow: this.deps.workflow, scope: cs, startedAt: this.startedAt, portInputs: {}, env: this.envFor() });
        if (Boolean(this.services.sandbox.evaluate(cfg.until, ctx))) {
          exit = true;
          exitedBy = 'until';
        }
      } catch (err) {
        this.emit({ type: 'node.failed', nodeId: st.nodeId, scope: st.scope, attempt: st.attempt, error: `until expression failed: ${String(err)}`, retryable: false });
        this.failedError = this.failedError ?? `loop ${st.nodeId}: until expression failed`;
        changed = true;
        continue;
      }
      if (!exit && index + 1 >= cfg.maxIterations) exit = true;
      if (exit) {
        const last: Record<string, unknown> = {};
        for (const c of children) {
          const s = this.state(c, cs);
          if (s?.status === 'completed' && s.outputs) last[c] = s.outputs;
        }
        this.emit({ type: 'loop.exit', nodeId: st.nodeId, scope: st.scope, exitedBy, iterations: index + 1 });
        this.emit({ type: 'node.completed', nodeId: st.nodeId, scope: st.scope, attempt: st.attempt, outputs: { last, iterations: index + 1, exited_by: exitedBy }, fired: ['done'] });
      } else {
        this.emit({ type: 'loop.iteration', nodeId: st.nodeId, scope: st.scope, index: index + 1 });
      }
      changed = true;
    }
    return changed;
  }

  private dispatchReady(): boolean {
    let changed = false;
    for (const st of Object.values(this.proj.nodes)) {
      if (st.status !== 'ready') continue;
      const pn = this.deps.plan.nodes.get(st.nodeId);
      if (!pn) continue;
      if (pn.def.category === 'agent') {
        const slots = this.services.agentSlots;
        const runningAgents = [...this.running.keys()].filter((k) => this.deps.plan.nodes.get(k.split('@')[0]!)?.def.category === 'agent').length;
        if (slots.used >= slots.max || runningAgents >= this.deps.workflow.settings.maxConcurrentAgents) continue;
      }
      if (pn.def.container === 'loop') {
        const attempt = st.attempt + 1;
        this.emit({ type: 'node.started', nodeId: st.nodeId, scope: st.scope, attempt, inputsHash: '' });
        this.emit({ type: 'loop.iteration', nodeId: st.nodeId, scope: st.scope, index: 0 });
        changed = true;
        continue;
      }
      this.dispatch(pn, st);
      changed = true;
    }
    return changed;
  }

  private dispatch(pn: PlannedNode, st: NodeRunState): void {
    const key = nodeKey(st.nodeId, st.scope);
    const ac = new AbortController();
    this.running.set(key, ac);
    const isAgent = pn.def.category === 'agent';
    if (isAgent) this.services.agentSlots.used++;
    const attempt = st.attempt + 1;
    void this.execute(pn, st.scope, attempt, ac.signal)
      .catch((err: unknown) => this.handleFailure(pn, st.scope, attempt, err))
      .finally(() => {
        this.running.delete(key);
        if (isAgent) this.services.agentSlots.used--;
        void this.tick();
      });
  }

  private async execute(pn: PlannedNode, scope: string, attempt: number, signal: AbortSignal): Promise<void> {
    const nodeId = pn.node.id;
    const portInputs = this.collectPortInputs(nodeId, scope);
    const env = this.envFor();
    const exprCtx = buildExprContext({ proj: this.proj, workflow: this.deps.workflow, scope, startedAt: this.startedAt, portInputs, env });
    const config = this.renderConfig(pn, exprCtx);
    const inputsHash = createHash('sha256').update(JSON.stringify({ config, portInputs })).digest('hex').slice(0, 16);
    this.emit({ type: 'node.started', nodeId, scope, attempt, inputsHash, resolvedConfig: redactConfig(config) });

    const executor = this.deps.executors.get(pn.def.type);
    if (!executor) throw new NodeExecError(`no executor for node type ${pn.def.type}`);
    const cfgAny = config as { cwdRelative?: string; worktreeOf?: string; isolation?: string };
    const worktreeOwner = cfgAny.worktreeOf ?? (pn.def.category === 'agent' && cfgAny.isolation === 'worktree' ? nodeId : undefined);
    let baseDir = this.repoPath;
    if (worktreeOwner) {
      const rec = await this.services.worktrees.ensure({
        runId: this.runId,
        ownerNodeId: worktreeOwner,
        repoPath: this.repoPath,
        workflowSlug: slugify(this.deps.workflow.name),
        settings: this.deps.workflow.settings.worktree,
        emit: (e) => this.emit(e),
        nodeId,
        scope,
      });
      baseDir = rec.path;
    }
    const cwd = cfgAny.cwdRelative ? path.resolve(baseDir, cfgAny.cwdRelative) : baseDir;
    const ctx: ExecContext = {
      runId: this.runId,
      workflow: this.deps.workflow,
      plan: this.deps.plan,
      node: pn,
      scope,
      attempt,
      config,
      exprCtx,
      services: this.services,
      cwd,
      signal,
      emit: (e) => this.emit(e),
      progress: (kind, text) => this.emit({ type: 'node.progress', nodeId, scope, kind, text }),
      transcript: (kind, payload, summary) => this.services.store.appendTranscript({ runId: this.runId, nodeId, scope, kind, payload, summary }),
      runAllowRules: this.runAllowRules,
    };
    let timer: NodeJS.Timeout | undefined;
    const timeoutMs = pn.node.timeoutMs;
    const timeoutPromise = new Promise<never>((_, reject) => {
      if (timeoutMs) timer = setTimeout(() => reject(new NodeExecError(`node timed out after ${timeoutMs} ms`, 'timeout')), timeoutMs);
    });
    let result: ExecResult;
    try {
      result = await Promise.race([executor.execute(ctx), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (signal.aborted) throw new NodeExecError('cancelled', 'cancelled');
    if (result.cost) this.emit({ type: 'agent.cost', nodeId, scope, cost: result.cost });
    this.emit({ type: 'node.completed', nodeId, scope, attempt, outputs: result.outputs, fired: result.fired ?? ['done'], cost: result.cost });
  }

  private handleFailure(pn: PlannedNode, scope: string, attempt: number, err: unknown): void {
    const nodeId = pn.node.id;
    const code = err instanceof NodeExecError ? err.code : 'error';
    const message = err instanceof Error ? err.message : String(err);
    if (this.cancelled || code === 'cancelled') {
      this.emit({ type: 'node.failed', nodeId, scope, attempt, error: 'cancelled', retryable: false });
      return;
    }
    const retry = pn.node.retry;
    const retryable = attempt < retry.maxAttempts && (retry.retryOn as string[]).includes(code);
    this.emit({ type: 'node.failed', nodeId, scope, attempt, error: message, retryable });
    if (retryable) {
      const delayMs = retry.backoffMs * Math.pow(2, attempt - 1);
      this.emit({ type: 'node.retry', nodeId, scope, attempt, delayMs });
      const t = setTimeout(() => {
        this.retryTimers.delete(t);
        void this.tick();
      }, delayMs);
      this.retryTimers.add(t);
      return;
    }
    const hasErrorEdge = (this.deps.plan.edgesBySource.get(nodeId) ?? []).some((e) => e.from.port === 'error');
    if (!hasErrorEdge && !this.failedError) {
      this.failedError = `${nodeId}: ${message}`;
      for (const [k, ac] of this.running) if (k !== nodeKey(nodeId, scope)) ac.abort();
    }
  }

  private checkTerminal(): void {
    if (this.finished) return;
    if (this.running.size > 0) return;
    const states = Object.values(this.proj.nodes);
    const active = states.some((s) => s.status === 'ready' || s.status === 'running' || s.status === 'waiting');
    if (active && !this.cancelled && !this.failedError) return;
    if (this.retryTimers.size > 0 && !this.cancelled && !this.failedError) return;
    this.finish();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const t of this.retryTimers) clearTimeout(t);
    if (this.cancelled) this.emit({ type: 'run.cancelled' });
    else if (this.failedError) this.emit({ type: 'run.failed', error: this.failedError });
    else this.emit({ type: 'run.completed' });
    this.deps.onFinished?.(this.runId);
  }

  // ---------------------------------------------------------------- helpers
  private collectPortInputs(nodeId: string, scope: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const e of this.deps.plan.edgesByTarget.get(nodeId) ?? []) {
      if (e.to.port === 'trigger') continue;
      const src = this.state(e.from.node, scope);
      if (src?.status === 'completed' && src.outputs) out[e.to.port] = src.outputs[e.from.port];
    }
    return out;
  }

  private renderConfig(pn: PlannedNode, ctx: ReturnType<typeof buildExprContext>): unknown {
    const config = structuredClone(pn.config) as Record<string, unknown>;
    for (const field of pn.def.templateFields ?? []) {
      const v = getPath(config, field);
      if (typeof v === 'string') setPath(config, field, this.services.sandbox.render(v, ctx));
    }
    return config;
  }

  private envFor(): Record<string, string> {
    return { ...this.deps.workflow.settings.env };
  }
}

function redactConfig(config: unknown): unknown {
  return config;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workflow'
  );
}
