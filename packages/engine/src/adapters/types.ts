import type { CostAmount } from '@orca/shared';
import type { PermissionQuery } from './permissions.js';

export type AdapterId = 'copilot' | 'fake';

export interface AgentRunSpec {
  prompt: string;
  system: { mode: 'preset'; append?: string } | { mode: 'custom'; text: string };
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  agentMode?: 'interactive' | 'plan' | 'autopilot';
  /** JSON Schema; when set the adapter exposes a `submit_result` tool and returns `structured`. */
  outputSchema?: Record<string, unknown>;
  cwd: string;
  env: Record<string, string>;
  maxPremiumRequests: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export interface PermissionDecision {
  allow: boolean;
  reason: string;
  /** Remember for the rest of the session (adapter-level), when supported. */
  forSession?: boolean;
}

export interface AdapterHooks {
  /** Every raw adapter event, persisted as transcript rows. */
  onEvent(kind: string, payload: unknown, summary?: string): void;
  /** Called for every tool permission the runtime asks about. */
  onPermission(query: PermissionQuery, raw: unknown): Promise<PermissionDecision>;
  onSession(sessionId: string): void;
  onCost(cost: CostAmount): void;
  onProgress(text: string): void;
}

export type AgentResultSubtype = 'success' | 'error_max_turns' | 'error_max_tool_calls' | 'error_timeout' | 'error_cancelled' | 'error_during_execution';

export interface AgentResult {
  subtype: AgentResultSubtype;
  text: string;
  structured?: unknown;
  sessionId?: string;
  cost: CostAmount;
  numTurns: number;
  toolCalls: number;
  durationMs: number;
  error?: string;
}

export interface AgentAdapter {
  id: AdapterId;
  run(spec: AgentRunSpec, hooks: AdapterHooks, signal: AbortSignal): Promise<AgentResult>;
}
