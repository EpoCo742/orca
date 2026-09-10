import type { ApprovalRecord, RunDetail, RunProjection, RunSummary, WorkflowDocument } from '@orca/shared';
import { compileWorkflow } from '../compiler/compile.js';
import type { WorkflowStore } from '../workflows/store.js';
import type { EngineServices, NodeExecutor } from './context.js';
import { RunExecution } from './execution.js';

export class RunManager {
  private readonly executions = new Map<string, RunExecution>();

  constructor(
    private readonly services: EngineServices,
    private readonly executors: Map<string, NodeExecutor>,
    private readonly workflows: WorkflowStore,
  ) {}

  async startRun(args: { workflowId: string; inputs: Record<string, unknown>; trigger?: { type: string; nodeId?: string } }): Promise<{ runId: string }> {
    const detail = this.workflows.get(args.workflowId);
    if (!detail) throw new Error(`workflow not found: ${args.workflowId}`);
    return this.startFromDocument(detail.document, detail.path, args.inputs, args.trigger ?? { type: 'manual' });
  }

  async startFromDocument(
    workflow: WorkflowDocument,
    workflowPath: string,
    inputs: Record<string, unknown>,
    trigger: { type: string; nodeId?: string },
    opts: { parentRunId?: string } = {},
  ): Promise<{ runId: string }> {
    const compiled = compileWorkflow(workflow);
    if (!compiled.plan) {
      const errors = compiled.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
      throw new Error(`workflow has errors:\n${errors.join('\n')}`);
    }
    const { runId, projection } = this.services.store.createRun({ workflow, workflowPath, inputs, trigger, parentRunId: opts.parentRunId });
    const exec = new RunExecution({
      services: this.services,
      executors: this.executors,
      workflow,
      workflowPath,
      plan: compiled.plan,
      projection,
      onFinished: (id) => this.executions.delete(id),
    });
    this.executions.set(runId, exec);
    this.services.logger.info({ runId, workflow: workflow.name }, 'run started');
    await exec.start();
    return { runId };
  }

  cancel(runId: string): boolean {
    const exec = this.executions.get(runId);
    if (!exec) return false;
    this.services.approvals.expireForRun(runId, 'run cancelled');
    exec.cancel();
    return true;
  }

  /** Re-attach to runs that were in flight when the engine last stopped. */
  async resumeAll(): Promise<string[]> {
    const resumed: string[] = [];
    for (const runId of this.services.store.activeRunIds()) {
      if (this.executions.has(runId)) continue;
      const row = this.services.store.getRun(runId);
      const workflow = this.services.store.workflowSnapshot(runId);
      const projection = this.services.store.loadProjection(runId);
      if (!row || !workflow || !projection) continue;
      const compiled = compileWorkflow(workflow);
      if (!compiled.plan) {
        this.services.store.append(runId, { type: 'run.failed', error: 'workflow snapshot no longer compiles' });
        continue;
      }
      this.services.approvals.expireForRun(runId, 'engine restarted');
      const exec = new RunExecution({
        services: this.services,
        executors: this.executors,
        workflow,
        workflowPath: row.workflowPath,
        plan: compiled.plan,
        projection,
        onFinished: (id) => this.executions.delete(id),
      });
      this.executions.set(runId, exec);
      this.services.logger.info({ runId }, 'resuming run after restart');
      await exec.resume();
      resumed.push(runId);
    }
    return resumed;
  }

  projection(runId: string): RunProjection | undefined {
    return this.executions.get(runId)?.proj ?? this.services.store.loadProjection(runId);
  }

  detail(runId: string): RunDetail | undefined {
    const run = this.projection(runId);
    const workflow = this.services.store.workflowSnapshot(runId);
    if (!run || !workflow) return undefined;
    const approvals: ApprovalRecord[] = this.services.store.listApprovals({ runId });
    return { run, workflow, approvals };
  }

  list(filter: { workflowId?: string; status?: RunSummary['status']; limit?: number }): RunSummary[] {
    return this.services.store.listRuns(filter);
  }

  activeCount(): number {
    return this.executions.size;
  }

  /** Wait for a run to finish (tests, CLI). */
  async wait(runId: string, timeoutMs = 60_000): Promise<RunProjection> {
    const started = Date.now();
    for (;;) {
      const p = this.projection(runId);
      if (!p) throw new Error(`run not found: ${runId}`);
      if (p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled') return p;
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for run ${runId} (status ${p.status})`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}
