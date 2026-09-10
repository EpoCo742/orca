import { nodeKey, type RunEvent, type RunProjection, type StoredRunEvent } from './events.js';

export function emptyProjection(runId: string, workflowId: string, inputs: Record<string, unknown>): RunProjection {
  return {
    id: runId,
    workflowId,
    status: 'queued',
    inputs,
    cost: { premiumRequests: 0, usd: 0 },
    nodes: {},
    iterations: {},
    lastSeq: 0,
  };
}

/** Pure reducer: applies one stored event to a projection (mutating and returning it). */
export function applyRunEvent(p: RunProjection, stored: StoredRunEvent): RunProjection {
  const e: RunEvent = stored.event;
  const ts = stored.ts;
  p.lastSeq = Math.max(p.lastSeq, stored.seq);
  switch (e.type) {
    case 'run.created':
      p.workflowId = e.workflowId;
      p.inputs = e.inputs;
      p.status = 'queued';
      break;
    case 'run.started':
      p.status = 'running';
      p.startedAt = ts;
      break;
    case 'run.status':
      p.status = e.status;
      break;
    case 'run.completed':
      p.status = 'completed';
      p.finishedAt = ts;
      break;
    case 'run.failed':
      p.status = 'failed';
      p.error = e.error;
      p.finishedAt = ts;
      break;
    case 'run.cancelled':
      p.status = 'cancelled';
      p.finishedAt = ts;
      break;
    case 'node.scheduled': {
      const k = nodeKey(e.nodeId, e.scope);
      p.nodes[k] = { ...(p.nodes[k] ?? { nodeId: e.nodeId, scope: e.scope, attempt: 0 }), status: 'ready' };
      break;
    }
    case 'node.started': {
      const k = nodeKey(e.nodeId, e.scope);
      p.nodes[k] = { nodeId: e.nodeId, scope: e.scope, status: 'running', attempt: e.attempt, startedAt: ts };
      break;
    }
    case 'node.completed': {
      const k = nodeKey(e.nodeId, e.scope);
      p.nodes[k] = {
        ...(p.nodes[k] ?? { nodeId: e.nodeId, scope: e.scope }),
        status: 'completed',
        attempt: e.attempt,
        outputs: e.outputs,
        fired: e.fired,
        finishedAt: ts,
        cost: e.cost,
      };
      break;
    }
    case 'node.failed': {
      const k = nodeKey(e.nodeId, e.scope);
      p.nodes[k] = { ...(p.nodes[k] ?? { nodeId: e.nodeId, scope: e.scope }), status: 'failed', attempt: e.attempt, error: e.error, finishedAt: ts };
      break;
    }
    case 'node.skipped': {
      const k = nodeKey(e.nodeId, e.scope);
      p.nodes[k] = { ...(p.nodes[k] ?? { nodeId: e.nodeId, scope: e.scope, attempt: 0 }), status: 'skipped', error: e.reason };
      break;
    }
    case 'node.retry': {
      const k = nodeKey(e.nodeId, e.scope);
      p.nodes[k] = { ...(p.nodes[k] ?? { nodeId: e.nodeId, scope: e.scope }), status: 'ready', attempt: e.attempt };
      break;
    }
    case 'loop.iteration':
      p.iterations[nodeKey(e.nodeId, e.scope)] = e.index;
      break;
    case 'loop.exit':
      break;
    case 'approval.requested': {
      const k = nodeKey(e.nodeId, e.scope);
      if (p.nodes[k]) p.nodes[k].status = 'waiting';
      break;
    }
    case 'approval.decided': {
      const k = nodeKey(e.nodeId, e.scope);
      if (p.nodes[k] && p.nodes[k].status === 'waiting') p.nodes[k].status = 'running';
      break;
    }
    case 'agent.session':
      break;
    case 'agent.cost':
      if (e.cost.unit === 'premium_requests') p.cost.premiumRequests += e.cost.amount;
      else p.cost.usd += e.cost.amount;
      break;
  }
  return p;
}

export function projectRun(runId: string, workflowId: string, inputs: Record<string, unknown>, events: StoredRunEvent[]): RunProjection {
  const p = emptyProjection(runId, workflowId, inputs);
  for (const ev of events) applyRunEvent(p, ev);
  return p;
}
