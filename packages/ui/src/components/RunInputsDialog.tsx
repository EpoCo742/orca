import { useState } from 'react';
import type { WorkflowInput } from '@orca/shared';

export function RunInputsDialog({ inputs, onSubmit, onCancel }: { inputs: WorkflowInput[]; onSubmit(values: Record<string, unknown>): void; onCancel(): void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(inputs.map((i) => [i.name, i.default !== undefined ? (typeof i.default === 'string' ? i.default : JSON.stringify(i.default)) : ''])));
  const submit = () => {
    const out: Record<string, unknown> = {};
    for (const inp of inputs) {
      const v = values[inp.name] ?? '';
      if (inp.type === 'number') out[inp.name] = Number(v);
      else if (inp.type === 'boolean') out[inp.name] = v === 'true';
      else if (inp.type === 'json') {
        try {
          out[inp.name] = JSON.parse(v);
        } catch {
          out[inp.name] = v;
        }
      } else out[inp.name] = v;
    }
    onSubmit(out);
  };
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">Run inputs</div>
        {inputs.map((inp) => (
          <label key={inp.name} className="field">
            <span className="field-label">
              {inp.name} <span className="note">({inp.type}{inp.required ? ', required' : ''})</span>
            </span>
            {inp.description && <span className="note">{inp.description}</span>}
            {inp.type === 'boolean' ? (
              <select value={values[inp.name]} onChange={(e) => setValues({ ...values, [inp.name]: e.target.value })}>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <textarea rows={inp.type === 'string' ? 4 : 2} value={values[inp.name]} onChange={(e) => setValues({ ...values, [inp.name]: e.target.value })} />
            )}
          </label>
        ))}
        <div className="approval-actions">
          <button className="btn btn-primary" onClick={submit}>
            Run
          </button>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
