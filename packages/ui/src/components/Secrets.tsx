import { useState } from 'react';
import type { Api } from '../api.js';

/** Secret names only; values go straight to the engine and are never shown again. */
export function SecretsPanel({ api, names, onChange }: { api: Api; names: string[]; onChange(names: string[]): void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const add = async () => {
    try {
      onChange(await api.setSecret(name.trim().toUpperCase(), value));
      setName('');
      setValue('');
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div>
      <div className="panel-title">Secrets</div>
      <ul className="list">
        {names.map((n) => (
          <li key={n}>
            <code>{n}</code>
            <button className="link" style={{ marginLeft: 'auto' }} title="delete" onClick={() => api.deleteSecret(n).then(onChange)}>
              ✕
            </button>
          </li>
        ))}
        {names.length === 0 && <li className="note">None. Reference secrets as {'${SECRET:NAME}'} in MCP server configs.</li>}
      </ul>
      <div className="field">
        <input placeholder="NAME (e.g. GITHUB_TOKEN)" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="value" type="password" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn" disabled={!name.trim() || !value} onClick={add}>
          Save secret
        </button>
        {error && <div className="diag diag-error">{error}</div>}
      </div>
    </div>
  );
}
