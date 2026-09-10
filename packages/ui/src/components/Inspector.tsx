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
      {node.type === 'action.shell' && <ShellFields node={node} readOnly={readOnly} />}
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
    </>
  );
}

function ShellFields({ node, readOnly }: { node: NodeBase; readOnly: boolean }) {
  const [cfg, set] = useConfig<{ command?: string; shell?: string; cwdRelative?: string; timeoutMs?: number; failOnNonZero?: boolean }>(node);
  return (
    <>
      <Field label="Command" hint="Template. Runs in the repo directory.">
        <TextArea value={cfg.command ?? ''} rows={3} disabled={readOnly} onChange={(v) => set({ command: v })} />
      </Field>
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
