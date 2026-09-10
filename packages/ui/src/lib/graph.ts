import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';
import { getNodeType, nodeInputs, nodeOutputs, nodeKey, type Diagnostic, type NodeBase, type NodeRunState, type PortDecl, type RunProjection, type WorkflowDocument } from '@orca/shared';

export interface OrcaNodeData extends Record<string, unknown> {
  node: NodeBase;
  label: string;
  typeLabel: string;
  category: string;
  inputs: PortDecl[];
  outputs: PortDecl[];
  container?: 'loop' | 'map';
  status?: NodeRunState['status'];
  runState?: NodeRunState;
  iteration?: number;
  hasError?: boolean;
  hasWarning?: boolean;
  subtitle?: string;
}

export type OrcaRFNode = RFNode<OrcaNodeData, 'orca' | 'loop'>;

export function subtitleFor(node: NodeBase): string {
  const c = (node.config ?? {}) as Record<string, unknown>;
  switch (node.type) {
    case 'action.shell':
      return String(c.command ?? '');
    case 'control.condition':
      return String(c.expression ?? '');
    case 'control.loop':
      return `until ${String(c.until ?? '')} (max ${String(c.maxIterations ?? '')})`;
    case 'agent.copilot':
      return `${String(c.model ?? 'default model')} · ${String(c.prompt ?? '').slice(0, 60)}`;
    case 'data.transform':
      return String(c.code ?? '').split('\n')[0] ?? '';
    default:
      return '';
  }
}

/** Convert a document to React Flow nodes/edges, optionally decorated with run state. */
export function toFlow(doc: WorkflowDocument, opts: { diagnostics?: Diagnostic[]; run?: RunProjection } = {}): { nodes: OrcaRFNode[]; edges: RFEdge[] } {
  const errs = new Set((opts.diagnostics ?? []).filter((d) => d.severity === 'error' && d.nodeId).map((d) => d.nodeId!));
  const warns = new Set((opts.diagnostics ?? []).filter((d) => d.severity === 'warning' && d.nodeId).map((d) => d.nodeId!));
  const containers = doc.nodes.filter((n) => getNodeType(n.type)?.container);
  const others = doc.nodes.filter((n) => !getNodeType(n.type)?.container);
  const ordered = [...containers, ...others]; // parents first, as React Flow requires
  const nodes: OrcaRFNode[] = ordered.map((n) => {
    const def = getNodeType(n.type);
    const state = opts.run ? bestState(opts.run, n, doc) : undefined;
    const iteration = opts.run && def?.container ? opts.run.iterations[nodeKey(n.id, '')] : undefined;
    return {
      id: n.id,
      type: def?.container ? 'loop' : 'orca',
      position: n.position,
      parentId: n.parent,
      extent: n.parent ? 'parent' : undefined,
      style: def?.container ? { width: n.size?.w ?? 640, height: n.size?.h ?? 300 } : undefined,
      data: {
        node: n,
        label: n.label ?? n.id,
        typeLabel: def?.label ?? n.type,
        category: def?.category ?? 'action',
        inputs: def ? nodeInputs(def) : [],
        outputs: def ? nodeOutputs(def) : [],
        container: def?.container,
        status: state?.status,
        runState: state,
        iteration,
        hasError: errs.has(n.id),
        hasWarning: warns.has(n.id),
        subtitle: subtitleFor(n),
      },
      selectable: true,
      draggable: !opts.run,
      connectable: !opts.run,
    };
  });
  const edges: RFEdge[] = doc.edges.map((e) => ({
    id: e.id,
    source: e.from.node,
    sourceHandle: e.from.port,
    target: e.to.node,
    targetHandle: e.to.port,
    label: e.from.port === 'done' && e.to.port === 'trigger' ? undefined : `${e.from.port} → ${e.to.port}`,
    animated: false,
    data: { when: e.when },
    className: e.when ? 'edge-guarded' : undefined,
  }));
  return { nodes, edges };
}

/** For run decoration: a node inside a loop shows the state of its most recent iteration. */
function bestState(run: RunProjection, n: NodeBase, doc: WorkflowDocument): NodeRunState | undefined {
  if (!n.parent) return run.nodes[nodeKey(n.id, '')];
  const parent = doc.nodes.find((p) => p.id === n.parent);
  if (!parent) return undefined;
  const idx = run.iterations[nodeKey(parent.id, '')];
  if (idx === undefined) return undefined;
  for (let i = idx; i >= 0; i--) {
    const st = run.nodes[nodeKey(n.id, `${parent.id}[${i}]`)];
    if (st) return st;
  }
  return undefined;
}

export function portTypesCompatible(outType: PortDecl['type'], inType: PortDecl['type']): boolean {
  if (inType === 'trigger') return true;
  if (outType === 'trigger') return false;
  if (inType === 'any' || outType === 'any') return true;
  return outType === inType;
}

export function edgeId(from: string, fromPort: string, to: string, toPort: string): string {
  return `${from}.${fromPort}->${to}.${toPort}`;
}

export function nodeOutputsFor(doc: WorkflowDocument, nodeId: string): PortDecl[] {
  const n = doc.nodes.find((x) => x.id === nodeId);
  const def = n ? getNodeType(n.type) : undefined;
  return def ? nodeOutputs(def) : [];
}

export function nodeInputsFor(doc: WorkflowDocument, nodeId: string): PortDecl[] {
  const n = doc.nodes.find((x) => x.id === nodeId);
  const def = n ? getNodeType(n.type) : undefined;
  return def ? nodeInputs(def) : [];
}
