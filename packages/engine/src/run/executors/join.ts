import type { JoinConfig } from '@orca/shared';
import { nodeKey } from '@orca/shared';
import type { ExecContext, ExecResult, NodeExecutor } from '../context.js';

/** Readiness (all vs any) is enforced by the scheduler; the executor just merges upstream outputs. */
export const joinExecutor: NodeExecutor<JoinConfig> = {
  type: 'control.join',
  async execute(ctx: ExecContext<JoinConfig>): Promise<ExecResult> {
    const merged: Record<string, unknown> = {};
    for (const e of ctx.plan.edgesByTarget.get(ctx.node.node.id) ?? []) {
      const src = ctx.projection.nodes[nodeKey(e.from.node, ctx.scope)];
      if (src?.status === 'completed' && src.outputs) merged[e.from.node] = src.outputs;
    }
    return { outputs: { merged } };
  },
};
