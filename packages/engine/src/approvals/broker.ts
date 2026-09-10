import type { ApprovalRecord, DecideApprovalRequest, RunEvent, ToolPermissionRequest } from '@orca/shared';
import type { RunStore } from '../run/store.js';

interface Pending {
  resolve: (rec: ApprovalRecord) => void;
  timer?: NodeJS.Timeout;
  runId: string;
}

/** Routes tool-permission questions and gates to a human, with timeouts, persisted in the run store. */
export class ApprovalBroker {
  private pending = new Map<string, Pending>();

  constructor(private readonly store: RunStore) {}

  async requestToolPermission(args: {
    runId: string;
    nodeId: string;
    scope: string;
    request: ToolPermissionRequest;
    timeoutSec: number;
    onTimeout: 'deny' | 'allow';
    signal: AbortSignal;
    emit: (event: RunEvent) => void;
  }): Promise<ApprovalRecord> {
    const expiresAt = new Date(Date.now() + args.timeoutSec * 1000).toISOString();
    const rec = this.store.createApproval({ runId: args.runId, nodeId: args.nodeId, scope: args.scope, kind: 'tool_permission', request: args.request, expiresAt });
    args.emit({ type: 'approval.requested', approvalId: rec.id, nodeId: args.nodeId, scope: args.scope, kind: 'tool_permission' });

    const decided = await new Promise<ApprovalRecord>((resolve) => {
      const timer = setTimeout(() => {
        const r = this.store.decideApproval(rec.id, 'timeout', { comment: `timed out after ${args.timeoutSec}s; policy: ${args.onTimeout}` }, 'system');
        this.settle(rec.id, r);
      }, args.timeoutSec * 1000);
      const onAbort = () => {
        const r = this.store.decideApproval(rec.id, 'rejected', { comment: 'run cancelled' }, 'system');
        this.settle(rec.id, r);
      };
      args.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(rec.id, {
        runId: args.runId,
        timer,
        resolve: (r) => {
          clearTimeout(timer);
          args.signal.removeEventListener('abort', onAbort);
          resolve(r);
        },
      });
    });

    args.emit({ type: 'approval.decided', approvalId: rec.id, nodeId: args.nodeId, scope: args.scope, status: decided.status });
    return decided;
  }

  /** Called by the API when a person decides. Returns the updated record, or undefined if not pending. */
  decide(id: string, decision: DecideApprovalRequest): ApprovalRecord | undefined {
    const rec = this.store.decideApproval(id, decision.status, { comment: decision.comment, remember: decision.remember }, decision.decidedBy);
    if (!rec) return undefined;
    this.settle(id, rec);
    return rec;
  }

  private settle(id: string, rec: ApprovalRecord | undefined): void {
    const p = this.pending.get(id);
    if (!p || !rec) return;
    this.pending.delete(id);
    p.resolve(rec);
  }

  /** Expire pending approvals for a run (engine restart, cancellation). */
  expireForRun(runId: string, reason: string): void {
    for (const rec of this.store.listApprovals({ status: 'pending', runId })) {
      const r = this.store.decideApproval(rec.id, 'timeout', { comment: reason }, 'system');
      this.settle(rec.id, r);
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
