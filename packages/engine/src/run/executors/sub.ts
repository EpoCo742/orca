import path from 'node:path';
import type { SubWorkflowConfig } from '@orca/shared';
import { NodeExecError, type ExecContext, type ExecResult, type NodeExecutor } from '../context.js';

/** Runs another workflow as a child run and waits for it. */
export const subWorkflowExecutor: NodeExecutor<SubWorkflowConfig> = {
  type: 'workflow.sub',
  async execute(ctx: ExecContext<SubWorkflowConfig>): Promise<ExecResult> {
    const { runs, workflows } = ctx.services;
    if (!runs || !workflows) throw new NodeExecError('sub-workflows are not available in this engine');
    const ref = ctx.config.workflowRef;
    const detail = ref.endsWith('.json') ? workflows.importFile(path.resolve(path.dirname(ctx.workflowPath), ref)) : workflows.get(ref);
    if (!detail) throw new NodeExecError(`sub-workflow not found: ${ref}`);
    if (detail.document.id === ctx.workflow.id) throw new NodeExecError('a workflow cannot run itself as a sub-workflow');
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx.config.inputs)) inputs[k] = ctx.services.sandbox.render(v, ctx.exprCtx);
    const { runId } = await runs.startFromDocument(detail.document, detail.path, inputs, { type: 'sub', nodeId: ctx.node.node.id }, { parentRunId: ctx.runId });
    ctx.progress('summary', `child run ${runId} (${detail.name})`);
    ctx.emit({ type: 'node.progress', nodeId: ctx.node.node.id, scope: ctx.scope, kind: 'summary', text: `child run ${runId}` });
    const onAbort = () => runs.cancel(runId);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const p = await runs.wait(runId, ctx.config.timeoutMs);
      const outputs: Record<string, unknown> = {};
      for (const st of Object.values(p.nodes)) if (st.scope === '' && st.status === 'completed' && st.outputs) outputs[st.nodeId] = st.outputs;
      const result = { outputs: { run_id: runId, status: p.status, outputs }, cost: p.cost.premiumRequests ? { unit: 'premium_requests' as const, amount: p.cost.premiumRequests } : undefined };
      if (p.status !== 'completed') throw new NodeExecError(`child run ${p.status}${p.error ? `: ${p.error}` : ''}`);
      return result;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  },
};
