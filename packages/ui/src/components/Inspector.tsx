import { useMemo, useState } from 'react';
import { getNodeType, nodeOutputs, type Diagnostic, type ModelSummary, type NodeBase, type WorkflowDocument } from '@orca/shared';
import { useEditor } from '../store/editor.js';

export interface InspectorProps {
  document: WorkflowDocument;
  nodeId?: string;
  edgeId?: string;
  diagnostics: Diagnostic[];
  models: ModelSummary[];
  readOnly: boolean;
}

export function Inspector(props: InspectorProps) {
  const { document, nodeId, edgeId } = props;
  const node = nodeId ? document.nodes.find((n) => n.id === nodeId) : undefined;
  const edge = edgeId ? document.edges.find((e) => e.id === edgeId) : undefined;
  if (node) return <NodeInspector key={node.id} node={node} {...props} />;
  if (edge) return <EdgeInspector edge={edge} {...props} />;
  return <WorkflowInspector {...props} />;
}

// ---------------------------------------------------------------- helpers
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <span className="field-hint" title={hint}>ⓘ</span>}
      </span>
      {children}
    </label>
  );
}

function useConfig<T extends Record<string, unknown>>(node: NodeBase): [T, (patch: Partial<T>) => void] {
  const update = useEditor((s) => s.updateNodeConfig);
  const cfg = (node.config ?? {}) as T;
  return [cfg, (patch) => update(node.id, patch as Record<string, unknown>)];
}

function TextArea({ value, onChange, rows = 4, mono = true, disabled }: { value: string; onChange(v: string): void; rows?: number; mono?: boolean; disabled?: boolean }) {
  return <textarea className={mono ? 'mono' : ''} rows={rows} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
}

/** Upstream references available for templates: node ids and their ports, visible from this node. */
function useReferenceHints(document: WorkflowDocument, node: NodeBase): string[] {
  return useMemo(() => {
    const out: string[] = ['inputs.<name>', 'iteration.index', 'iteration.previous.<node>.<port>'];
    for (const n of document.nodes) {
      if (n.id === node.id) continue;
      const visible = !n.parent || n.parent === node.parent || n.parent === node.id;
      if (!visible) continue;
      const def = getNodeType(n.type);
      if (!def) continue;
      for (const p of nodeOutputs(def)) if (p.type !== 'trigger') out.push(`nodes.${n.id}.${p.id}`);
    }
    return out;
  }, [document, node]);
}

// ---------------------------------------------------------------- node inspector
function NodeInspector({ node, document, diagnostics, models, readOnly }: InspectorProps & { node: NodeBase }) {
  const def = getNodeType(node.type);
  const editor = useEditor();
  const [idDraft, setIdDraft] = useState(node.id);
  const nodeDiags = diagnostics.filter((d) => d.nodeId === node.id);
  const hints = useReferenceHints(document, node);

  return (
    <div className="inspector">
      <div className="panel-title">
        {def?.label ?? node.type}
        <span className="panel-title-sub">{node.type}</span>
      </div>
      {nodeDiags.length > 0 && (
        <div className="diag-list">
          {nodeDiags.map((d, i) => (
            <div key={i} className={`diag diag-${d.severity}`}>
              {d.message}
            </div>
          ))}
        </div>
      )}
      <Field label="Id" hint="Used in expressions as nodes.<id>. Renaming rewrites references.">
        <input
          value={idDraft}
          disabled={readOnly}
          onChange={(e) => setIdDraft(e.target.value)}
          onBlur={() => {
            if (idDraft !== node.id && !editor.renameNode(node.id, idDraft)) setIdDraft(node.id);
          }}
        />
      </Field>
      <Field label="Label">
        <input value={node.label ?? ''} disabled={readOnly} placeholder={node.id} onChange={(e) => editor.updateNode(node.id, (n) => (n.label = e.target.value || undefined))} />
      </Field>

      {node.type === 'agent.copilot' && <AgentFields node={node} models={models} readOnly={readOnly} document={document} />}
      {node.type === 'action.shell' && <ShellFields node={node} readOnly={readOnly} document={document} />}
      {node.type === 'action.git' && <GitFields node={node} readOnly={readOnly} document={document} />}
      {node.type === 'control.gate' && <GateFields node={node} readOnly={readOnly} />}
      {node.type === 'action.notify' && <NotifyFields node={node} readOnly={readOnly} />}
      {node.type === 'control.condition' && <ConditionFields node={node} readOnly={readOnly} />}
      {node.type === 'control.loop' && <LoopFields node={node} readOnly={readOnly} />}
      {node.type === 'data.transform' && <TransformFields node={node} readOnly={readOnly} />}

      <details className="adv">
        <summary>Retry and timeout</summary>
        <Field label="Max attempts">
          <input type="number" min={1} max={10} value={node.retry.maxAttempts} disabled={readOnly} onChange={(e) => editor.updateNode(node.id, (n) => (n.retry.maxAttempts = Number(e.target.value) || 1))} />
        </Field>
        <Field label="Backoff (ms)">
          <input type="number" min={0} value={node.retry.backoffMs} disabled={readOnly} onChange={(e) => editor.updateNode(node.id, (n) => (n.retry.backoffMs = Number(e.target.value) || 0))} />
        </Field>
        <Field label="Node timeout (ms)" hint="Whole-node wall clock; empty for none">
          <input type="number" min={0} value={node.timeoutMs ?? ''} disabled={readOnly} onChange={(e) => editor.updateNode(node.id, (n) => (n.timeoutMs = e.target.value ? Number(e.target.value) : undefined))} />
        </Field>
        <Field label="Disabled">
          <input type="checkbox" checked={node.disabled} disabled={readOnly} onChange={(e) => editor.updateNode(node.id, (n) => (n.disabled = e.target.checked))} />
        </Field>
      </details>

      <details className="adv">
        <summary>Available references</summary>
        <div className="hint-list">
          {hints.map((h) => (
            <code key={h} className="hint-chip" onClick={() => navigator.clipboard?.writeText(`{{ ${h} }}`)} title="click to copy">
              {h}
            </code>
          ))}
        </div>
      </details>

      {!readOnly && (
        <button className="btn btn-danger" onClick={() => editor.removeNodes([node.id])}>
          Delete node
        </button>
      )}
    </div>
  );
}

function AgentFields({ node, models, readOnly, document }: { node: NodeBase; models: ModelSummary[]; readOnly: boolean; document: WorkflowDocument }) {
  const [cfg, set] = useConfig<{
    adapter?: string;
    prompt?: string;
    system?: { mode: 'preset'; append?: string } | { mode: 'custom'; text: string };
    model?: string;
    effort?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    approval?: { onUnresolved?: string; timeoutSec?: number; onTimeout?: string; autoAllowReadOnly?: boolean };
    maxPremiumRequests?: number;
    maxToolCalls?: number;
    timeoutMs?: number;
    cwdRelative?: string;
    isolation?: string;
    worktreeOf?: string;
    agentMode?: string;
    outputSchema?: Record<string, unknown>;
  }>(node);
  const approval = cfg.approval ?? {};
  const system = cfg.system ?? { mode: 'preset' as const };
  const effortOptions = models.find((m) => m.id === (cfg.model ?? document.settings.defaultModel))?.supportedReasoningEfforts ?? ['low', 'medium', 'high', 'xhigh', 'max'];
  return (
    <>
      <Field label="Prompt" hint="Template. Insert upstream outputs with {{ nodes.<id>.<port> }}.">
        <TextArea value={cfg.prompt ?? ''} rows={10} mono={false} disabled={readOnly} onChange={(v) => set({ prompt: v })} />
      </Field>
      <Field label="Adapter">
        <select value={cfg.adapter ?? 'copilot'} disabled={readOnly} onChange={(e) => set({ adapter: e.target.value })}>
          <option value="copilot">GitHub Copilot</option>
          <option value="fake">Fake (testing)</option>
        </select>
      </Field>
      <Field label="Model">
        <select value={cfg.model ?? ''} disabled={readOnly} onChange={(e) => set({ model: e.target.value || undefined })}>
          <option value="">workflow default ({document.settings.defaultModel})</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.id})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Effort">
        <select value={cfg.effort ?? ''} disabled={readOnly} onChange={(e) => set({ effort: e.target.value || undefined })}>
          <option value="">workflow default ({document.settings.defaultEffort})</option>
          {effortOptions.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Extra instructions" hint="Appended to the agent's system prompt">
        <TextArea value={system.mode === 'preset' ? (system.append ?? '') : system.text} rows={3} mono={false} disabled={readOnly} onChange={(v) => set({ system: { mode: 'preset', append: v || undefined } })} />
      </Field>
      <Field label="Allowed tools (one per line)" hint="Read, Write, Shell, Shell(<glob>), Mcp(<server>/<tool>), Url(<glob>)">
        <TextArea value={(cfg.allowedTools ?? []).join('\n')} rows={5} disabled={readOnly} onChange={(v) => set({ allowedTools: v.split('\n').map((s) => s.trim()).filter(Boolean) })} />
      </Field>
      <Field label="Denied tools (one per line)">
        <TextArea value={(cfg.disallowedTools ?? []).join('\n')} rows={2} disabled={readOnly} onChange={(v) => set({ disallowedTools: v.split('\n').map((s) => s.trim()).filter(Boolean) })} />
      </Field>
      <div className="field-row">
        <Field label="Unresolved requests">
          <select value={approval.onUnresolved ?? 'ask'} disabled={readOnly} onChange={(e) => set({ approval: { ...approval, onUnresolved: e.target.value } })}>
            <option value="ask">ask me</option>
            <option value="deny">deny</option>
          </select>
        </Field>
        <Field label="Approval timeout (s)">
          <input type="number" min={5} value={approval.timeoutSec ?? 1800} disabled={readOnly} onChange={(e) => set({ approval: { ...approval, timeoutSec: Number(e.target.value) || 1800 } })} />
        </Field>
        <Field label="On timeout">
          <select value={approval.onTimeout ?? 'deny'} disabled={readOnly} onChange={(e) => set({ approval: { ...approval, onTimeout: e.target.value } })}>
            <option value="deny">deny</option>
            <option value="allow">allow</option>
          </select>
        </Field>
      </div>
      <Field label="Auto-allow read-only tools">
        <input type="checkbox" checked={approval.autoAllowReadOnly ?? true} disabled={readOnly} onChange={(e) => set({ approval: { ...approval, autoAllowReadOnly: e.target.checked } })} />
      </Field>
      <div className="field-row">
        <Field label="Max premium requests">
          <input type="number" min={1} value={cfg.maxPremiumRequests ?? 30} disabled={readOnly} onChange={(e) => set({ maxPremiumRequests: Number(e.target.value) || 30 })} />
        </Field>
        <Field label="Max tool calls">
          <input type="number" min={1} value={cfg.maxToolCalls ?? 400} disabled={readOnly} onChange={(e) => set({ maxToolCalls: Number(e.target.value) || 400 })} />
        </Field>
        <Field label="Timeout (ms)">
          <input type="number" min={1000} value={cfg.timeoutMs ?? 1_800_000} disabled={readOnly} onChange={(e) => set({ timeoutMs: Number(e.target.value) || 1_800_000 })} />
        </Field>
      </div>
      <Field label="Working directory (relative to repo)">
        <input value={cfg.cwdRelative ?? ''} disabled={readOnly} onChange={(e) => set({ cwdRelative: e.target.value || undefined })} />
      </Field>
      <div className="field-row">
        <Field label="Isolation" hint="worktree: edits happen in a git worktree owned by this node">
          <select value={cfg.isolation ?? 'none'} disabled={readOnly} onChange={(e) => set({ isolation: e.target.value })}>
            <option value="none">none (repo root)</option>
            <option value="worktree">git worktree</option>
          </select>
        </Field>
        <WorktreeOfField value={cfg.worktreeOf} document={document} exclude={node.id} readOnly={readOnly} onChange={(v) => set({ worktreeOf: v })} />
      </div>
      <Field label="Agent mode">
        <select value={cfg.agentMode ?? 'interactive'} disabled={readOnly} onChange={(e) => set({ agentMode: e.target.value })}>
          <option value="interactive">interactive (default)</option>
          <option value="plan">plan (explore, do not edit)</option>
          <option value="autopilot">autopilot</option>
        </select>
      </Field>
      <Field label="Structured result schema (JSON Schema, optional)" hint="When set, the agent must call submit_result; the result appears on the json port (Judge pattern)">
        <TextArea
          value={cfg.outputSchema ? JSON.stringify(cfg.outputSchema, null, 2) : ''}
          rows={4}
          disabled={readOnly}
          onChange={(v) => {
            if (!v.trim()) return set({ outputSchema: undefined });
            try {
              set({ outputSchema: JSON.parse(v) as Record<string, unknown> });
            } catch {
              /* keep typing */
            }
          }}
        />
      </Field>
    </>
  );
}

function WorktreeOfField({ value, document, exclude, readOnly, onChange }: { value?: string; document: WorkflowDocument; exclude: string; readOnly: boolean; onChange(v: string | undefined): void }) {
  const owners = document.nodes.filter((n) => n.id !== exclude && n.type === 'agent.copilot' && (n.config as { isolation?: string } | undefined)?.isolation === 'worktree');
  return (
    <Field label="Run in worktree of" hint="Use another agent node's worktree (created on first use)">
      <select value={value ?? ''} disabled={readOnly} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">repo root</option>
        {owners.map((n) => (
          <option key={n.id} value={n.id}>
            {n.id}
          </option>
        ))}
        {value && !owners.some((n) => n.id === value) && <option value={value}>{value}</option>}
      </select>
    </Field>
  );
}

function GitFields({ node, readOnly, document }: { node: NodeBase; readOnly: boolean; document: WorkflowDocument }) {
  const [cfg, set] = useConfig<{ op?: string; target?: string; base?: string; message?: string; addAll?: boolean; remote?: string; title?: string; body?: string; draft?: boolean; force?: boolean; deleteBranch?: boolean }>(node);
  const owners = document.nodes.filter((n) => n.id !== node.id && n.type === 'agent.copilot' && (n.config as { isolation?: string } | undefined)?.isolation === 'worktree');
  const op = cfg.op ?? 'diff';
  return (
    <>
      <div className="field-row">
        <Field label="Operation">
          <select value={op} disabled={readOnly} onChange={(e) => set({ op: e.target.value })}>
            {['diff', 'commit', 'push', 'pr.create', 'worktree.remove', 'worktree.keep'].map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Worktree of node" hint="The agent node whose worktree this acts on">
          <select value={cfg.target ?? ''} disabled={readOnly} onChange={(e) => set({ target: e.target.value || undefined })}>
            <option value="">choose…</option>
            {owners.map((n) => (
              <option key={n.id} value={n.id}>
                {n.id}
              </option>
            ))}
            {cfg.target && !owners.some((n) => n.id === cfg.target) && <option value={cfg.target}>{cfg.target}</option>}
          </select>
        </Field>
      </div>
      {op === 'diff' && (
        <Field label="Base ref (optional)" hint="Defaults to HEAD of the worktree">
          <input value={cfg.base ?? ''} disabled={readOnly} onChange={(e) => set({ base: e.target.value || undefined })} />
        </Field>
      )}
      {op === 'commit' && (
        <Field label="Commit message" hint="Template">
          <TextArea value={cfg.message ?? ''} rows={3} mono={false} disabled={readOnly} onChange={(v) => set({ message: v })} />
        </Field>
      )}
      {op === 'push' && (
        <Field label="Remote">
          <input value={cfg.remote ?? 'origin'} disabled={readOnly} onChange={(e) => set({ remote: e.target.value })} />
        </Field>
      )}
      {op === 'pr.create' && (
        <>
          <Field label="Title" hint="Template">
            <input value={cfg.title ?? ''} disabled={readOnly} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label="Body" hint="Template, markdown">
            <TextArea value={cfg.body ?? ''} rows={5} mono={false} disabled={readOnly} onChange={(v) => set({ body: v })} />
          </Field>
          <Field label="Base branch (optional)">
            <input value={cfg.base ?? ''} disabled={readOnly} onChange={(e) => set({ base: e.target.value || undefined })} />
          </Field>
          <Field label="Draft">
            <input type="checkbox" checked={cfg.draft ?? true} disabled={readOnly} onChange={(e) => set({ draft: e.target.checked })} />
          </Field>
        </>
      )}
      {op === 'worktree.remove' && (
        <Field label="Delete branch too">
          <input type="checkbox" checked={cfg.deleteBranch ?? true} disabled={readOnly} onChange={(e) => set({ deleteBranch: e.target.checked })} />
        </Field>
      )}
    </>
  );
}

function GateFields({ node, readOnly }: { node: NodeBase; readOnly: boolean }) {
  const [cfg, set] = useConfig<{ title?: string; instructions?: string; show?: Array<{ label: string; expression: string; render: string }>; timeoutSec?: number; onTimeout?: string }>(node);
  const show = cfg.show ?? [];
  const update = (i: number, patch: Partial<{ label: string; expression: string; render: string }>) => set({ show: show.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <>
      <Field label="Title" hint="Template">
        <input value={cfg.title ?? ''} disabled={readOnly} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <Field label="Instructions" hint="Template, shown to the approver">
        <TextArea value={cfg.instructions ?? ''} rows={2} mono={false} disabled={readOnly} onChange={(v) => set({ instructions: v })} />
      </Field>
      <div className="field-label">Items to show</div>
      {show.map((s, i) => (
        <div key={i} className="show-item">
          <div className="field-row">
            <Field label="Label">
              <input value={s.label} disabled={readOnly} onChange={(e) => update(i, { label: e.target.value })} />
            </Field>
            <Field label="Render as">
              <select value={s.render} disabled={readOnly} onChange={(e) => update(i, { render: e.target.value })}>
                {['markdown', 'text', 'json', 'diff'].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Expression">
            <TextArea value={s.expression} rows={2} disabled={readOnly} onChange={(v) => update(i, { expression: v })} />
          </Field>
          {!readOnly && (
            <button className="link" onClick={() => set({ show: show.filter((_, j) => j !== i) })}>
              remove
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button className="btn" onClick={() => set({ show: [...show, { label: 'Item', expression: 'nodes.previous.text', render: 'markdown' }] })}>
          + add item
        </button>
      )}
      <div className="field-row" style={{ marginTop: 10 }}>
        <Field label="Timeout (s, optional)">
          <input type="number" min={1} value={cfg.timeoutSec ?? ''} disabled={readOnly} onChange={(e) => set({ timeoutSec: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
        <Field label="On timeout">
          <select value={cfg.onTimeout ?? 'reject'} disabled={readOnly} onChange={(e) => set({ onTimeout: e.target.value })}>
            <option value="reject">reject</option>
            <option value="approve">approve</option>
          </select>
        </Field>
      </div>
    </>
  );
}

function NotifyFields({ node, readOnly }: { node: NodeBase; readOnly: boolean }) {
  const [cfg, set] = useConfig<{ channel?: string; title?: string; message?: string; url?: string; level?: string }>(node);
  return (
    <>
      <div className="field-row">
        <Field label="Channel">
          <select value={cfg.channel ?? 'desktop'} disabled={readOnly} onChange={(e) => set({ channel: e.target.value })}>
            <option value="desktop">desktop (Orca UI)</option>
            <option value="webhook">webhook (POST JSON)</option>
          </select>
        </Field>
        <Field label="Level">
          <select value={cfg.level ?? 'info'} disabled={readOnly} onChange={(e) => set({ level: e.target.value })}>
            {['info', 'success', 'warning', 'error'].map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Title" hint="Template">
        <input value={cfg.title ?? ''} disabled={readOnly} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <Field label="Message" hint="Template">
        <TextArea value={cfg.message ?? ''} rows={3} mono={false} disabled={readOnly} onChange={(v) => set({ message: v })} />
      </Field>
      {cfg.channel === 'webhook' && (
        <Field label="URL">
          <input value={cfg.url ?? ''} disabled={readOnly} onChange={(e) => set({ url: e.target.value || undefined })} />
        </Field>
      )}
    </>
  );
}

function ShellFields({ node, readOnly, document }: { node: NodeBase; readOnly: boolean; document: WorkflowDocument }) {
  const [cfg, set] = useConfig<{ command?: string; shell?: string; cwdRelative?: string; timeoutMs?: number; failOnNonZero?: boolean; worktreeOf?: string }>(node);
  return (
    <>
      <Field label="Command" hint="Template. Runs in the repo directory.">
        <TextArea value={cfg.command ?? ''} rows={3} disabled={readOnly} onChange={(v) => set({ command: v })} />
      </Field>
      <WorktreeOfField value={cfg.worktreeOf} document={document} exclude={node.id} readOnly={readOnly} onChange={(v) => set({ worktreeOf: v })} />
      <div className="field-row">
        <Field label="Shell">
          <select value={cfg.shell ?? 'auto'} disabled={readOnly} onChange={(e) => set({ shell: e.target.value })}>
            {['auto', 'powershell', 'bash', 'cmd', 'sh'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timeout (ms)">
          <input type="number" min={1000} value={cfg.timeoutMs ?? 600_000} disabled={readOnly} onChange={(e) => set({ timeoutMs: Number(e.target.value) || 600_000 })} />
        </Field>
      </div>
      <Field label="Working directory (relative to repo)">
        <input value={cfg.cwdRelative ?? ''} disabled={readOnly} onChange={(e) => set({ cwdRelative: e.target.value || undefined })} />
      </Field>
      <Field label="Fail the node on non-zero exit" hint="Otherwise exit_code is just an output">
        <input type="checkbox" checked={cfg.failOnNonZero ?? false} disabled={readOnly} onChange={(e) => set({ failOnNonZero: e.target.checked })} />
      </Field>
    </>
  );
}

function ConditionFields({ node, readOnly }: { node: NodeBase; readOnly: boolean }) {
  const [cfg, set] = useConfig<{ expression?: string }>(node);
  return (
    <Field label="Expression" hint="JavaScript expression. Truthy routes to the true port.">
      <TextArea value={cfg.expression ?? ''} rows={3} disabled={readOnly} onChange={(v) => set({ expression: v })} />
    </Field>
  );
}

function LoopFields({ node, readOnly }: { node: NodeBase; readOnly: boolean }) {
  const [cfg, set] = useConfig<{ until?: string; maxIterations?: number }>(node);
  return (
    <>
      <Field label="Exit when (expression)" hint="Evaluated after each iteration against the body's outputs (nodes.<child>.<port>).">
        <TextArea value={cfg.until ?? ''} rows={2} disabled={readOnly} onChange={(v) => set({ until: v })} />
      </Field>
      <Field label="Max iterations">
        <input type="number" min={1} max={100} value={cfg.maxIterations ?? 5} disabled={readOnly} onChange={(e) => set({ maxIterations: Number(e.target.value) || 1 })} />
      </Field>
      <div className="note">Body nodes: drag nodes into this loop's box. Inside the body, iteration.index and iteration.previous are available.</div>
    </>
  );
}

function TransformFields({ node, readOnly }: { node: NodeBase; readOnly: boolean }) {
  const [cfg, set] = useConfig<{ code?: string }>(node);
  return (
    <Field label="Function body" hint="JavaScript. `ctx` has inputs, nodes, iteration, run, env. Return the value.">
      <TextArea value={cfg.code ?? ''} rows={8} disabled={readOnly} onChange={(v) => set({ code: v })} />
    </Field>
  );
}

// ---------------------------------------------------------------- edge inspector
function EdgeInspector({ edge, readOnly }: InspectorProps & { edge: WorkflowDocument['edges'][number] }) {
  const editor = useEditor();
  return (
    <div className="inspector">
      <div className="panel-title">Edge</div>
      <div className="note">
        {edge.from.node}.{edge.from.port} → {edge.to.node}.{edge.to.port}
      </div>
      <Field label="Guard expression (optional)" hint="The edge only fires when this is truthy">
        <TextArea
          value={edge.when ?? ''}
          rows={2}
          disabled={readOnly}
          onChange={(v) =>
            editor.update((d) => {
              const e = d.edges.find((x) => x.id === edge.id);
              if (e) e.when = v || undefined;
            })
          }
        />
      </Field>
      {!readOnly && (
        <button className="btn btn-danger" onClick={() => editor.removeEdges([edge.id])}>
          Delete edge
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- workflow inspector
function WorkflowInspector({ document, diagnostics, models, readOnly }: InspectorProps) {
  const editor = useEditor();
  const s = document.settings;
  return (
    <div className="inspector">
      <div className="panel-title">Workflow</div>
      <Field label="Name">
        <input value={document.name} disabled={readOnly} onChange={(e) => editor.update((d) => (d.name = e.target.value))} />
      </Field>
      <Field label="Description">
        <TextArea value={document.description ?? ''} rows={2} mono={false} disabled={readOnly} onChange={(v) => editor.update((d) => (d.description = v || undefined))} />
      </Field>
      <Field label="Repository path" hint="Relative to the workflow file; defaults to the repo containing .orca/">
        <input value={s.repoPath ?? ''} disabled={readOnly} onChange={(e) => editor.update((d) => (d.settings.repoPath = e.target.value || undefined))} />
      </Field>
      <Field label="Default model">
        <select value={s.defaultModel} disabled={readOnly} onChange={(e) => editor.update((d) => (d.settings.defaultModel = e.target.value))}>
          {!models.some((m) => m.id === s.defaultModel) && <option value={s.defaultModel}>{s.defaultModel}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.id})
            </option>
          ))}
        </select>
      </Field>
      <div className="field-row">
        <Field label="Default effort">
          <select value={s.defaultEffort} disabled={readOnly} onChange={(e) => editor.update((d) => (d.settings.defaultEffort = e.target.value as typeof s.defaultEffort))}>
            {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Run budget (premium requests)">
          <input type="number" min={1} value={s.runBudgetPremiumRequests} disabled={readOnly} onChange={(e) => editor.update((d) => (d.settings.runBudgetPremiumRequests = Number(e.target.value) || 1))} />
        </Field>
        <Field label="Concurrent agents">
          <input type="number" min={1} max={16} value={s.maxConcurrentAgents} disabled={readOnly} onChange={(e) => editor.update((d) => (d.settings.maxConcurrentAgents = Number(e.target.value) || 1))} />
        </Field>
      </div>
      <div className="panel-title">Problems ({diagnostics.length})</div>
      <div className="diag-list">
        {diagnostics.length === 0 && <div className="note">No problems.</div>}
        {diagnostics.map((d, i) => (
          <div key={i} className={`diag diag-${d.severity}`} onClick={() => d.nodeId && editor.select(d.nodeId)}>
            {d.message}
          </div>
        ))}
      </div>
    </div>
  );
}
