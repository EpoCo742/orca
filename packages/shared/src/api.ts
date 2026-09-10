import { z } from 'zod';
import { WorkflowDocument } from './schema/workflow.js';
import type { ApprovalRecord, RunProjection, StoredRunEvent, TranscriptRow } from './events.js';

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  path?: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  path: string;
  repoPath: string;
  updatedAt: string;
  contentHash: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  document: WorkflowDocument;
  diagnostics: Diagnostic[];
}

export const CreateWorkflowRequest = z.object({
  /** Directory of the target repository; the file is written to <repoPath>/.orca/workflows/<slug>.workflow.json */
  repoPath: z.string().min(1),
  document: WorkflowDocument,
});
export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequest>;

export const ImportWorkflowRequest = z.object({ path: z.string().min(1) });

export const SaveWorkflowRequest = z.object({ document: WorkflowDocument });

export const StartRunRequest = z.object({
  workflowId: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
});
export type StartRunRequest = z.infer<typeof StartRunRequest>;

export const DecideApprovalRequest = z.object({
  status: z.enum(['approved', 'rejected']),
  comment: z.string().optional(),
  remember: z.enum(['none', 'run', 'workflow']).default('none'),
  decidedBy: z.string().default('user'),
});
export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequest>;

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunProjection['status'];
  startedAt?: string;
  finishedAt?: string;
  cost: RunProjection['cost'];
  error?: string;
}

export interface RunDetail {
  run: RunProjection;
  workflow: WorkflowDocument;
  approvals: ApprovalRecord[];
}

/** WebSocket messages, server -> client. */
export type WsServerMessage =
  | { channel: 'run'; runId: string; event: StoredRunEvent }
  | { channel: 'transcript'; runId: string; row: TranscriptRow }
  | { channel: 'approval'; approval: ApprovalRecord }
  | { channel: 'hello'; engineVersion: string };

/** WebSocket messages, client -> server. */
export type WsClientMessage = { subscribe: { runId: string } } | { unsubscribe: { runId: string } };
