import {
  getNodeType,
  nodeInputs,
  nodeOutputs,
  referencedNodeIds,
  templateExpressions,
  getPath,
  type Diagnostic,
  type Edge,
  type NodeBase,
  type NodeTypeDef,
  type PortDecl,
  type WorkflowDocument,
} from '@orca/shared';

export interface PlannedNode {
  node: NodeBase;
  def: NodeTypeDef;
  /** Parsed config (zod output with defaults applied). */
  config: unknown;
  /** Node ids referenced from templates/expressions in this node's config. */
  refs: Set<string>;
  parent?: string;
}

export interface ExecutionPlan {
  nodes: Map<string, PlannedNode>;
  edgesByTarget: Map<string, Edge[]>;
  edgesBySource: Map<string, Edge[]>;
  /** Children per container node id, in document order. */
  children: Map<string, string[]>;
  /** Top-level node ids (no parent). */
  topLevel: string[];
  /** Nodes with no incoming edges in their sibling set. */
  entryNodes: Set<string>;
}

export interface CompileResult {
  plan?: ExecutionPlan;
  diagnostics: Diagnostic[];
  get ok(): boolean;
}

export function compileWorkflow(doc: WorkflowDocument): CompileResult {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string, extra: Partial<Diagnostic> = {}) => diagnostics.push({ severity: 'error', code, message, ...extra });
  const warn = (code: string, message: string, extra: Partial<Diagnostic> = {}) => diagnostics.push({ severity: 'warning', code, message, ...extra });

  const nodes = new Map<string, PlannedNode>();
  const seen = new Set<string>();
  for (const node of doc.nodes) {
    if (seen.has(node.id)) {
      error('duplicate_node', `duplicate node id "${node.id}"`, { nodeId: node.id });
      continue;
    }
    seen.add(node.id);
    const def = getNodeType(node.type);
    if (!def) {
      error('unknown_node_type', `unknown node type "${node.type}"`, { nodeId: node.id });
      continue;
    }
    const parsed = def.config.safeParse(node.config ?? {});
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        error('invalid_config', `${node.id}: ${issue.path.join('.') || 'config'}: ${issue.message}`, { nodeId: node.id, path: issue.path.join('.') });
      }
      continue;
    }
    const refs = new Set<string>();
    collectRefs(def, parsed.data, refs);
    nodes.set(node.id, { node, def, config: parsed.data, refs, parent: node.parent });
  }

  // containers and parents
  const children = new Map<string, string[]>();
  const topLevel: string[] = [];
  for (const pn of nodes.values()) {
    if (pn.parent) {
      const parent = nodes.get(pn.parent);
      if (!parent) {
        error('missing_parent', `${pn.node.id}: parent "${pn.parent}" does not exist`, { nodeId: pn.node.id });
        continue;
      }
      if (!parent.def.container) {
        error('parent_not_container', `${pn.node.id}: parent "${pn.parent}" is not a container node`, { nodeId: pn.node.id });
        continue;
      }
      if (parent.parent) error('nested_container', `${pn.node.id}: nested containers are not supported yet`, { nodeId: pn.node.id });
      const list = children.get(pn.parent) ?? [];
      list.push(pn.node.id);
      children.set(pn.parent, list);
    } else {
      topLevel.push(pn.node.id);
    }
  }
  for (const pn of nodes.values()) {
    if (pn.def.container && !(children.get(pn.node.id)?.length)) warn('empty_container', `${pn.node.id}: loop has no body nodes`, { nodeId: pn.node.id });
  }

  // edges
  const edgesByTarget = new Map<string, Edge[]>();
  const edgesBySource = new Map<string, Edge[]>();
  const edgeIds = new Set<string>();
  for (const edge of doc.edges) {
    if (edgeIds.has(edge.id)) {
      error('duplicate_edge', `duplicate edge id "${edge.id}"`, { edgeId: edge.id });
      continue;
    }
    edgeIds.add(edge.id);
    const from = nodes.get(edge.from.node);
    const to = nodes.get(edge.to.node);
    if (!from || !to) {
      error('edge_missing_node', `edge ${edge.id} references a missing node`, { edgeId: edge.id });
      continue;
    }
    const outPort = nodeOutputs(from.def).find((p) => p.id === edge.from.port);
    const inPort = nodeInputs(to.def).find((p) => p.id === edge.to.port);
    if (!outPort) {
      error('edge_missing_port', `edge ${edge.id}: node "${from.node.id}" has no output port "${edge.from.port}"`, { edgeId: edge.id });
      continue;
    }
    if (!inPort) {
      error('edge_missing_port', `edge ${edge.id}: node "${to.node.id}" has no input port "${edge.to.port}"`, { edgeId: edge.id });
      continue;
    }
    if (!portsCompatible(outPort, inPort)) {
      error('edge_type_mismatch', `edge ${edge.id}: cannot connect ${outPort.type} to ${inPort.type}`, { edgeId: edge.id });
      continue;
    }
    if ((from.parent ?? null) !== (to.parent ?? null)) {
      error('edge_crosses_container', `edge ${edge.id}: edges must stay within the same container; connect the container node instead`, { edgeId: edge.id });
      continue;
    }
    if (from.node.id === to.node.id) {
      error('edge_self', `edge ${edge.id}: a node cannot connect to itself`, { edgeId: edge.id });
      continue;
    }
    push(edgesByTarget, to.node.id, edge);
    push(edgesBySource, from.node.id, edge);
  }

  // cycles within each sibling set
  const siblingSets: string[][] = [topLevel, ...children.values()];
  for (const set of siblingSets) {
    const cycle = findCycle(set, edgesBySource);
    if (cycle) error('cycle', `cycle detected: ${cycle.join(' -> ')}. Use a Loop node for iteration.`, { nodeId: cycle[0] });
  }

  // entry nodes
  const entryNodes = new Set<string>();
  for (const set of siblingSets) for (const id of set) if (!(edgesByTarget.get(id)?.length)) entryNodes.add(id);

  // reference validation: a node may reference top-level nodes, and siblings in its own container
  for (const pn of nodes.values()) {
    for (const ref of pn.refs) {
      const target = nodes.get(ref);
      if (!target) {
        error('unknown_ref', `${pn.node.id}: references unknown node "${ref}"`, { nodeId: pn.node.id });
        continue;
      }
      // Visible: top-level nodes, siblings in the same container, and (for a container) its own body nodes.
      const visible = !target.parent || target.parent === pn.parent || target.parent === pn.node.id;
      if (!visible) error('ref_not_visible', `${pn.node.id}: "${ref}" is inside a container and not visible here; reference the container's outputs instead`, { nodeId: pn.node.id });
      if (target.parent === pn.node.id) continue; // container reading its body after each iteration
      if (target.parent && target.parent === pn.parent && !reaches(target.node.id, pn.node.id, edgesBySource) && target.node.id !== pn.node.id) {
        warn('ref_not_upstream', `${pn.node.id}: references "${ref}" which is not upstream in the same scope; it may not have run yet`, { nodeId: pn.node.id });
      }
      if (!target.parent && !pn.parent && !reaches(target.node.id, pn.node.id, edgesBySource)) {
        warn('ref_not_upstream', `${pn.node.id}: references "${ref}" which is not upstream; it may not have run yet`, { nodeId: pn.node.id });
      }
    }
  }

  // policy checks
  for (const pn of nodes.values()) {
    if (pn.def.type === 'agent.copilot') {
      const cfg = pn.config as { isolation: string; allowedTools: string[] };
      if (cfg.isolation === 'none' && cfg.allowedTools.includes('Write')) warn('writer_not_isolated', `${pn.node.id}: agent can write files but is not isolated in a worktree`, { nodeId: pn.node.id });
    }
    if (!pn.parent && pn.def.category !== 'trigger' && !(edgesByTarget.get(pn.node.id)?.length)) {
      warn('orphan_node', `${pn.node.id}: has no incoming edges and will run at start`, { nodeId: pn.node.id });
    }
  }
  const triggers = [...nodes.values()].filter((n) => n.def.category === 'trigger');
  if (triggers.length === 0) warn('no_trigger', 'workflow has no trigger node');

  const ok = diagnostics.every((d) => d.severity !== 'error');
  const plan: ExecutionPlan | undefined = ok ? { nodes, edgesByTarget, edgesBySource, children, topLevel, entryNodes } : undefined;
  return {
    plan,
    diagnostics,
    get ok() {
      return ok;
    },
  };
}

function collectRefs(def: NodeTypeDef, config: unknown, refs: Set<string>): void {
  for (const field of def.templateFields ?? []) {
    const v = getPath(config, field);
    if (typeof v === 'string') for (const expr of templateExpressions(v)) for (const id of referencedNodeIds(expr)) refs.add(id);
  }
  const c = config as Record<string, unknown>;
  for (const key of ['expression', 'until', 'code']) {
    const v = c[key];
    if (typeof v === 'string') for (const id of referencedNodeIds(v)) refs.add(id);
  }
}

function portsCompatible(out: PortDecl, inp: PortDecl): boolean {
  if (inp.type === 'trigger') return true; // any completion can trigger
  if (out.type === 'trigger') return false; // a trigger carries no data
  if (inp.type === 'any' || out.type === 'any') return true;
  return out.type === inp.type;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function findCycle(ids: string[], edgesBySource: Map<string, Edge[]>): string[] | undefined {
  const set = new Set(ids);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    for (const e of edgesBySource.get(id) ?? []) {
      const next = e.to.node;
      if (!set.has(next)) continue;
      const s = state.get(next) ?? 0;
      if (s === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (s === 0) {
        const c = visit(next);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of ids) if ((state.get(id) ?? 0) === 0) {
    const c = visit(id);
    if (c) return c;
  }
  return undefined;
}

function reaches(from: string, to: string, edgesBySource: Map<string, Edge[]>): boolean {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of edgesBySource.get(cur) ?? []) queue.push(e.to.node);
  }
  return false;
}
