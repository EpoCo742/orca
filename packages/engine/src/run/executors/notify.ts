import type { NotifyConfig } from '@orca/shared';
import { NodeExecError, type ExecContext, type ExecResult, type NodeExecutor } from '../context.js';

export const notifyExecutor: NodeExecutor<NotifyConfig> = {
  type: 'action.notify',
  async execute(ctx: ExecContext<NotifyConfig>): Promise<ExecResult> {
    const cfg = ctx.config;
    if (cfg.channel === 'desktop') {
      ctx.emit({ type: 'notify', nodeId: ctx.node.node.id, scope: ctx.scope, title: cfg.title, message: cfg.message, level: cfg.level });
      return { outputs: { delivered: true } };
    }
    if (!cfg.url) throw new NodeExecError('webhook notify needs a url');
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: cfg.title, message: cfg.message, level: cfg.level, runId: ctx.runId, node: ctx.node.node.id, workflow: ctx.workflow.name }),
      signal: ctx.signal,
    });
    if (!res.ok) throw new NodeExecError(`webhook responded ${res.status}`);
    return { outputs: { delivered: true } };
  },
};
