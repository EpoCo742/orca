import { useEffect, useMemo, useState } from 'react';
import { nodeKey, parseNodeKey, type RunProjection, type TranscriptRow, type WorkflowDocument } from '@orca/shared';
import type { Api } from '../api.js';
import { useRuns } from '../store/runs.js';

export function RunPanel({ api, runId, run, workflow, nodeId }: { api: Api; runId: string; run: RunProjection; workflow: WorkflowDocument; nodeId?: string }) {
  const runs = useRuns();
  const selectedKey = runs.selectedNodeKey;
  const node = nodeId ? workflow.nodes.find((n) => n.id === nodeId) : undefined;

  // All states for this node across scopes (iterations), newest last
  const states = useMemo(() => Object.values(run.nodes).filter((s) => s.nodeId === nodeId).sort((a, b) => scopeIndex(a.scope) - scopeIndex(b.scope)), [run, nodeId]);
  const [scope, setScope] = useState<string | undefined>(undefined);
  const current = states.find((s) => s.scope === scope) ?? states[states.length - 1];
  useEffect(() => {
    if (current) setScope(current.scope);
  }, [nodeId, states.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const key = current ? `${runId}:${nodeKey(current.nodeId, current.scope)}` : undefined;
  const transcript = key ? runs.transcripts[key] : undefined;
  const log = key ? runs.logs[key] : undefined;
  const [tab, setTab] = useState<'overview' | 'transcript' | 'output'>('overview');

  useEffect(() => {
    if (!current || node?.type !== 'agent.copilot') return;
    if (key && runs.transcripts[key]) return;
    api.transcript(runId, current.nodeId, current.scope).then((rows) => runs.setTranscript(runId, current.nodeId, current.scope, rows)).catch(() => undefined);
  }, [runId, current?.nodeId, current?.scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedKey && nodeId !== parseNodeKey(selectedKey).nodeId) runs.selectNode(undefined);
  }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!node) return <RunOverview run={run} workflow={workflow} />;

  return (
    <div className="runpanel">
      <div className="panel-title">
        {node.label ?? node.id}
        <span className="panel-title-sub">{node.type}</span>
      </div>
      {states.length > 1 && (
        <div className="scope-tabs">
          {states.map((s) => (
            <button key={s.scope} className={`chip ${s.scope === current?.scope ? 'chip-active' : ''} status-${s.status}`} onClick={() => setScope(s.scope)}>
              {s.scope || 'run'}
            </button>
          ))}
        </div>
      )}
      {!current && <div className="note">Not started yet.</div>}
      {current && (
        <>
          <div className={`status-line status-${current.status}`}>
            <b>{current.status}</b>
            {current.attempt > 1 ? ` · attempt ${current.attempt}` : ''}
            {current.cost ? ` · ${current.cost.amount} ${current.cost.unit === 'premium_requests' ? 'premium requests' : 'USD'}` : ''}
            {current.startedAt ? ` · started ${current.startedAt.slice(11, 19)}` : ''}
            {current.finishedAt ? ` · finished ${current.finishedAt.slice(11, 19)}` : ''}
          </div>
          {current.error && <div className="diag diag-error">{current.error}</div>}
          <div className="tabs">
            <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>
              Outputs
            </button>
            {node.type === 'agent.copilot' && (
              <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>
                Transcript {transcript ? `(${transcript.length})` : ''}
              </button>
            )}
            {(log?.stdout || log?.stderr || log?.summaries.length) && (
              <button className={tab === 'output' ? 'active' : ''} onClick={() => setTab('output')}>
                Output
              </button>
            )}
          </div>
          {tab === 'overview' && (
            <div className="outputs">
              {current.outputs ? (
                Object.entries(current.outputs).map(([k, v]) => (
                  <details key={k} open={typeof v !== 'string' || v.length < 400}>
                    <summary>
                      <code>{k}</code>
                    </summary>
                    <pre className="mono small">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>
                  </details>
                ))
              ) : (
                <div className="note">No outputs yet.</div>
              )}
            </div>
          )}
          {tab === 'transcript' && <Transcript rows={transcript ?? []} />}
          {tab === 'output' && (
            <div className="outputs">
              {log?.summaries.length ? (
                <pre className="mono small">{log.summaries.join('\n')}</pre>
              ) : null}
              {log?.stdout && (
                <details open>
                  <summary>stdout</summary>
                  <pre className="mono small">{log.stdout}</pre>
                </details>
              )}
              {log?.stderr && (
                <details open>
                  <summary>stderr</summary>
                  <pre className="mono small">{log.stderr}</pre>
                </details>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function scopeIndex(scope: string): number {
  const m = /\[(\d+)\]$/.exec(scope);
  return m ? Number(m[1]) : -1;
}

function RunOverview({ run, workflow }: { run: RunProjection; workflow: WorkflowDocument }) {
  const states = Object.values(run.nodes);
  const counts = states.reduce<Record<string, number>>((acc, s) => ((acc[s.status] = (acc[s.status] ?? 0) + 1), acc), {});
  return (
    <div className="runpanel">
      <div className="panel-title">
        Run
        <span className="panel-title-sub">{workflow.name}</span>
      </div>
      <div className={`status-line status-${run.status}`}>
        <b>{run.status}</b>
        {run.startedAt ? ` · started ${run.startedAt.slice(11, 19)}` : ''}
        {run.finishedAt ? ` · finished ${run.finishedAt.slice(11, 19)}` : ''}
      </div>
      {run.error && <div className="diag diag-error">{run.error}</div>}
      <div className="note">
        {run.cost.premiumRequests} premium requests{run.cost.usd ? `, $${run.cost.usd.toFixed(2)}` : ''}
      </div>
      <div className="note">
        {Object.entries(counts)
          .map(([k, v]) => `${v} ${k}`)
          .join(' · ')}
      </div>
      <div className="note">Click a node to see its outputs and transcript.</div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  'user.message': 'prompt',
  'assistant.message': 'assistant',
  'assistant.reasoning': 'reasoning',
  'tool.execution_start': 'tool',
  'tool.execution_complete': 'result',
  'permission.requested': 'permission?',
  'permission.completed': 'permission',
  'assistant.usage': 'usage',
  'orca.permission': 'policy',
  'orca.hard_deny': 'blocked',
  'orca.stop': 'stopped',
};

function Transcript({ rows }: { rows: TranscriptRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.filter((r) => KIND_LABEL[r.kind]);
  return (
    <div className="transcript">
      <label className="note">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show all events ({rows.length})
      </label>
      {visible.map((r) => (
        <TranscriptRowView key={r.seq} row={r} />
      ))}
      {visible.length === 0 && <div className="note">Nothing yet.</div>}
    </div>
  );
}

function TranscriptRowView({ row }: { row: TranscriptRow }) {
  const [open, setOpen] = useState(false);
  const label = KIND_LABEL[row.kind] ?? row.kind;
  const payload = row.payload as Record<string, unknown> | null;
  const text = row.kind === 'assistant.message' || row.kind === 'user.message' ? String(payload?.content ?? '') : (row.summary ?? '');
  return (
    <div className={`trow trow-${label.replace(/[^a-z]/g, '')}`}>
      <div className="trow-head" onClick={() => setOpen(!open)}>
        <span className="trow-kind">{label}</span>
        <span className="trow-time">{row.ts.slice(11, 19)}</span>
      </div>
      <div className={`trow-text ${row.kind === 'assistant.message' ? 'assistant' : ''}`}>{text}</div>
      {open && <pre className="mono small">{JSON.stringify(row.payload, null, 2)}</pre>}
    </div>
  );
}
