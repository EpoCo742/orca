import { z } from 'zod';

export const RunStatus = z.enum(['queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatus>;

export const NodeStatus = z.enum(['pending', 'ready', 'running', 'waiting', 'completed', 'failed', 'skipped']);
export type NodeStatus = z.infer<typeof NodeStatus>;

export type ScopePath = string; // '' | 'loop_id[3]' | 'loop_id[3]/map_id[0]'

export interface CostAmount {
  unit: 'premium_requests' | 'usd';
  amount: number;
}

/** Everything the engine records about a run, in order. State is a projection of these. */
export type RunEvent =
  | { type: 'run.created'; workflowId: string; inputs: Record<string, unknown>; trigger: { type: string; nodeId?: string } }
  | { type: 'run.started' }
  | { type: 'run.status'; status: RunStatus }
  | { type: 'run.completed' }
  | { type: 'run.failed'; error: string }
  | { type: 'run.cancelled' }
  | { type: 'node.scheduled'; nodeId: string; scope: ScopePath }
  | { type: 'node.started'; nodeId: string; scope: ScopePath; attempt: number; inputsHash: string; resolvedConfig?: unknown }
  | { type: 'node.progress'; nodeId: string; scope: ScopePath; kind: 'stdout' | 'stderr' | 'summary' | 'warning'; text: string }
  | { type: 'node.completed'; nodeId: string; scope: ScopePath; attempt: number; outputs: Record<string, unknown>; fired: string[]; cost?: CostAmount }
  | { type: 'node.failed'; nodeId: string; scope: ScopePath; attempt: number; error: string; retryable: boolean }
  | { type: 'node.skipped'; nodeId: string; scope: ScopePath; reason: string }
  | { type: 'node.retry'; nodeId: string; scope: ScopePath; attempt: number; delayMs: number }
  | { type: 'loop.iteration'; nodeId: string; scope: ScopePath; index: number }
  | { type: 'loop.exit'; nodeId: string; scope: ScopePath; exitedBy: 'until' | 'max' | 'budget' | 'error'; iterations: number }
  | { type: 'approval.requested'; approvalId: string; nodeId: string; scope: ScopePath; kind: ApprovalKind }
  | { type: 'approval.decided'; approvalId: string; nodeId: string; scope: ScopePath; status: ApprovalStatus }
  | { type: 'agent.session'; nodeId: string; scope: ScopePath; sessionId: string }
  | { type: 'agent.cost'; nodeId: string; scope: ScopePath; cost: CostAmount }
  | { type: 'worktree.created'; nodeId: string; scope: ScopePath; ownerNodeId: string; path: string; branch: string }
  | { type: 'worktree.removed'; nodeId: string; scope: ScopePath; ownerNodeId: string; path: string; reason: string }
  | { type: 'notify'; nodeId: string; scope: ScopePath; title: string; message: string; level: 'info' | 'success' | 'warning' | 'error' };

export type RunEventType = RunEvent['type'];

export interface StoredRunEvent {
  seq: number;
  runId: string;
  ts: string;
  event: RunEvent;
}

export type ApprovalKind = 'tool_permission' | 'gate' | 'question';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout';

export interface ToolPermissionRequest {
  kind: 'tool_permission';
  toolKind: string; // shell | write | read | mcp | custom-tool | url | ...
  toolName?: string;
  summary: string;
  detail?: string;
  fileName?: string;
  command?: string;
  raw: unknown;
}

export interface GateShowRendered {
  label: string;
  render: 'text' | 'markdown' | 'json' | 'diff';
  value: unknown;
}

export interface GateRequest {
  kind: 'gate';
  title: string;
  instructions: string;
  items: GateShowRendered[];
}

export interface WorktreeRecord {
  id: string;
  runId: string;
  ownerNodeId: string;
  repoPath: string;
  path: string;
  branch: string;
  baseRef: string;
  status: 'active' | 'kept' | 'removed';
  createdAt: string;
  removedAt?: string;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  nodeId: string;
  scope: ScopePath;
  kind: ApprovalKind;
  status: ApprovalStatus;
  request: ToolPermissionRequest | GateRequest;
  response?: { comment?: string; remember?: 'none' | 'run' | 'workflow' };
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  expiresAt?: string;
}

/** One row of an agent transcript: a raw adapter event plus a normalized summary for the UI. */
export interface TranscriptRow {
  seq: number;
  runId: string;
  nodeId: string;
  scope: ScopePath;
  ts: string;
  kind: string; // adapter event type e.g. 'assistant.message', 'tool.execution_start'
  summary?: string;
  payload: unknown;
}

export interface NodeRunState {
  nodeId: string;
  scope: ScopePath;
  status: NodeStatus;
  attempt: number;
  outputs?: Record<string, unknown>;
  fired?: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  cost?: CostAmount;
}

export interface RunProjection {
  id: string;
  workflowId: string;
  status: RunStatus;
  inputs: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  cost: { premiumRequests: number; usd: number };
  nodes: Record<string, NodeRunState>; // key `${nodeId}@${scope}`
  iterations: Record<string, number>; // key `${loopId}@${scope}` -> current iteration index
  lastSeq: number;
}

export function nodeKey(nodeId: string, scope: ScopePath): string {
  return `${nodeId}@${scope}`;
}
export function parseNodeKey(key: string): { nodeId: string; scope: ScopePath } {
  const i = key.indexOf('@');
  return { nodeId: key.slice(0, i), scope: key.slice(i + 1) };
}
export function childScope(parentScope: ScopePath, containerId: string, index: number): ScopePath {
  const seg = `${containerId}[${index}]`;
  return parentScope ? `${parentScope}/${seg}` : seg;
}
