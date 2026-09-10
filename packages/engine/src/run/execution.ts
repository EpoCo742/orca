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
  type JoinConfig,
  type LoopConfig,
  type MapConfig,
  type NodeRunState,
  type RunEvent,
  type RunProjection,
  type WorkflowDocument,
} from '@orca/shared';
import type { ExecutionPlan, PlannedNode } from '../compiler/compile.js';
import { buildExprContext, NodeExecError, resolveRepoPath, type EngineServices, type ExecContext, type ExecResult, type NodeExecutor } from './context.js';

type Readiness = 'wait' | 'ready' | 'dead';
const TERMINAL = new Set(['completed', 'skipped', 'failed']);

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
 * Drives one run: readiness evaluation, dispatch, loop iterations, map fan-out, retries, failure, cancellation.
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
        if (def?.container) continue; // containers are re-derived from their children
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
      while (changed && guard++ < 2000) {
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
          if (this.advanceContainers()) changed = true;
          if (await this.dispatchReady()) changed = true;
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

  /** Scopes whose siblings may be scheduled: top level, plus the current iteration of each running loop and every item of each running map. */
  private activeScopes(): Array<{ scope: string; siblings: string[] }> {
    const out: Array<{ scope: string; siblings: string[] }> = [{ scope: '', siblings: this.deps.plan.topLevel }];
    for (const st of Object.values(this.proj.nodes)) {
      if (st.status !== 'running') continue;
      const pn = this.deps.plan.nodes.get(st.nodeId);
      if (!pn?.def.container) continue;
      const siblings = this.deps.plan.children.get(st.nodeId) ?? [];
      if (pn.def.container === 'loop') {
        const index = this.proj.iterations[nodeKey(st.nodeId, st.scope)];
        if (index !== undefined) out.push({ scope: childScope(st.scope, st.nodeId, index), siblings });
      } else {
        const items = this.proj.mapItems[nodeKey(st.nodeId, st.scope)] ?? [];
        for (let i = 0; i < items.length; i++) out.push({ scope: childScope(st.scope, st.nodeId, i), siblings });
      }
    }
    return out;
  }

  private readiness(nodeId: string, scope: string): Readiness {
    const edges = this.deps.plan.edgesByTarget.get(nodeId) ?? [];
    if (edges.length === 0) return 'ready';
    const pn = this.deps.plan.nodes.get(nodeId);
    const joinAll = pn?.def.type === 'control.join' && (pn.config as JoinConfig).mode === 'all';
    let anyLive = false;
    let allLive = true;
    for (const e of edges) {
      const src = this.state(e.from.node, scope);
      if (!src || !TERMINAL.has(src.status)) {
        if (joinAll) return 'wait';
        // join 'any' and ordinary nodes still wait for every source to settle so skips cascade correctly
        return 'wait';
      }
      let live = this.edgeLive(e, src);
      if (live && e.when) {
        try {
          live = Boolean(this.services.sandbox.evaluate(e.when, this.exprContext(scope)));
        } catch (err) {
          this.services.logger.warn({ edge: e.id, err: String(err) }, 'edge guard failed; treating as false');
          live = false;
        }
      }
      if (live) anyLive = true;
      else allLive = false;
    }
    if (joinAll) return allLive ? 'ready' : 'dead';
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

  private exprContext(scope: string, portInputs: Record<string, unknown> = {}) {
    return buildExprContext({ proj: this.proj, workflow: this.deps.workflow, scope, startedAt: this.startedAt, portInputs, env: this.envFor() });
  }

  /** Loops and maps whose children finished: exit, iterate, or complete. */
  private advanceContainers(): boolean {
    let changed = false;
    for (const st of Object.values(this.proj.nodes)) {
      if (st.status !== 'running') continue;
      const pn = this.deps.plan.nodes.get(st.nodeId);
      if (!pn?.def.container) continue;
      if (pn.def.container === 'loop' ? this.advanceLoop(pn, st) : this.advanceMap(pn, st)) changed = true;
    }
    return changed;
  }

  private childStates(pn: PlannedNode, scope: string): NodeRunState[] {
    return (this.deps.plan.children.get(pn.node.id) ?? []).map((c) => this.state(c, scope) ?? { nodeId: c, scope, status: 'pending', attempt: 0 });
  }

  private advanceLoop(pn: PlannedNode, st: NodeRunState): boolean {
    const index = this.proj.iterations[nodeKey(st.nodeId, st.scope)];
    if (index === undefined) return false;
    const cs = childScope(st.scope, st.nodeId, index);
    const states = this.childStates(pn, cs);
    if (!states.every((s) => TERMINAL.has(s.status))) return false;
    const cfg = pn.config as LoopConfig;
    const failedChild = states.find((s) => s.status === 'failed');
    if (failedChild) {
      this.emit({ type: 'loop.exit', nodeId: st.nodeId, scope: st.scope, exitedBy: 'error', iterations: index + 1 });
      this.emit({ type: 'node.failed', nodeId: st.nodeId, scope: st.scope, attempt: st.attempt, error: `body node ${failedChild.nodeId} failed: ${failedChild.error ?? ''}`, retryable: false });
      this.failedError = this.failedError ?? `loop ${st.nodeId} failed`;
      return true;
    }
    let exit = false;
    let exitedBy: 'until' | 'max' = 'max';
    try {
      if (Boolean(this.services.sandbox.evaluate(cfg.until, this.exprContext(cs)))) {
        exit = true;
        exitedBy = 'until';
      }
    } catch (err) {
      this.emit({ type: 'node.failed', nodeId: st.nodeId, scope: st.scope, attempt: st.attempt, error: `until expression failed: ${String(err)}`, retryable: false });
      this.failedError = this.failedError ?? `loop ${st.nodeId}: until expression failed`;
      return true;
    }
    if (!exit && index + 1 >= cfg.maxIterations) exit = true;
    if (exit) {
      const last: Record<string, unknown> = {};
      for (const s of states) if (s.status === 'completed' && s.outputs) last[s.nodeId] = s.outputs;
      this.emit({ type: 'loop.exit', nodeId: st.nodeId, scope: st.scope, exitedBy, iterations: index + 1 });
      this.emit({ type: 'node.completed', nodeId: st.nodeId, scope: st.scope, attempt: st.attempt, outputs: { last, iterations: index + 1, exited_by: exitedBy }, fired: ['done'] });
    } else {
      this.emit({ type: 'loop.iteration', nodeId: st.nodeId, scope: st.scope, index: index + 1 });
    }
    return true;
  }

  private advanceMap(pn: PlannedNode, st: NodeRunState): boolean {
    const key = nodeKey(st.nodeId, st.scope);
    const items = this.proj.mapItems[key];
    if (!items) return false;
    const cfg = pn.config as MapConfig;
    const perItem = items.map((_, i) => this.childStates(pn, childScope(st.scope, st.nodeId, i)));
    const anyFailed = perItem.some((states) => states.some((s) => s.status === 'failed'));
    if (cfg.failFast && anyFailed) {
      const prefix = `@${childScope(st.scope, st.nodeId, 0).replace(/\[0\]$/, '[')}`;
      for (const [k, ac] of this.running) if (k.includes(prefix)) ac.abort();
      // items not started yet are skipped so the map can settle
      for (let i = 0; i < items.length; i++) {
        const cs = childScope(st.scope, st.nodeId, i);
        for (const s of this.childStates(pn, cs)) if (s.status === 'pending' || s.status === 'ready') this.emit({ type: 'node.skipped', nodeId: s.nodeId, scope: cs, reason: 'map failFast' });
      }
    }
    if (!perItem.every((states) => states.every((s) => TERMINAL.has(s.status)))) return false;
    const results: unknown[] = [];
    let succeeded = 0;
    let failed = 0;
    for (const states of perItem) {
      const failedChild = states.find((s) => s.status === 'failed');
      if (failedChild) {
        failed++;
        results.push({ error: failedChild.error ?? 'failed', node: failedChild.nodeId });
      } else {
        succeeded++;
        const outputs: Record<string, unknown> = {};
        for (const s of states) if (s.status === 'completed' && s.outputs) outputs[s.nodeId] = s.outputs;
        results.push(outputs);
      }
    }
    this.emit({ type: 'map.completed', nodeId: st.nodeId, scope: st.scope, succeeded, failed });
    if (failed > 0 && !cfg.continueOnError) {
      this.emit({ type: 'node.failed', nodeId: st.nodeId, scope: st.scope, attempt: st.attempt, error: `${failed} of ${items.length} items failed`, retryable: false });
      this.failedError = this.failedError ?? `map ${st.nodeId}: ${failed} item(s) failed`;
      return true;
    }
    this.emit({ type: 'node.completed', nodeId: st.nodeId, scope: st.scope, attempt: st.attempt, outputs: { results, items, succeeded, failed }, fired: ['done'] });
    return true;
  }

  private async dispatchReady(): Promise<boolean> {
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
      if (!this.mapSlotAvailable(pn, st.scope)) continue;
      if (pn.def.container === 'loop') {
        this.emit({ type: 'node.started', nodeId: st.nodeId, scope: st.scope, attempt: st.attempt + 1, inputsHash: '' });
        this.emit({ type: 'loop.iteration', nodeId: st.nodeId, scope: st.scope, index: 0 });
        changed = true;
        continue;
      }
      if (pn.def.container === 'map') {
        const attempt = st.attempt + 1;
        this.emit({ type: 'node.started', nodeId: st.nodeId, scope: st.scope, attempt, inputsHash: '' });
        let items: unknown;
        try {
          items = this.services.sandbox.evaluate((pn.config as MapConfig).items, this.exprContext(st.scope));
        } catch (err) {
          this.emit({ type: 'node.failed', nodeId: st.nodeId, scope: st.scope, attempt, error: `items expression failed: ${String(err)}`, retryable: false });
          this.failedError = this.failedError ?? `map ${st.nodeId}: items expression failed`;
          changed = true;
          continue;
        }
        if (!Array.isArray(items)) {
          this.emit({ type: 'node.failed', nodeId: st.nodeId, scope: st.scope, attempt, error: 'items expression did not return an array', retryable: false });
          this.failedError = this.failedError ?? `map ${st.nodeId}: items is not an array`;
          changed = true;
          continue;
        }
        if (items.length > 4096) {
          this.emit({ type: 'node.failed', nodeId: st.nodeId, scope: st.scope, attempt, error: `too many items (${items.length} > 4096)`, retryable: false });
          this.failedError = this.failedError ?? `map ${st.nodeId}: too many items`;
          changed = true;
          continue;
        }
        this.emit({ type: 'map.started', nodeId: st.nodeId, scope: st.scope, items });
        if (items.length === 0) this.emit({ type: 'node.completed', nodeId: st.nodeId, scope: st.scope, attempt, outputs: { results: [], items: [], succeeded: 0, failed: 0 }, fired: ['done'] });
        changed = true;
        continue;
      }
      this.dispatch(pn, st);
      changed = true;
    }
    return changed;
  }

  /** Map concurrency: a node in item scope `map[i]` may start if item i is already in progress or fewer than `concurrency` items are. */
  private mapSlotAvailable(pn: PlannedNode, scope: string): boolean {
    const parentId = pn.parent;
    if (!parentId) return true;
    const parent = this.deps.plan.nodes.get(parentId);
    if (parent?.def.container !== 'map') return true;
    const cfg = parent.config as MapConfig;
    const m = /^(.*?)\[(\d+)\]$/.exec(scope);
    if (!m) return true;
    const myIndex = Number(m[2]);
    const mapScope = scope.includes('/') ? scope.slice(0, scope.lastIndexOf('/')) : '';
    const items = this.proj.mapItems[nodeKey(parentId, mapScope)] ?? [];
    const children = this.deps.plan.children.get(parentId) ?? [];
    const inProgress = new Set<number>();
    for (let i = 0; i < items.length; i++) {
      const itemScope = childScope(mapScope, parentId, i);
      const states = children.map((c) => this.state(c, itemScope));
      const dispatched = children.some((c) => this.running.has(nodeKey(c, itemScope)));
      const started = dispatched || states.some((s) => s && s.status !== 'pending' && s.status !== 'ready');
      const done = !dispatched && states.every((s) => s && TERMINAL.has(s.status));
      if (started && !done) inProgress.add(i);
    }
    return inProgress.has(myIndex) || inProgress.size < cfg.concurrency;
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

  /** Worktree owner key for a node: map-item bodies get one worktree per item (`owner-<index>`). */
  private worktreeOwnerKey(owner: string, scope: string): string {
    const ownerNode = this.deps.plan.nodes.get(owner);
    const parent = ownerNode?.parent ? this.deps.plan.nodes.get(ownerNode.parent) : undefined;
    if (parent?.def.container === 'map') {
      const m = /\[(\d+)\]$/.exec(scope);
      if (m) return `${owner}-${m[1]}`;
    }
    return owner;
  }

  private async execute(pn: PlannedNode, scope: string, attempt: number, signal: AbortSignal): Promise<void> {
    const nodeId = pn.node.id;
    const portInputs = this.collectPortInputs(nodeId, scope);
    const exprCtx = this.exprContext(scope, portInputs);
    const config = this.renderConfig(pn, exprCtx);
    const inputsHash = createHash('sha256').update(JSON.stringify({ config, portInputs })).digest('hex').slice(0, 16);
    this.emit({ type: 'node.started', nodeId, scope, attempt, inputsHash, resolvedConfig: config });

    const executor = this.deps.executors.get(pn.def.type);
    if (!executor) throw new NodeExecError(`no executor for node type ${pn.def.type}`);
    const cfgAny = config as { cwdRelative?: string; worktreeOf?: string; isolation?: string };
    const owner = cfgAny.worktreeOf ?? (pn.def.category === 'agent' && cfgAny.isolation === 'worktree' ? nodeId : undefined);
    let baseDir = this.repoPath;
    if (owner) {
      const rec = await this.services.worktrees.ensure({
        runId: this.runId,
        ownerNodeId: this.worktreeOwnerKey(owner, scope),
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
      workflowPath: this.deps.workflowPath,
      projection: this.proj,
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
    if (result.cost && pn.def.category !== 'agent') this.emit({ type: 'agent.cost', nodeId, scope, cost: result.cost });
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
    const parent = pn.parent ? this.deps.plan.nodes.get(pn.parent) : undefined;
    // Map bodies never fail the run directly; the map node decides (continueOnError / failFast) once items settle.
    const insideMap = parent?.def.container === 'map';
    if (!hasErrorEdge && !insideMap && !this.failedError) {
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
      else if (v && typeof v === 'object') setPath(config, field, this.renderDeep(v, ctx));
    }
    return config;
  }

  private renderDeep(value: unknown, ctx: ReturnType<typeof buildExprContext>): unknown {
    if (typeof value === 'string') return this.services.sandbox.render(value, ctx);
    if (Array.isArray(value)) return value.map((v) => this.renderDeep(v, ctx));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.renderDeep(v, ctx);
      return out;
    }
    return value;
  }

  private envFor(): Record<string, string> {
    return { ...this.deps.workflow.settings.env };
  }
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
