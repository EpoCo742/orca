import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import type { PortDecl } from '@orca/shared';
import type { OrcaRFNode } from '../lib/graph.js';

const CATEGORY_ICON: Record<string, string> = { trigger: '▶', agent: '✦', action: '⚙', control: '⑂', data: 'ƒ' };

function statusClass(status?: string): string {
  return status ? `status-${status}` : '';
}

function PortRow({ port, side }: { port: PortDecl; side: 'in' | 'out' }) {
  const isTrigger = port.type === 'trigger';
  return (
    <div className={`port port-${side} ${isTrigger ? 'port-trigger' : 'port-data'}`} title={`${port.id}: ${port.type}${port.description ? ` — ${port.description}` : ''}`}>
      <Handle type={side === 'in' ? 'target' : 'source'} position={side === 'in' ? Position.Left : Position.Right} id={port.id} className={`handle ${isTrigger ? 'handle-trigger' : 'handle-data'}`} />
      <span className="port-label">{port.label ?? port.id}</span>
    </div>
  );
}

export function OrcaNode({ data, selected }: NodeProps<OrcaRFNode>) {
  const cost = data.runState?.cost;
  return (
    <div className={`orca-node cat-${data.category} ${statusClass(data.status)} ${selected ? 'selected' : ''} ${data.node.disabled ? 'disabled' : ''}`}>
      <div className="node-header">
        <span className="node-icon">{CATEGORY_ICON[data.category] ?? '•'}</span>
        <span className="node-title">{data.label}</span>
        {data.hasError && <span className="badge badge-error" title="has errors">!</span>}
        {!data.hasError && data.hasWarning && <span className="badge badge-warn" title="has warnings">?</span>}
        {data.status && <span className={`status-dot ${statusClass(data.status)}`} title={data.status} />}
      </div>
      <div className="node-type">{data.typeLabel}</div>
      {data.subtitle && <div className="node-subtitle">{data.subtitle}</div>}
      {data.runState && (
        <div className="node-runinfo">
          {data.status}
          {data.runState.attempt > 1 ? ` · attempt ${data.runState.attempt}` : ''}
          {cost ? ` · ${cost.amount} ${cost.unit === 'premium_requests' ? 'PR' : '$'}` : ''}
        </div>
      )}
      <div className="node-ports">
        <div className="ports-in">
          {data.inputs.map((p) => (
            <PortRow key={p.id} port={p} side="in" />
          ))}
        </div>
        <div className="ports-out">
          {data.outputs.map((p) => (
            <PortRow key={p.id} port={p} side="out" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function LoopNode({ data, selected }: NodeProps<OrcaRFNode>) {
  return (
    <div className={`orca-node orca-loop cat-control ${statusClass(data.status)} ${selected ? 'selected' : ''}`}>
      <NodeResizer minWidth={320} minHeight={160} isVisible={selected} lineClassName="resizer-line" handleClassName="resizer-handle" />
      <div className="node-header">
        <span className="node-icon">↻</span>
        <span className="node-title">{data.label}</span>
        {data.hasError && <span className="badge badge-error">!</span>}
        {data.iteration !== undefined && <span className="badge badge-info">iteration {data.iteration + 1}</span>}
        {data.status && <span className={`status-dot ${statusClass(data.status)}`} title={data.status} />}
      </div>
      <div className="node-subtitle">{data.subtitle}</div>
      <div className="node-ports loop-ports">
        <div className="ports-in">
          {data.inputs.map((p) => (
            <PortRow key={p.id} port={p} side="in" />
          ))}
        </div>
        <div className="ports-out">
          {data.outputs.map((p) => (
            <PortRow key={p.id} port={p} side="out" />
          ))}
        </div>
      </div>
      <div className="loop-body-hint">body: nodes dropped inside run once per iteration</div>
    </div>
  );
}

export const nodeTypes = { orca: OrcaNode, loop: LoopNode };
