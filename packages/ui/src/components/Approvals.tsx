import { useState } from 'react';
import type { ApprovalRecord, GateRequest, ToolPermissionRequest } from '@orca/shared';
import type { Api } from '../api.js';
import { ValueView } from './Render.js';

export function ApprovalsPanel({ api, approvals, onOpenRun }: { api: Api; approvals: ApprovalRecord[]; onOpenRun(runId: string): void }) {
  if (approvals.length === 0) return null;
  return (
    <div className="approvals">
      {approvals.map((a) => (a.kind === 'gate' ? <GateCard key={a.id} api={api} approval={a} onOpenRun={onOpenRun} /> : <ApprovalCard key={a.id} api={api} approval={a} onOpenRun={onOpenRun} />))}
    </div>
  );
}

function useDecide(api: Api, approval: ApprovalRecord) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (status: 'approved' | 'rejected', remember: 'none' | 'run' = 'none') => {
    setBusy(true);
    try {
      await api.decide(approval.id, { status, comment: comment || undefined, remember });
    } finally {
      setBusy(false);
    }
  };
  return { comment, setComment, busy, decide };
}

function ApprovalCard({ api, approval, onOpenRun }: { api: Api; approval: ApprovalRecord; onOpenRun(runId: string): void }) {
  const { comment, setComment, busy, decide } = useDecide(api, approval);
  const req = approval.request as ToolPermissionRequest;
  return (
    <div className="approval-card">
      <div className="approval-head">
        <span className="badge badge-warn">tool permission</span>
        <b>{approval.nodeId}</b>
        {approval.scope && <span className="note">[{approval.scope}]</span>}
        <button className="link" onClick={() => onOpenRun(approval.runId)}>
          open run
        </button>
      </div>
      <div className="approval-summary">{req.summary}</div>
      {req.command && <pre className="mono small">{req.command}</pre>}
      {req.detail && <div className="note">{req.detail}</div>}
      <input placeholder="comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="approval-actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => decide('approved')}>
          Allow once
        </button>
        <button className="btn" disabled={busy} onClick={() => decide('approved', 'run')}>
          Allow for this run
        </button>
        <button className="btn btn-danger" disabled={busy} onClick={() => decide('rejected')}>
          Deny
        </button>
      </div>
      <div className="note small">expires {approval.expiresAt ? approval.expiresAt.slice(11, 19) : 'never'}</div>
    </div>
  );
}

function GateCard({ api, approval, onOpenRun }: { api: Api; approval: ApprovalRecord; onOpenRun(runId: string): void }) {
  const { comment, setComment, busy, decide } = useDecide(api, approval);
  const req = approval.request as GateRequest;
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="approval-card gate-card">
      <div className="approval-head">
        <span className="badge badge-info">gate</span>
        <b>{req.title}</b>
        <span className="note">{approval.nodeId}</span>
        <button className="link" onClick={() => onOpenRun(approval.runId)}>
          open run
        </button>
        <button className="link" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'collapse' : 'expand'}
        </button>
      </div>
      {req.instructions && <div className="approval-summary">{req.instructions}</div>}
      {expanded && (
        <div className="gate-items">
          {req.items.map((it, i) => (
            <details key={i} open className="gate-item">
              <summary>{it.label}</summary>
              <ValueView value={it.value} render={it.render} />
            </details>
          ))}
        </div>
      )}
      <input placeholder="comment (optional, passed to the workflow)" value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="approval-actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => decide('approved')}>
          Approve
        </button>
        <button className="btn btn-danger" disabled={busy} onClick={() => decide('rejected')}>
          Reject
        </button>
      </div>
    </div>
  );
}
