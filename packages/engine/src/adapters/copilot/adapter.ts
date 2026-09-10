import type { CopilotClient, PermissionHandler, PermissionRequest, SessionEvent, SessionHooks } from '@github/copilot-sdk';
import type { Logger } from '../../logger.js';
import { hardDenyReason, type PermissionQuery } from '../permissions.js';
import type { AdapterHooks, AgentAdapter, AgentResult, AgentResultSubtype, AgentRunSpec } from '../types.js';

/**
 * Runs one agent node as a GitHub Copilot SDK session (see docs/decisions/0002-copilot-sdk-contract.md).
 * Premium requests are counted from `assistant.usage.cost`; tool calls from `tool.execution_start`.
 */
export class CopilotAdapter implements AgentAdapter {
  readonly id = 'copilot' as const;

  constructor(
    private readonly getClient: () => Promise<CopilotClient>,
    private readonly logger: Logger,
  ) {}

  async run(spec: AgentRunSpec, hooks: AdapterHooks, signal: AbortSignal): Promise<AgentResult> {
    const started = Date.now();
    const client = await this.getClient();
    let premiumRequests = 0;
    let toolCalls = 0;
    let modelCalls = 0;
    let stopReason: AgentResultSubtype | undefined;
    let stopError: string | undefined;
    let text = '';
    let lastAssistant = '';

    const onPermissionRequest: PermissionHandler = async (request) => {
      const query = toQuery(request);
      hooks.onEvent('permission.requested', request, describeQuery(query));
      const d = await hooks.onPermission(query, request);
      hooks.onEvent('permission.completed', { allow: d.allow, reason: d.reason }, `${d.allow ? 'approved' : 'rejected'}: ${d.reason}`);
      if (d.allow) return { kind: d.forSession ? 'approve-for-session' : 'approve-once' };
      return { kind: 'reject', feedback: d.reason };
    };

    const sessionHooks: SessionHooks = {
      onPreToolUse: (input) => {
        const args = input.toolArgs as { command?: string } | undefined;
        const query: PermissionQuery = isShellTool(input.toolName)
          ? { kind: 'shell', subject: args?.command ?? '' }
          : { kind: 'other', subject: input.toolName };
        const hard = hardDenyReason(query);
        if (hard) {
          hooks.onEvent('orca.hard_deny', { toolName: input.toolName, toolArgs: input.toolArgs, reason: hard }, hard);
          return { permissionDecision: 'deny', permissionDecisionReason: hard };
        }
        return undefined;
      },
      onErrorOccurred: (input) => {
        hooks.onEvent('session.error_hook', input, 'error');
        return undefined;
      },
    };

    const session = await client.createSession({
      model: spec.model,
      reasoningEffort: spec.effort,
      streaming: true,
      workingDirectory: spec.cwd,
      systemMessage:
        spec.system.mode === 'preset'
          ? spec.system.append
            ? { mode: 'append', content: spec.system.append }
            : undefined
          : { mode: 'replace', content: spec.system.text },
      onPermissionRequest,
      hooks: sessionHooks,
      infiniteSessions: { enabled: true },
      enableFileChangeTracking: true,
    });
    hooks.onSession(session.sessionId);

    const stop = async (reason: AgentResultSubtype, error: string) => {
      if (stopReason) return;
      stopReason = reason;
      stopError = error;
      hooks.onEvent('orca.stop', { reason, error }, error);
      try {
        await session.abort();
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'session.abort failed');
      }
    };

    const unsubscribe = session.on((event: SessionEvent) => {
      const data = event.data as Record<string, unknown> | undefined;
      const summary = summarizeEvent(event.type, data);
      if (!NOISY_EVENTS.has(event.type)) hooks.onEvent(event.type, data, summary);
      switch (event.type) {
        case 'assistant.usage': {
          modelCalls++;
          const cost = Number((data as { cost?: number } | undefined)?.cost ?? 1);
          premiumRequests += cost;
          hooks.onCost({ unit: 'premium_requests', amount: cost });
          if (premiumRequests >= spec.maxPremiumRequests) void stop('error_max_turns', `premium request cap reached (${spec.maxPremiumRequests})`);
          break;
        }
        case 'tool.execution_start':
          toolCalls++;
          hooks.onProgress(summary ?? event.type);
          if (toolCalls > spec.maxToolCalls) void stop('error_max_tool_calls', `tool call cap reached (${spec.maxToolCalls})`);
          break;
        case 'assistant.message': {
          const content = (data as { content?: string } | undefined)?.content;
          if (content) lastAssistant = content;
          break;
        }
        case 'session.error':
          this.logger.warn({ data }, 'copilot session error');
          break;
        default:
          break;
      }
    });

    const timer = setTimeout(() => void stop('error_timeout', `agent timed out after ${spec.timeoutMs} ms`), spec.timeoutMs);
    const onAbort = () => void stop('error_cancelled', 'cancelled');
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const final = await session.sendAndWait({ prompt: spec.prompt }, spec.timeoutMs + 10_000);
      text = (final?.data as { content?: string } | undefined)?.content ?? lastAssistant;
    } catch (err) {
      if (!stopReason) {
        stopReason = 'error_during_execution';
        stopError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      unsubscribe();
      await session.disconnect().catch(() => undefined);
    }

    if (!text) text = lastAssistant;
    return {
      subtype: stopReason ?? 'success',
      text,
      sessionId: session.sessionId,
      cost: { unit: 'premium_requests', amount: premiumRequests },
      numTurns: modelCalls,
      toolCalls,
      durationMs: Date.now() - started,
      error: stopError,
    };
  }
}

const NOISY_EVENTS = new Set(['assistant.streaming_delta', 'assistant.tool_call_delta', 'assistant.reasoning_delta', 'session.background_tasks_changed', 'pending_messages.modified']);

function isShellTool(name: string): boolean {
  return /^(shell|bash|powershell|cmd|sh|zsh)$/i.test(name);
}

export function toQuery(request: PermissionRequest): PermissionQuery {
  switch (request.kind) {
    case 'shell':
      return { kind: 'shell', subject: request.fullCommandText, readOnly: request.commands.length > 0 && request.commands.every((c) => c.readOnly) };
    case 'write':
      return { kind: 'write', subject: request.fileName };
    case 'read':
      return { kind: 'read', subject: request.path };
    case 'mcp':
      return { kind: 'mcp', subject: `${request.serverName}/${request.toolName}`, readOnly: request.readOnly };
    case 'url':
      return { kind: 'url', subject: request.url };
    default:
      return { kind: 'other', subject: (request as { toolName?: string }).toolName ?? request.kind };
  }
}

function describeQuery(q: PermissionQuery): string {
  return `${q.kind}: ${q.subject ?? ''}`;
}

function summarizeEvent(type: string, data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  switch (type) {
    case 'assistant.message':
      return truncate(String(data.content ?? ''), 200);
    case 'assistant.reasoning':
      return truncate(String(data.content ?? data.text ?? ''), 200);
    case 'tool.execution_start': {
      const args = data.arguments as Record<string, unknown> | undefined;
      const detail = args?.command ?? args?.path ?? args?.filePath ?? args?.description ?? '';
      return truncate(`${String(data.toolName ?? 'tool')} ${String(detail)}`, 200);
    }
    case 'tool.execution_complete': {
      const result = data.result as { content?: string } | undefined;
      return `${data.success === false ? 'failed' : 'ok'}${result?.content ? ': ' + truncate(String(result.content), 160) : ''}`;
    }
    case 'assistant.usage':
      return `in ${String(data.inputTokens)} out ${String(data.outputTokens)} cost ${String(data.cost)}`;
    case 'session.usage_info':
      return `context ${String(data.currentTokens)}/${String(data.tokenLimit)}`;
    case 'user.message':
      return truncate(String(data.content ?? ''), 200);
    default:
      return undefined;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}
