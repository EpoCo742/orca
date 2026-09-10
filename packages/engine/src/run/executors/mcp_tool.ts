import type { McpToolConfig } from '@orca/shared';
import { NodeExecError, type ExecContext, type ExecResult, type NodeExecutor } from '../context.js';
import { withMcp } from '../../mcp/client.js';
import { resolveDeep } from '../../secrets/resolve.js';

/** Calls one MCP tool deterministically, without a model in the loop. */
export const mcpToolExecutor: NodeExecutor<McpToolConfig> = {
  type: 'action.mcp_tool',
  async execute(ctx: ExecContext<McpToolConfig>): Promise<ExecResult> {
    const cfg = ctx.config;
    const server = ctx.workflow.settings.mcpServers[cfg.server];
    if (!server) throw new NodeExecError(`MCP server "${cfg.server}" is not defined in workflow settings`);
    const resolved = resolveDeep(server, ctx.services.secrets, { cwd: ctx.cwd });
    // args: strings are templates (already rendered by the scheduler for the `args` field), then secrets.
    const args = resolveDeep(cfg.args, ctx.services.secrets, { cwd: ctx.cwd });
    ctx.progress('summary', `mcp ${cfg.server}/${cfg.tool}`);
    const res = await withMcp(resolved, ctx.cwd, (c) => c.callTool(cfg.tool, args, cfg.timeoutMs));
    let result: unknown = res.structured;
    if (result === undefined) {
      try {
        result = JSON.parse(res.text);
      } catch {
        result = res.text;
      }
    }
    if (res.isError) throw new NodeExecError(`MCP tool error: ${res.text.slice(0, 500)}`);
    return { outputs: { result, text: res.text, is_error: res.isError } };
  },
};
