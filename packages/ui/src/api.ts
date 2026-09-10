import type {
  ApprovalRecord,
  AuthStatusResponse,
  Diagnostic,
  HealthResponse,
  ModelsResponse,
  RunDetail,
  RunSummary,
  StoredRunEvent,
  TranscriptRow,
  WorkflowDetail,
  WorkflowDocument,
  WorkflowSummary,
  WsClientMessage,
  WsServerMessage,
} from '@orca/shared';

export interface EngineConnection {
  baseUrl: string;
  token: string;
}

export function readConnection(): EngineConnection | undefined {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const fromHash = hash.get('engine') && hash.get('token') ? { baseUrl: hash.get('engine')!, token: hash.get('token')! } : undefined;
  if (fromHash) {
    try {
      sessionStorage.setItem('orca.connection', JSON.stringify(fromHash));
    } catch {
      /* ignore */
    }
    history.replaceState(null, '', window.location.pathname);
    return fromHash;
  }
  try {
    const raw = sessionStorage.getItem('orca.connection');
    return raw ? (JSON.parse(raw) as EngineConnection) : undefined;
  } catch {
    return undefined;
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

export class Api {
  constructor(readonly conn: EngineConnection) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.conn.baseUrl}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.conn.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const msg = (parsed as { error?: string } | undefined)?.error ?? `${res.status} ${res.statusText}`;
      throw new ApiError(res.status, msg, parsed);
    }
    return parsed as T;
  }

  health = () => this.request<HealthResponse>('GET', '/health');
  authStatus = () => this.request<AuthStatusResponse>('GET', '/system/auth-status');
  models = () => this.request<ModelsResponse>('GET', '/system/models');
  info = () => this.request<{ version: string; cwd: string; platform: string }>('GET', '/system/info');

  workflows = () => this.request<{ workflows: WorkflowSummary[] }>('GET', '/workflows').then((r) => r.workflows);
  workflow = (id: string) => this.request<WorkflowDetail>('GET', `/workflows/${id}`);
  saveWorkflow = (id: string, document: WorkflowDocument) => this.request<WorkflowDetail>('PUT', `/workflows/${id}`, { document });
  createWorkflow = (repoPath: string, document: WorkflowDocument) => this.request<WorkflowDetail>('POST', '/workflows', { repoPath, document });
  importWorkflow = (path: string) => this.request<WorkflowDetail>('POST', '/workflows/import', { path });
  validate = (document: WorkflowDocument) => this.request<{ diagnostics: Diagnostic[] }>('POST', '/workflows/validate', { document }).then((r) => r.diagnostics);
  deleteWorkflow = (id: string) => this.request<{ deleted: boolean }>('DELETE', `/workflows/${id}`);
  templates = () => this.request<{ templates: Array<{ id: string; name: string; description?: string }> }>('GET', '/templates').then((r) => r.templates);
  fromTemplate = (templateId: string, opts: { repoPath?: string; name?: string; inPlace?: boolean }) => this.request<WorkflowDetail>('POST', '/workflows/from-template', { templateId, ...opts });

  startRun = (workflowId: string, inputs: Record<string, unknown>) => this.request<{ runId: string }>('POST', '/runs', { workflowId, inputs });
  runs = (workflowId?: string) => this.request<{ runs: RunSummary[] }>('GET', `/runs${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''}`).then((r) => r.runs);
  run = (id: string) => this.request<RunDetail>('GET', `/runs/${id}`);
  runEvents = (id: string, after = 0) => this.request<{ events: StoredRunEvent[] }>('GET', `/runs/${id}/events?after=${after}`).then((r) => r.events);
  transcript = (runId: string, nodeId: string, scope: string, after = 0) =>
    this.request<{ rows: TranscriptRow[] }>('GET', `/runs/${runId}/nodes/${nodeId}/transcript?scope=${encodeURIComponent(scope)}&after=${after}`).then((r) => r.rows);
  cancelRun = (id: string) => this.request<{ cancelled: boolean }>('POST', `/runs/${id}/cancel`);

  approvals = (status: 'pending' | 'all' = 'pending') => this.request<{ approvals: ApprovalRecord[] }>('GET', `/approvals?status=${status}`).then((r) => r.approvals);
  decide = (id: string, decision: { status: 'approved' | 'rejected'; comment?: string; remember?: 'none' | 'run' | 'workflow' }) =>
    this.request<ApprovalRecord>('POST', `/approvals/${id}/decide`, decision);
}

/** Auto-reconnecting WebSocket for run events, transcripts, and approvals. */
export class EngineSocket {
  private ws: WebSocket | undefined;
  private subs = new Set<string>();
  private listeners = new Set<(msg: WsServerMessage) => void>();
  private closed = false;
  private retryMs = 500;

  constructor(private readonly conn: EngineConnection) {
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    const url = this.conn.baseUrl.replace(/^http/, 'ws') + `/api/v1/ws?token=${encodeURIComponent(this.conn.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 500;
      for (const runId of this.subs) ws.send(JSON.stringify({ subscribe: { runId } } satisfies WsClientMessage));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WsServerMessage;
        for (const l of this.listeners) l(msg);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    };
    ws.onerror = () => ws.close();
  }

  subscribe(runId: string) {
    if (this.subs.has(runId)) return;
    this.subs.add(runId);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ subscribe: { runId } } satisfies WsClientMessage));
  }

  unsubscribe(runId: string) {
    this.subs.delete(runId);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ unsubscribe: { runId } } satisfies WsClientMessage));
  }

  on(listener: (msg: WsServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
