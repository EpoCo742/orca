import { create } from 'zustand';
import type { Diagnostic, NodeBase, WorkflowDetail, WorkflowDocument } from '@orca/shared';
import { getNodeType } from '@orca/shared';

export interface EditorState {
  detail?: WorkflowDetail;
  document?: WorkflowDocument;
  dirty: boolean;
  diagnostics: Diagnostic[];
  selectedNodeId?: string;
  selectedEdgeId?: string;
  history: WorkflowDocument[];
  future: WorkflowDocument[];

  load(detail: WorkflowDetail): void;
  clear(): void;
  select(nodeId?: string, edgeId?: string): void;
  /** Apply a document mutation; records undo history. */
  update(mutate: (doc: WorkflowDocument) => void, opts?: { history?: boolean }): void;
  updateNode(nodeId: string, mutate: (node: NodeBase) => void): void;
  updateNodeConfig(nodeId: string, patch: Record<string, unknown>): void;
  renameNode(oldId: string, newId: string): boolean;
  addNode(type: string, position: { x: number; y: number }, parent?: string): string;
  removeNodes(ids: string[]): void;
  removeEdges(ids: string[]): void;
  setDiagnostics(d: Diagnostic[]): void;
  markSaved(detail: WorkflowDetail): void;
  undo(): void;
  redo(): void;
}

function defaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case 'trigger.manual':
      return {};
    case 'agent.copilot':
      return { prompt: 'Describe the task for the agent here. Use {{ nodes.<id>.<port> }} to insert upstream outputs.' };
    case 'action.shell':
      return { command: 'npm test' };
    case 'control.condition':
      return { expression: 'nodes.previous.exit_code === 0' };
    case 'control.loop':
      return { until: 'nodes.body.exit_code === 0', maxIterations: 5 };
    case 'data.transform':
      return { code: 'return ctx.inputs' };
    default:
      return {};
  }
}

function uniqueId(doc: WorkflowDocument, base: string): string {
  const existing = new Set(doc.nodes.map((n) => n.id));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

const MAX_HISTORY = 100;

export const useEditor = create<EditorState>((set, get) => ({
  dirty: false,
  diagnostics: [],
  history: [],
  future: [],

  load(detail) {
    set({ detail, document: structuredClone(detail.document), dirty: false, diagnostics: detail.diagnostics, selectedNodeId: undefined, selectedEdgeId: undefined, history: [], future: [] });
  },
  clear() {
    set({ detail: undefined, document: undefined, dirty: false, diagnostics: [], selectedNodeId: undefined, selectedEdgeId: undefined, history: [], future: [] });
  },
  select(nodeId, edgeId) {
    set({ selectedNodeId: nodeId, selectedEdgeId: edgeId });
  },
  update(mutate, opts = {}) {
    const doc = get().document;
    if (!doc) return;
    const next = structuredClone(doc);
    mutate(next);
    const history = opts.history === false ? get().history : [...get().history.slice(-MAX_HISTORY + 1), doc];
    set({ document: next, dirty: true, history, future: opts.history === false ? get().future : [] });
  },
  updateNode(nodeId, mutate) {
    get().update((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (n) mutate(n);
    });
  },
  updateNodeConfig(nodeId, patch) {
    get().updateNode(nodeId, (n) => {
      n.config = { ...((n.config as Record<string, unknown>) ?? {}), ...patch };
    });
  },
  renameNode(oldId, newId) {
    const doc = get().document;
    if (!doc || !/^[a-z][a-z0-9_]{0,63}$/.test(newId) || doc.nodes.some((n) => n.id === newId)) return false;
    get().update((d) => {
      for (const n of d.nodes) {
        if (n.id === oldId) n.id = newId;
        if (n.parent === oldId) n.parent = newId;
        // rewrite references in string config fields
        n.config = rewriteRefs(n.config, oldId, newId);
      }
      for (const e of d.edges) {
        if (e.from.node === oldId) e.from.node = newId;
        if (e.to.node === oldId) e.to.node = newId;
        if (e.when) e.when = rewriteRefsInString(e.when, oldId, newId);
      }
    });
    set({ selectedNodeId: newId });
    return true;
  },
  addNode(type, position, parent) {
    const doc = get().document;
    if (!doc) return '';
    const def = getNodeType(type);
    const base = (def?.label ?? type.split('.').pop() ?? 'node').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
    const id = uniqueId(doc, base);
    get().update((d) => {
      const node: NodeBase = { id, type, position, disabled: false, retry: { maxAttempts: 1, backoffMs: 2000, retryOn: ['error', 'timeout'] }, config: defaultConfig(type) };
      if (parent) node.parent = parent;
      if (def?.container) node.size = { w: 640, h: 300 };
      d.nodes.push(node);
    });
    set({ selectedNodeId: id, selectedEdgeId: undefined });
    return id;
  },
  removeNodes(ids) {
    const set_ = new Set(ids);
    get().update((d) => {
      // also remove children of removed containers
      for (const n of d.nodes) if (n.parent && set_.has(n.parent)) set_.add(n.id);
      d.nodes = d.nodes.filter((n) => !set_.has(n.id));
      d.edges = d.edges.filter((e) => !set_.has(e.from.node) && !set_.has(e.to.node));
    });
    if (get().selectedNodeId && set_.has(get().selectedNodeId!)) set({ selectedNodeId: undefined });
  },
  removeEdges(ids) {
    const s = new Set(ids);
    get().update((d) => {
      d.edges = d.edges.filter((e) => !s.has(e.id));
    });
    if (get().selectedEdgeId && s.has(get().selectedEdgeId!)) set({ selectedEdgeId: undefined });
  },
  setDiagnostics(diagnostics) {
    set({ diagnostics });
  },
  markSaved(detail) {
    set({ detail, dirty: false, diagnostics: detail.diagnostics });
  },
  undo() {
    const { history, document, future } = get();
    if (!history.length || !document) return;
    const prev = history[history.length - 1]!;
    set({ document: prev, history: history.slice(0, -1), future: [document, ...future].slice(0, MAX_HISTORY), dirty: true });
  },
  redo() {
    const { history, document, future } = get();
    if (!future.length || !document) return;
    const next = future[0]!;
    set({ document: next, future: future.slice(1), history: [...history, document].slice(-MAX_HISTORY), dirty: true });
  },
}));

function rewriteRefsInString(s: string, oldId: string, newId: string): string {
  return s.replace(new RegExp(`\\bnodes\\s*\\.\\s*${oldId}\\b`, 'g'), `nodes.${newId}`).replace(new RegExp(`\\bnodes\\s*\\[\\s*(['"])${oldId}\\1\\s*\\]`, 'g'), `nodes['${newId}']`);
}

function rewriteRefs(value: unknown, oldId: string, newId: string): unknown {
  if (typeof value === 'string') return rewriteRefsInString(value, oldId, newId);
  if (Array.isArray(value)) return value.map((v) => rewriteRefs(v, oldId, newId));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = rewriteRefs(v, oldId, newId);
    return out;
  }
  return value;
}
