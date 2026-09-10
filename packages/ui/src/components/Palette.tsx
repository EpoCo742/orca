import { NODE_TYPES } from '@orca/shared';
import { useEditor } from '../store/editor.js';

const ORDER: Array<{ category: string; label: string }> = [
  { category: 'trigger', label: 'Triggers' },
  { category: 'agent', label: 'Agents' },
  { category: 'action', label: 'Actions' },
  { category: 'control', label: 'Control' },
  { category: 'data', label: 'Data' },
];

export function Palette({ disabled }: { disabled: boolean }) {
  const addNode = useEditor((s) => s.addNode);
  const selected = useEditor((s) => s.selectedNodeId);
  const doc = useEditor((s) => s.document);
  const defs = Object.values(NODE_TYPES);
  const selectedIsLoop = selected && doc?.nodes.find((n) => n.id === selected)?.type === 'control.loop';

  return (
    <div className="palette">
      <div className="panel-title">Nodes</div>
      {ORDER.map(({ category, label }) => (
        <div key={category} className="palette-group">
          <div className="palette-group-title">{label}</div>
          {defs
            .filter((d) => d.category === category)
            .map((d) => (
              <div
                key={d.type}
                className={`palette-item cat-${d.category}`}
                draggable={!disabled}
                title={d.description + (selectedIsLoop ? ' (click to add inside the selected loop)' : ' (drag onto the canvas, or click to add)')}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/orca-node-type', d.type);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => {
                  if (disabled) return;
                  const parent = selectedIsLoop ? selected : undefined;
                  const base = parent ? { x: 40, y: 80 } : { x: 120 + Math.random() * 200, y: 120 + Math.random() * 120 };
                  addNode(d.type, base, parent);
                }}
              >
                <span className="palette-item-label">{d.label}</span>
                <span className="palette-item-desc">{d.description}</span>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
