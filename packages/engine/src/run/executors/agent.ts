import type { AgentCopilotConfig, McpServerConfig, ToolPermissionRequest } from '@orca/shared';
import { NodeExecError, type ExecContext, type ExecResult, type NodeExecutor } from '../context.js';
import { resolveDeep } from '../../secrets/resolve.js';
import { evaluatePolicy, parseRules, rememberRuleFor, type PermissionQuery } from '../../adapters/permissions.js';
import type { AdapterHooks, AgentRunSpec, PermissionDecision } from '../../adapters/types.js';

/** Runs one agent session through the configured adapter, routing permissions through the broker. */
export const agentExecutor: NodeExecutor<AgentCopilotConfig> = {
  type: 'agent.copilot',
  async execute(ctx: ExecContext<AgentCopilotConfig>): Promise<ExecResult> {
    const cfg = ctx.config;
    const adapter = ctx.services.adapters[cfg.adapter];
    if (!adapter) throw new NodeExecError(`agent adapter "${cfg.adapter}" is not available`);
    const settings = ctx.workflow.settings;
    const nodeId = ctx.node.node.id;
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const name of cfg.mcpServers) {
      const server = settings.mcpServers[name];
      if (!server) throw new NodeExecError(`MCP server "${name}" is not defined in workflow settings`);
      mcpServers[name] = resolveDeep(server, ctx.services.secrets, { cwd: ctx.cwd });
    }
    const spec: AgentRunSpec = {
      mcpServers,
      prompt: cfg.prompt,
      system: cfg.system,
      model: cfg.model ?? settings.defaultModel,
      effort: cfg.effort ?? settings.defaultEffort,
      agentMode: cfg.agentMode,
      outputSchema: cfg.outputSchema,
      cwd: ctx.cwd,
      env: { ...ctx.exprCtx.env, ...cfg.env },
      maxPremiumRequests: cfg.maxPremiumRequests,
      maxToolCalls: cfg.maxToolCalls,
      timeoutMs: cfg.timeoutMs,
    };
    const denyRules = parseRules(cfg.disallowedTools);

    const hooks: AdapterHooks = {
      onEvent: (kind, payload, summary) => ctx.transcript(kind, payload, summary),
      onSession: (sessionId) => ctx.emit({ type: 'agent.session', nodeId, scope: ctx.scope, sessionId }),
      onCost: (cost) => ctx.emit({ type: 'agent.cost', nodeId, scope: ctx.scope, cost }),
      onProgress: (text) => ctx.progress('summary', text),
      onPermission: async (query: PermissionQuery, raw: unknown): Promise<PermissionDecision> => {
        // Re-parse each time so "allow for this run" rules added mid-session take effect.
        const rules = parseRules([...cfg.allowedTools, ...ctx.runAllowRules]);
        const policy = evaluatePolicy(query, rules, denyRules, { autoAllowReadOnly: cfg.approval.autoAllowReadOnly, onUnresolved: cfg.approval.onUnresolved });
        ctx.transcript('orca.permission', { query, policy }, `${policy.decision}: ${policy.reason}`);
        if (policy.decision === 'allow') return { allow: true, reason: policy.reason };
        if (policy.decision === 'deny') return { allow: false, reason: policy.reason };
        const request: ToolPermissionRequest = {
          kind: 'tool_permission',
          toolKind: query.kind,
          summary: summarize(query),
          command: query.kind === 'shell' ? query.subject : undefined,
          fileName: query.kind === 'read' || query.kind === 'write' ? query.subject : undefined,
          detail: policy.reason,
          raw,
        };
        const decided = await ctx.services.approvals.requestToolPermission({
          runId: ctx.runId,
          nodeId,
          scope: ctx.scope,
          request,
          timeoutSec: cfg.approval.timeoutSec,
          onTimeout: cfg.approval.onTimeout,
          signal: ctx.signal,
          emit: ctx.emit,
        });
        if (decided.status === 'approved') {
          if (decided.response?.remember === 'run' || decided.response?.remember === 'workflow') {
            const rule = rememberRuleFor(query);
            if (rule && !ctx.runAllowRules.includes(rule)) ctx.runAllowRules.push(rule);
          }
          return { allow: true, reason: `approved by ${decided.decidedBy ?? 'user'}`, forSession: decided.response?.remember === 'run' };
        }
        if (decided.status === 'timeout' && cfg.approval.onTimeout === 'allow') return { allow: true, reason: 'approval timed out; policy allows' };
        return { allow: false, reason: decided.status === 'timeout' ? 'approval timed out' : `rejected by ${decided.decidedBy ?? 'user'}${decided.response?.comment ? `: ${decided.response.comment}` : ''}` };
      },
    };

    const result = await adapter.run(spec, hooks, ctx.signal);
    if (ctx.signal.aborted) throw new NodeExecError('cancelled', 'cancelled');

    const filesChanged = await ctx.services.worktrees.changedFiles(ctx.cwd).catch(() => [] as string[]);
    const structured = result.structured;
    const outputs: Record<string, unknown> = {
      text: result.text,
      json: structured ?? null,
      files_changed: filesChanged,
      cost: result.cost,
      session_id: result.sessionId ?? '',
      num_turns: result.numTurns,
      tool_calls: result.toolCalls,
      result_subtype: result.subtype,
    };
    if (structured && typeof structured === 'object') {
      const s = structured as Record<string, unknown>;
      if (typeof s.score === 'number') outputs.score = s.score;
      if (typeof s.verdict === 'string') outputs.verdict = s.verdict;
      if (typeof s.approve === 'boolean') outputs.approve = s.approve;
    }
    if (result.subtype === 'error_during_execution') throw new NodeExecError(result.error ?? 'agent failed', 'error');
    if (result.subtype === 'error_timeout') throw new NodeExecError(result.error ?? 'agent timed out', 'timeout');
    if (result.subtype === 'error_max_turns' || result.subtype === 'error_max_tool_calls') throw new NodeExecError(result.error ?? `agent hit its cap (${result.subtype})`, 'budget');
    if (cfg.outputSchema && structured === undefined) throw new NodeExecError('agent finished without calling submit_result', 'schema_invalid');
    return { outputs };
  },
};

function summarize(q: PermissionQuery): string {
  switch (q.kind) {
    case 'shell':
      return `Run command: ${q.subject ?? ''}`;
    case 'write':
      return `Write file: ${q.subject ?? ''}`;
    case 'read':
      return `Read: ${q.subject ?? ''}`;
    case 'mcp':
      return `Call MCP tool: ${q.subject ?? ''}`;
    case 'url':
      return `Fetch URL: ${q.subject ?? ''}`;
    default:
      return `Tool request (${q.kind}): ${q.subject ?? ''}`;
  }
}
