import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge as RFEdge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getNodeType, type RunProjection, type WorkflowDocument, type Diagnostic } from '@orca/shared';
import { edgeId, nodeInputsFor, nodeOutputsFor, portTypesCompatible, toFlow, type OrcaRFNode } from '../lib/graph.js';
import { nodeTypes } from './nodes.js';
import { useEditor } from '../store/editor.js';

export interface CanvasProps {
  document: WorkflowDocument;
  diagnostics: Diagnostic[];
  run?: RunProjection;
  readOnly: boolean;
  selectedNodeId?: string;
  onSelectNode(id?: string, edgeId?: string): void;
}

function CanvasInner({ document, diagnostics, run, readOnly, selectedNodeId, onSelectNode }: CanvasProps) {
  const rf = useReactFlow();
  const editor = useEditor();
  const derived = useMemo(() => toFlow(document, { diagnostics, run }), [document, diagnostics, run]);
  const [nodes, setNodes] = useState<OrcaRFNode[]>(derived.nodes);
  const [edges, setEdges] = useState<RFEdge[]>(derived.edges);
  const dragging = useRef(false);

  // Resync local flow state from the document whenever it changes (except mid-drag).
  useEffect(() => {
    if (dragging.current) return;
    setNodes(derived.nodes.map((n) => ({ ...n, selected: n.id === selectedNodeId })));
    setEdges(derived.edges);
  }, [derived, selectedNodeId]);

  const onNodesChange = useCallback(
    (changes: NodeChange<OrcaRFNode>[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      for (const ch of changes) if (ch.type === 'select' && ch.selected) onSelectNode(ch.id, undefined);
      if (readOnly) return;
      for (const ch of changes) {
        if (ch.type === 'position' && ch.dragging) dragging.current = true;
        if (ch.type === 'position' && ch.dragging === false) {
          dragging.current = false;
          if (ch.position) {
            const pos = ch.position;
            editor.updateNode(ch.id, (n) => {
              n.position = { x: Math.round(pos.x), y: Math.round(pos.y) };
            });
          }
        }
        if (ch.type === 'dimensions' && ch.resizing === false && ch.dimensions) {
          const dims = ch.dimensions;
          const target = document.nodes.find((n) => n.id === ch.id);
          if (target && getNodeType(target.type)?.container) {
            editor.updateNode(ch.id, (n) => {
              n.size = { w: Math.round(dims.width), h: Math.round(dims.height) };
            });
          }
        }
        if (ch.type === 'remove') editor.removeNodes([ch.id]);
      }
    },
    [editor, readOnly, onSelectNode, document.nodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((es) => applyEdgeChanges(changes, es));
      for (const ch of changes) if (ch.type === 'select' && ch.selected) onSelectNode(undefined, ch.id);
      if (readOnly) return;
      const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
      if (removed.length) editor.removeEdges(removed);
    },
    [editor, readOnly, onSelectNode],
  );

  const isValidConnection: IsValidConnection = useCallback(
    (c) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle || c.source === c.target) return false;
      const out = nodeOutputsFor(document, c.source).find((p) => p.id === c.sourceHandle);
      const inp = nodeInputsFor(document, c.target).find((p) => p.id === c.targetHandle);
      if (!out || !inp || !portTypesCompatible(out.type, inp.type)) return false;
      const a = document.nodes.find((n) => n.id === c.source);
      const b = document.nodes.find((n) => n.id === c.target);
      return (a?.parent ?? null) === (b?.parent ?? null);
    },
    [document],
  );

  const onConnect: OnConnect = useCallback(
    (c: Connection) => {
      if (readOnly || !c.source || !c.target) return;
      const from = { node: c.source, port: c.sourceHandle ?? 'done' };
      const to = { node: c.target, port: c.targetHandle ?? 'trigger' };
      const id = edgeId(from.node, from.port, to.node, to.port);
      editor.update((d) => {
        if (!d.edges.some((e) => e.id === id)) d.edges.push({ id, from, to });
      });
    },
    [editor, readOnly],
  );

  // Drag from palette
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (readOnly) return;
      const type = e.dataTransfer.getData('application/orca-node-type');
      if (!type) return;
      const position = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const container = findContainerAt(document, position);
      const rel = container ? { x: position.x - container.position.x, y: position.y - container.position.y } : position;
      editor.addNode(type, { x: Math.round(rel.x), y: Math.round(rel.y) }, container?.id);
    },
    [rf, editor, readOnly, document],
  );

  // Drop an existing node into / out of a loop container on drag stop
  const onNodeDragStop = useCallback(
    (_e: unknown, node: OrcaRFNode) => {
      if (readOnly || node.type === 'loop') return;
      const abs = node.parentId ? { x: (document.nodes.find((n) => n.id === node.parentId)?.position.x ?? 0) + node.position.x, y: (document.nodes.find((n) => n.id === node.parentId)?.position.y ?? 0) + node.position.y } : node.position;
      const container = findContainerAt(document, { x: abs.x + 20, y: abs.y + 20 });
      const current = document.nodes.find((n) => n.id === node.id)?.parent;
      if ((container?.id ?? undefined) === current) return;
      editor.update((d) => {
        const n = d.nodes.find((x) => x.id === node.id);
        if (!n) return;
        if (container) {
          n.parent = container.id;
          n.position = { x: Math.round(abs.x - container.position.x), y: Math.round(abs.y - container.position.y) };
        } else {
          delete n.parent;
          n.position = { x: Math.round(abs.x), y: Math.round(abs.y) };
        }
        // edges cannot cross containers: drop those that now do
        d.edges = d.edges.filter((e) => {
          const a = d.nodes.find((x) => x.id === e.from.node);
          const b = d.nodes.find((x) => x.id === e.to.node);
          return (a?.parent ?? null) === (b?.parent ?? null);
        });
      });
    },
    [document, editor, readOnly],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onNodeDragStop={onNodeDragStop}
      onPaneClick={() => onSelectNode(undefined, undefined)}
      onDragOver={onDragOver}
      onDrop={onDrop}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      elementsSelectable
      deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: 'smoothstep' }}
    >
      <Background gap={20} />
      <Controls />
      <MiniMap pannable zoomable style={{ width: 160, height: 100 }} />
    </ReactFlow>
  );
}

function findContainerAt(doc: WorkflowDocument, p: { x: number; y: number }) {
  return doc.nodes.find((n) => {
    if (!getNodeType(n.type)?.container) return false;
    const w = n.size?.w ?? 640;
    const h = n.size?.h ?? 300;
    return p.x >= n.position.x && p.x <= n.position.x + w && p.y >= n.position.y && p.y <= n.position.y + h;
  });
}

export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
