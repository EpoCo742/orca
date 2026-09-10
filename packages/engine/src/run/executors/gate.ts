import type { GateConfig, GateRequest, GateShowRendered } from '@orca/shared';
import type { ExecContext, ExecResult, NodeExecutor } from '../context.js';

export const gateExecutor: NodeExecutor<GateConfig> = {
  type: 'control.gate',
  async execute(ctx: ExecContext<GateConfig>): Promise<ExecResult> {
    const items: GateShowRendered[] = [];
    for (const item of ctx.config.show) {
      let value: unknown;
      try {
        value = ctx.services.sandbox.evaluate(item.expression, ctx.exprCtx);
      } catch (err) {
        value = `(could not evaluate "${item.expression}": ${err instanceof Error ? err.message : String(err)})`;
      }
      items.push({ label: item.label, render: item.render, value });
    }
    const request: GateRequest = { kind: 'gate', title: ctx.config.title, instructions: ctx.config.instructions, items };
    ctx.emit({ type: 'notify', nodeId: ctx.node.node.id, scope: ctx.scope, title: `Approval needed: ${ctx.config.title}`, message: ctx.config.instructions, level: 'warning' });
    const decided = await ctx.services.approvals.requestGate({
      runId: ctx.runId,
      nodeId: ctx.node.node.id,
      scope: ctx.scope,
      request,
      timeoutSec: ctx.config.timeoutSec,
      onTimeout: ctx.config.onTimeout,
      signal: ctx.signal,
      emit: ctx.emit,
    });
    const approved = decided.status === 'approved' || (decided.status === 'timeout' && ctx.config.onTimeout === 'approve');
    return {
      outputs: { decision: approved ? 'approved' : 'rejected', comment: decided.response?.comment ?? '', decided_by: decided.decidedBy ?? '' },
      fired: [approved ? 'approved' : 'rejected', 'done'],
    };
  },
};
