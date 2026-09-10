import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthStatusResponse, ModelSummary, RunSummary, WorkflowSummary } from '@orca/shared';
import { Api, EngineSocket, readConnection } from './api.js';
import { useEditor } from './store/editor.js';
import { useRuns } from './store/runs.js';
import { Canvas } from './components/Canvas.js';
import { Palette } from './components/Palette.js';
import { Inspector } from './components/Inspector.js';
import { RunPanel } from './components/RunPanel.js';
import { ApprovalsPanel } from './components/Approvals.js';
import { RunInputsDialog } from './components/RunInputsDialog.js';

type Mode = 'edit' | 'run';

export function App() {
  const conn = useMemo(() => readConnection(), []);
  if (!conn) {
    return (
      <main className="empty">
        <h1>Orca</h1>
        <p>
          No engine connection. Start with <code>pnpm dev</code>, which opens this page with the engine URL and token.
        </p>
      </main>
    );
  }
  return <Shell api={new Api(conn)} />;
}

function Shell({ api }: { api: Api }) {
  const editor = useEditor();
  const runs = useRuns();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; description?: string }>>([]);
  const [runList, setRunList] = useState<RunSummary[]>([]);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [auth, setAuth] = useState<AuthStatusResponse | undefined>();
  const [mode, setMode] = useState<Mode>('edit');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [inputsDialog, setInputsDialog] = useState(false);
  const socket = useRef<EngineSocket | undefined>(undefined);

  const refreshWorkflows = useCallback(() => api.workflows().then(setWorkflows).catch((e: Error) => setError(e.message)), [api]);
  const refreshRuns = useCallback(
    (workflowId?: string) => api.runs(workflowId).then(setRunList).catch((e: Error) => setError(e.message)),
    [api],
  );

  useEffect(() => {
    void refreshWorkflows();
    api.templates().then(setTemplates).catch(() => undefined);
    api.models().then((r) => setModels(r.models)).catch(() => undefined);
    api.authStatus().then(setAuth).catch(() => undefined);
    api.approvals().then((a) => runs.setApprovals(a)).catch(() => undefined);
    const s = new EngineSocket(api.conn);
    socket.current = s;
    const off = s.on((msg) => runs.handleWs(msg));
    return () => {
      off();
      s.close();
    };
  }, [api]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      } else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey && mode === 'edit' && !isTyping(e)) {
        e.preventDefault();
        editor.undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) && mode === 'edit' && !isTyping(e)) {
        e.preventDefault();
        editor.redo();
      } else if (mod && e.key === 'Enter') {
        e.preventDefault();
        void startRun();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const openWorkflow = async (id: string) => {
    try {
      const d = await api.workflow(id);
      editor.load(d);
      setMode('edit');
      runs.setActiveRun(undefined);
      void refreshRuns(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const save = async () => {
    const doc = editor.document;
    if (!doc || !editor.detail) return;
    setSaving(true);
    try {
      const d = await api.saveWorkflow(doc.id, doc);
      editor.markSaved(d);
      void refreshWorkflows();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const validate = async () => {
    if (!editor.document) return;
    try {
      editor.setDiagnostics(await api.validate(editor.document));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openRun = useCallback(
    async (runId: string) => {
      try {
        const d = await api.run(runId);
        runs.loadRun(runId, d.run, d.workflow, d.approvals);
        socket.current?.subscribe(runId);
        // catch up on events after the snapshot
        const events = await api.runEvents(runId, d.run.lastSeq);
        if (events.length) runs.applyEvents(runId, events);
        runs.setActiveRun(runId);
        setMode('run');
        if (!editor.document || editor.document.id !== d.workflow.id) {
          const wf = workflows.find((w) => w.id === d.workflow.id);
          if (wf) await openWorkflow(wf.id);
          setMode('run');
        }
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [api, runs, workflows, editor.document],
  );

  const startRun = async () => {
    const doc = editor.document;
    if (!doc) return;
    if (editor.dirty) await save();
    const diags = await api.validate(doc);
    editor.setDiagnostics(diags);
    if (diags.some((d) => d.severity === 'error')) {
      setError('Fix the errors in the Problems panel before running.');
      return;
    }
    if (doc.inputs.length > 0) {
      setInputsDialog(true);
      return;
    }
    await launch({});
  };

  const launch = async (inputs: Record<string, unknown>) => {
    const doc = editor.document;
    if (!doc) return;
    setInputsDialog(false);
    try {
      const { runId } = await api.startRun(doc.id, inputs);
      await openRun(runId);
      void refreshRuns(doc.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const useTemplate = async (templateId: string) => {
    try {
      const d = await api.fromTemplate(templateId, { inPlace: true });
      await refreshWorkflows();
      await openWorkflow(d.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const activeRun = runs.activeRunId ? runs.projections[runs.activeRunId] : undefined;
  const activeWorkflow = runs.activeRunId ? runs.workflows[runs.activeRunId] : undefined;

  // keep the sidebar run list in sync with the active run's status and cost
  useEffect(() => {
    if (editor.document) void refreshRuns(editor.document.id);
  }, [activeRun?.status, activeRun?.cost.premiumRequests]);
  const doc = mode === 'run' && activeWorkflow ? activeWorkflow : editor.document;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Orca</span>
        {editor.document && (
          <>
            <span className="wf-name">
              {editor.document.name}
              {editor.dirty ? ' •' : ''}
            </span>
            <div className="mode-switch">
              <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>
                Edit
              </button>
              <button className={mode === 'run' ? 'active' : ''} disabled={!activeRun} onClick={() => setMode('run')}>
                Run{activeRun ? ` (${activeRun.status})` : ''}
              </button>
            </div>
            <button className="btn" onClick={validate}>
              Validate
            </button>
            <button className="btn" disabled={!editor.dirty || saving} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-primary" onClick={startRun} title="Ctrl+Enter">
              ▶ Run
            </button>
            {activeRun && (activeRun.status === 'running' || activeRun.status === 'waiting') && (
              <button className="btn btn-danger" onClick={() => api.cancelRun(activeRun.id)}>
                Cancel run
              </button>
            )}
          </>
        )}
        <span className="spacer" />
        {runs.approvals.length > 0 && <span className="badge badge-warn">{runs.approvals.length} approval(s) waiting</span>}
        <span className={`auth ${auth?.isAuthenticated ? 'ok' : 'bad'}`} title={auth?.error ?? auth?.statusMessage ?? ''}>
          {auth ? (auth.isAuthenticated ? `Copilot: ${auth.login}` : 'Copilot: not signed in') : 'Copilot: …'}
        </span>
      </header>
      {error && (
        <div className="errorbar" onClick={() => setError(undefined)}>
          {error} <span className="note">(click to dismiss)</span>
        </div>
      )}
      {inputsDialog && editor.document && <RunInputsDialog inputs={editor.document.inputs} onSubmit={launch} onCancel={() => setInputsDialog(false)} />}
      <ApprovalsPanel api={api} approvals={runs.approvals} onOpenRun={openRun} />
      <div className="toasts">
        {runs.notifications.slice(-4).map((n) => (
          <div key={n.id} className={`toast toast-${n.level}`} onClick={() => runs.dismissNotification(n.id)} title="click to dismiss">
            <b>{n.title}</b>
            {n.message}
          </div>
        ))}
      </div>
      <div className="body">
        <aside className="sidebar">
          <div className="panel-title">Workflows</div>
          <ul className="list">
            {workflows.map((w) => (
              <li key={w.id} className={editor.document?.id === w.id ? 'active' : ''} onClick={() => openWorkflow(w.id)} title={w.path}>
                {w.name}
              </li>
            ))}
            {workflows.length === 0 && <li className="note">None yet. Open a template below.</li>}
          </ul>
          <div className="panel-title">Templates</div>
          <ul className="list">
            {templates.map((t) => (
              <li key={t.id} onClick={() => useTemplate(t.id)} title={t.description}>
                {t.name}
              </li>
            ))}
          </ul>
          {editor.document && (
            <>
              <div className="panel-title">Runs</div>
              <ul className="list">
                {runList.map((r) => (
                  <li key={r.id} className={`run-item status-${r.status} ${runs.activeRunId === r.id ? 'active' : ''}`} onClick={() => openRun(r.id)}>
                    <span className={`status-dot status-${r.status}`} />
                    {(r.startedAt ?? '').slice(5, 16).replace('T', ' ')} · {r.status}
                    <span className="note"> · {r.cost.premiumRequests} PR</span>
                  </li>
                ))}
                {runList.length === 0 && <li className="note">No runs yet.</li>}
              </ul>
            </>
          )}
          {mode === 'edit' && editor.document && <Palette disabled={false} />}
        </aside>
        <main className="canvas-wrap">
          {doc ? (
            <Canvas
              document={doc}
              diagnostics={mode === 'edit' ? editor.diagnostics : []}
              run={mode === 'run' ? activeRun : undefined}
              readOnly={mode === 'run'}
              selectedNodeId={editor.selectedNodeId}
              onSelectNode={(id, edgeId) => editor.select(id, edgeId)}
            />
          ) : (
            <div className="empty">
              <h2>Pick a workflow or open a template</h2>
              <p>Templates are copied into the engine's index and run in place, so you can try them immediately.</p>
            </div>
          )}
        </main>
        <aside className="rightbar">
          {doc && mode === 'edit' && <Inspector document={doc} nodeId={editor.selectedNodeId} edgeId={editor.selectedEdgeId} diagnostics={editor.diagnostics} models={models} readOnly={false} />}
          {doc && mode === 'run' && activeRun && runs.activeRunId && <RunPanel api={api} runId={runs.activeRunId} run={activeRun} workflow={doc} nodeId={editor.selectedNodeId} />}
        </aside>
      </div>
    </div>
  );
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
