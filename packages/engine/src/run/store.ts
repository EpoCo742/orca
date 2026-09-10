import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  applyRunEvent,
  emptyProjection,
  type ApprovalRecord,
  type ApprovalStatus,
  type RunEvent,
  type RunProjection,
  type RunStatus,
  type RunSummary,
  type StoredRunEvent,
  type TranscriptRow,
  type WorkflowDocument,
} from '@orca/shared';
import { nowIso, type Database } from '../db/database.js';

export interface RunRow {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowHash: string;
  workflowPath: string;
  status: RunStatus;
  inputs: Record<string, unknown>;
  trigger: { type: string; nodeId?: string };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cost: { premiumRequests: number; usd: number };
  error?: string;
}

export interface RunStoreEvents {
  event: [StoredRunEvent];
  transcript: [TranscriptRow];
  approval: [ApprovalRecord];
}

export function hashDocument(doc: WorkflowDocument): string {
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 16);
}

/** Append-only run log plus the projections and side tables that hang off it. */
export class RunStore extends EventEmitter<RunStoreEvents> {
  /** Optional redaction applied to every persisted event and transcript row. */
  redactor: { redactJson<T>(v: T): T; redact(s: string): string } | undefined;

  constructor(private readonly db: Database) {
    super();
  }

  createRun(args: { workflow: WorkflowDocument; workflowPath: string; inputs: Record<string, unknown>; trigger: { type: string; nodeId?: string }; parentRunId?: string }): {
    runId: string;
    projection: RunProjection;
  } {
    const runId = crypto.randomUUID();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO runs (id, workflow_id, workflow_name, workflow_hash, workflow_snapshot, workflow_path, status, inputs, trigger, created_at, parent_run_id)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(runId, args.workflow.id, args.workflow.name, hashDocument(args.workflow), JSON.stringify(args.workflow), args.workflowPath, JSON.stringify(args.inputs), JSON.stringify(args.trigger), ts, args.parentRunId ?? null);
    const projection = emptyProjection(runId, args.workflow.id, args.inputs);
    const stored = this.append(runId, { type: 'run.created', workflowId: args.workflow.id, inputs: args.inputs, trigger: args.trigger });
    applyRunEvent(projection, stored);
    return { runId, projection };
  }

  append(runId: string, rawEvent: RunEvent): StoredRunEvent {
    const event = this.redactor ? this.redactor.redactJson(rawEvent) : rawEvent;
    const ts = nowIso();
    const nodeId = 'nodeId' in event ? event.nodeId : null;
    const scope = 'scope' in event ? event.scope : null;
    const info = this.db
      .prepare('INSERT INTO run_events (run_id, ts, type, node_id, scope, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, ts, event.type, nodeId, scope, JSON.stringify(event));
    const stored: StoredRunEvent = { seq: Number(info.lastInsertRowid), runId, ts, event };
    this.updateRunRow(runId, event, ts);
    this.emit('event', stored);
    return stored;
  }

  private updateRunRow(runId: string, event: RunEvent, ts: string): void {
    switch (event.type) {
      case 'run.started':
        this.db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=?").run(ts, runId);
        break;
      case 'run.status':
        this.db.prepare('UPDATE runs SET status=? WHERE id=?').run(event.status, runId);
        break;
      case 'run.completed':
        this.db.prepare("UPDATE runs SET status='completed', finished_at=? WHERE id=?").run(ts, runId);
        break;
      case 'run.failed':
        this.db.prepare("UPDATE runs SET status='failed', finished_at=?, error=? WHERE id=?").run(ts, event.error, runId);
        break;
      case 'run.cancelled':
        this.db.prepare("UPDATE runs SET status='cancelled', finished_at=? WHERE id=?").run(ts, runId);
        break;
      case 'agent.cost':
        if (event.cost.unit === 'premium_requests') this.db.prepare('UPDATE runs SET cost_premium_requests = cost_premium_requests + ? WHERE id=?').run(event.cost.amount, runId);
        else this.db.prepare('UPDATE runs SET cost_usd = cost_usd + ? WHERE id=?').run(event.cost.amount, runId);
        break;
      case 'approval.requested':
        this.db.prepare("UPDATE runs SET status='waiting' WHERE id=? AND status='running'").run(runId);
        break;
      case 'approval.decided':
        this.db.prepare("UPDATE runs SET status='running' WHERE id=? AND status='waiting'").run(runId);
        break;
      default:
        break;
    }
  }

  events(runId: string, afterSeq = 0, limit = 10_000): StoredRunEvent[] {
    const rows = this.db.prepare('SELECT seq, ts, payload FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, afterSeq, limit) as Array<{
      seq: number;
      ts: string;
      payload: string;
    }>;
    return rows.map((r) => ({ seq: Number(r.seq), runId, ts: r.ts, event: JSON.parse(r.payload) as RunEvent }));
  }

  getRun(runId: string): RunRow | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as Record<string, unknown> | undefined;
    return r ? toRunRow(r) : undefined;
  }

  workflowSnapshot(runId: string): WorkflowDocument | undefined {
    const r = this.db.prepare('SELECT workflow_snapshot FROM runs WHERE id=?').get(runId) as { workflow_snapshot: string } | undefined;
    return r ? (JSON.parse(r.workflow_snapshot) as WorkflowDocument) : undefined;
  }

  listRuns(filter: { workflowId?: string; status?: RunStatus; limit?: number } = {}): RunSummary[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.workflowId) {
      where.push('workflow_id=?');
      params.push(filter.workflowId);
    }
    if (filter.status) {
      where.push('status=?');
      params.push(filter.status);
    }
    params.push(filter.limit ?? 50);
    const rows = this.db
      .prepare(`SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...(params as never[])) as Record<string, unknown>[];
    return rows.map((r) => {
      const row = toRunRow(r);
      return { id: row.id, workflowId: row.workflowId, workflowName: row.workflowName, status: row.status, startedAt: row.startedAt, finishedAt: row.finishedAt, cost: row.cost, error: row.error };
    });
  }

  activeRunIds(): string[] {
    const rows = this.db.prepare("SELECT id FROM runs WHERE status IN ('queued','running','waiting','paused')").all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  loadProjection(runId: string): RunProjection | undefined {
    const row = this.getRun(runId);
    if (!row) return undefined;
    const p = emptyProjection(runId, row.workflowId, row.inputs);
    for (const ev of this.events(runId, 0, 1_000_000)) applyRunEvent(p, ev);
    return p;
  }

  // ---------------------------------------------------------------- transcripts
  appendTranscript(rawRow: Omit<TranscriptRow, 'seq' | 'ts'>): TranscriptRow {
    const row = this.redactor ? { ...rawRow, summary: rawRow.summary ? this.redactor.redact(rawRow.summary) : rawRow.summary, payload: this.redactor.redactJson(rawRow.payload) } : rawRow;
    const ts = nowIso();
    const info = this.db
      .prepare('INSERT INTO transcripts (run_id, node_id, scope, ts, kind, summary, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.runId, row.nodeId, row.scope, ts, row.kind, row.summary ?? null, JSON.stringify(row.payload ?? null));
    const stored: TranscriptRow = { ...row, seq: Number(info.lastInsertRowid), ts };
    this.emit('transcript', stored);
    return stored;
  }

  transcripts(runId: string, nodeId: string, scope: string, afterSeq = 0, limit = 5000): TranscriptRow[] {
    const rows = this.db
      .prepare('SELECT seq, ts, kind, summary, payload FROM transcripts WHERE run_id=? AND node_id=? AND scope=? AND seq>? ORDER BY seq LIMIT ?')
      .all(runId, nodeId, scope, afterSeq, limit) as Array<{ seq: number; ts: string; kind: string; summary: string | null; payload: string }>;
    return rows.map((r) => ({ seq: Number(r.seq), runId, nodeId, scope, ts: r.ts, kind: r.kind, summary: r.summary ?? undefined, payload: JSON.parse(r.payload) }));
  }

  // ---------------------------------------------------------------- approvals
  createApproval(rec: Omit<ApprovalRecord, 'id' | 'createdAt' | 'status'>): ApprovalRecord {
    const id = nanoid(12);
    const createdAt = nowIso();
    const full: ApprovalRecord = { ...rec, id, createdAt, status: 'pending' };
    this.db
      .prepare('INSERT INTO approvals (id, run_id, node_id, scope, kind, status, request, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, rec.runId, rec.nodeId, rec.scope, rec.kind, 'pending', JSON.stringify(rec.request), createdAt, rec.expiresAt ?? null);
    this.emit('approval', full);
    return full;
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? toApproval(r) : undefined;
  }

  listApprovals(filter: { status?: ApprovalStatus; runId?: string } = {}): ApprovalRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('status=?');
      params.push(filter.status);
    }
    if (filter.runId) {
      where.push('run_id=?');
      params.push(filter.runId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM approvals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at`)
      .all(...(params as never[])) as Record<string, unknown>[];
    return rows.map(toApproval);
  }

  decideApproval(id: string, status: Exclude<ApprovalStatus, 'pending'>, response: ApprovalRecord['response'], decidedBy: string): ApprovalRecord | undefined {
    const decidedAt = nowIso();
    const info = this.db
      .prepare("UPDATE approvals SET status=?, response=?, decided_at=?, decided_by=? WHERE id=? AND status='pending'")
      .run(status, JSON.stringify(response ?? {}), decidedAt, decidedBy, id);
    if (Number(info.changes) === 0) return undefined;
    const rec = this.getApproval(id)!;
    this.emit('approval', rec);
    return rec;
  }
}

function toRunRow(r: Record<string, unknown>): RunRow {
  return {
    id: r.id as string,
    workflowId: r.workflow_id as string,
    workflowName: r.workflow_name as string,
    workflowHash: r.workflow_hash as string,
    workflowPath: r.workflow_path as string,
    status: r.status as RunStatus,
    inputs: JSON.parse(r.inputs as string),
    trigger: JSON.parse(r.trigger as string),
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string | null) ?? undefined,
    finishedAt: (r.finished_at as string | null) ?? undefined,
    cost: { premiumRequests: Number(r.cost_premium_requests ?? 0), usd: Number(r.cost_usd ?? 0) },
    error: (r.error as string | null) ?? undefined,
  };
}

function toApproval(r: Record<string, unknown>): ApprovalRecord {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    nodeId: r.node_id as string,
    scope: r.scope as string,
    kind: r.kind as ApprovalRecord['kind'],
    status: r.status as ApprovalStatus,
    request: JSON.parse(r.request as string),
    response: r.response ? JSON.parse(r.response as string) : undefined,
    createdAt: r.created_at as string,
    decidedAt: (r.decided_at as string | null) ?? undefined,
    decidedBy: (r.decided_by as string | null) ?? undefined,
    expiresAt: (r.expires_at as string | null) ?? undefined,
  };
}
