import { useState } from 'react';
import type { ApprovalRecord, ToolPermissionRequest } from '@orca/shared';
import type { Api } from '../api.js';

export function ApprovalsPanel({ api, approvals, onOpenRun }: { api: Api; approvals: ApprovalRecord[]; onOpenRun(runId: string): void }) {
  if (approvals.length === 0) return null;
  return (
    <div className="approvals">
      {approvals.map((a) => (
        <ApprovalCard key={a.id} api={api} approval={a} onOpenRun={onOpenRun} />
      ))}
    </div>
  );
}

function ApprovalCard({ api, approval, onOpenRun }: { api: Api; approval: ApprovalRecord; onOpenRun(runId: string): void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const req = approval.request as ToolPermissionRequest;
  const decide = async (status: 'approved' | 'rejected', remember: 'none' | 'run' = 'none') => {
    setBusy(true);
    try {
      await api.decide(approval.id, { status, comment: comment || undefined, remember });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="approval-card">
      <div className="approval-head">
        <span className="badge badge-warn">approval</span>
        <b>{approval.nodeId}</b>
        {approval.scope && <span className="note">[{approval.scope}]</span>}
        <button className="link" onClick={() => onOpenRun(approval.runId)}>
          open run
        </button>
      </div>
      <div className="approval-summary">{req.kind === 'tool_permission' ? req.summary : 'Gate'}</div>
      {req.kind === 'tool_permission' && req.command && <pre className="mono small">{req.command}</pre>}
      {req.kind === 'tool_permission' && req.detail && <div className="note">{req.detail}</div>}
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
      <div className="note small">
        expires {approval.expiresAt ? approval.expiresAt.slice(11, 19) : 'never'}
      </div>
    </div>
  );
}
