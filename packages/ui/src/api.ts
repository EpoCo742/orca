/**
 * Engine connection. The CLI opens the browser at `/#engine=<url>&token=<token>`; we persist both in
 * sessionStorage so reloads keep working without re-reading the hash.
 */
export interface EngineConnection {
  baseUrl: string;
  token: string;
}

export function readConnection(): EngineConnection | undefined {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const fromHash = hash.get('engine') && hash.get('token') ? { baseUrl: hash.get('engine')!, token: hash.get('token')! } : undefined;
  if (fromHash) {
    try {
      sessionStorage.setItem('orca.connection', JSON.stringify(fromHash));
    } catch {
      /* ignore */
    }
    history.replaceState(null, '', window.location.pathname);
    return fromHash;
  }
  try {
    const raw = sessionStorage.getItem('orca.connection');
    return raw ? (JSON.parse(raw) as EngineConnection) : undefined;
  } catch {
    return undefined;
  }
}

export async function apiGet<T>(conn: EngineConnection, path: string): Promise<T> {
  const res = await fetch(`${conn.baseUrl}/api/v1${path}`, { headers: { Authorization: `Bearer ${conn.token}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}
