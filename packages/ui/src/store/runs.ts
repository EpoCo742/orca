import { create } from 'zustand';
import { applyRunEvent, emptyProjection, nodeKey, type ApprovalRecord, type RunProjection, type StoredRunEvent, type TranscriptRow, type WorkflowDocument, type WsServerMessage } from '@orca/shared';

export interface NodeLog {
  stdout: string;
  stderr: string;
  summaries: string[];
}

export interface RunsState {
  projections: Record<string, RunProjection>;
  workflows: Record<string, WorkflowDocument>; // snapshot per run
  transcripts: Record<string, TranscriptRow[]>; // key `${runId}:${nodeKey}`
  logs: Record<string, NodeLog>; // key `${runId}:${nodeKey}`
  approvals: ApprovalRecord[]; // pending
  notifications: Array<{ id: number; runId: string; title: string; message: string; level: 'info' | 'success' | 'warning' | 'error'; ts: string }>;
  activeRunId?: string;
  selectedNodeKey?: string; // nodeKey within the active run
  dismissNotification(id: number): void;

  setActiveRun(runId?: string): void;
  loadRun(runId: string, run: RunProjection, workflow: WorkflowDocument, approvals: ApprovalRecord[]): void;
  applyEvents(runId: string, events: StoredRunEvent[]): void;
  setTranscript(runId: string, nodeId: string, scope: string, rows: TranscriptRow[]): void;
  setApprovals(approvals: ApprovalRecord[]): void;
  handleWs(msg: WsServerMessage): void;
  selectNode(key?: string): void;
}

function tkey(runId: string, nodeId: string, scope: string): string {
  return `${runId}:${nodeKey(nodeId, scope)}`;
}

export const useRuns = create<RunsState>((set, get) => ({
  projections: {},
  workflows: {},
  transcripts: {},
  logs: {},
  approvals: [],
  notifications: [],

  dismissNotification(id) {
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) }));
  },
  setActiveRun(runId) {
    set({ activeRunId: runId, selectedNodeKey: undefined });
  },
  loadRun(runId, run, workflow, approvals) {
    set((s) => ({
      projections: { ...s.projections, [runId]: run },
      workflows: { ...s.workflows, [runId]: workflow },
      approvals: mergeApprovals(s.approvals, approvals),
    }));
  },
  applyEvents(runId, events) {
    set((s) => {
      const proj = structuredClone(s.projections[runId] ?? emptyProjection(runId, '', {}));
      const logs = { ...s.logs };
      for (const ev of events) {
        if (ev.seq <= proj.lastSeq) continue;
        applyRunEvent(proj, ev);
        if (ev.event.type === 'node.progress') {
          const k = tkey(runId, ev.event.nodeId, ev.event.scope);
          const log = logs[k] ? { ...logs[k]! } : { stdout: '', stderr: '', summaries: [] };
          if (ev.event.kind === 'stdout') log.stdout = (log.stdout + ev.event.text).slice(-200_000);
          else if (ev.event.kind === 'stderr') log.stderr = (log.stderr + ev.event.text).slice(-200_000);
          else log.summaries = [...log.summaries, ev.event.text].slice(-500);
          logs[k] = log;
        }
      }
      return { projections: { ...s.projections, [runId]: proj }, logs };
    });
  },
  setTranscript(runId, nodeId, scope, rows) {
    set((s) => ({ transcripts: { ...s.transcripts, [tkey(runId, nodeId, scope)]: rows } }));
  },
  setApprovals(approvals) {
    set({ approvals: approvals.filter((a) => a.status === 'pending') });
  },
  handleWs(msg) {
    if (msg.channel === 'run') {
      get().applyEvents(msg.runId, [msg.event]);
      const e = msg.event.event;
      if (e.type === 'notify') {
        const n = { id: msg.event.seq, runId: msg.runId, title: e.title, message: e.message, level: e.level, ts: msg.event.ts };
        set((s) => ({ notifications: [...s.notifications, n].slice(-20) }));
        setTimeout(() => get().dismissNotification(n.id), 15_000);
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(`Orca: ${e.title}`, { body: e.message });
        } catch {
          /* ignore */
        }
      }
    }
    else if (msg.channel === 'transcript') {
      const k = tkey(msg.runId, msg.row.nodeId, msg.row.scope);
      set((s) => {
        const existing = s.transcripts[k] ?? [];
        if (existing.some((r) => r.seq === msg.row.seq)) return {};
        return { transcripts: { ...s.transcripts, [k]: [...existing, msg.row].slice(-2000) } };
      });
    } else if (msg.channel === 'approval') {
      set((s) => ({ approvals: mergeApprovals(s.approvals, [msg.approval]) }));
    }
  },
  selectNode(key) {
    set({ selectedNodeKey: key });
  },
}));

function mergeApprovals(current: ApprovalRecord[], incoming: ApprovalRecord[]): ApprovalRecord[] {
  const map = new Map(current.map((a) => [a.id, a]));
  for (const a of incoming) map.set(a.id, a);
  return [...map.values()].filter((a) => a.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
