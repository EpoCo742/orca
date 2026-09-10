import { useEffect, useState } from 'react';
import type { AuthStatusResponse, HealthResponse, ModelsResponse } from '@orca/shared';
import { apiGet, readConnection, type EngineConnection } from './api.js';

type Loadable<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'error'; error: string };

function useLoad<T>(conn: EngineConnection | undefined, path: string): Loadable<T> {
  const [v, setV] = useState<Loadable<T>>({ state: 'loading' });
  useEffect(() => {
    if (!conn) return;
    let cancelled = false;
    apiGet<T>(conn, path)
      .then((value) => !cancelled && setV({ state: 'ok', value }))
      .catch((e: Error) => !cancelled && setV({ state: 'error', error: e.message }));
    return () => {
      cancelled = true;
    };
  }, [conn, path]);
  return v;
}

export function App() {
  const [conn] = useState(() => readConnection());
  const health = useLoad<HealthResponse>(conn, '/health');
  const auth = useLoad<AuthStatusResponse>(conn, '/system/auth-status');
  const models = useLoad<ModelsResponse>(conn, '/system/models');

  if (!conn) {
    return (
      <main style={{ padding: 24 }}>
        <h1>Orca</h1>
        <p>No engine connection. Start the app with <code>pnpm dev</code>, which opens this page with the engine URL and token.</p>
      </main>
    );
  }

  return (
    <main style={{ padding: 24, maxWidth: 800 }}>
      <h1>Orca</h1>
      <p style={{ opacity: 0.7 }}>M0 scaffold. The canvas arrives in M1.</p>
      <Section title="Engine">
        {health.state === 'ok' ? `connected to ${conn.baseUrl}, version ${health.value.version}` : describe(health)}
      </Section>
      <Section title="Copilot authentication">
        {auth.state === 'ok'
          ? auth.value.isAuthenticated
            ? `signed in as ${auth.value.login ?? 'unknown'} via ${auth.value.authType ?? '?'}`
            : `not signed in${auth.value.error ? `: ${auth.value.error}` : ''}. Run: pnpm orca auth login`
          : describe(auth)}
      </Section>
      <Section title="Models available to this account">
        {models.state === 'ok' ? (
          models.value.models.length ? (
            <ul>
              {models.value.models.map((m) => (
                <li key={m.id}>
                  <code>{m.id}</code> {m.name} {m.multiplier !== undefined ? `(x${m.multiplier})` : ''}
                </li>
              ))}
            </ul>
          ) : (
            `none${models.value.error ? `: ${models.value.error}` : ''}`
          )
        ) : (
          describe(models)
        )}
      </Section>
    </main>
  );
}

function describe(l: Loadable<unknown>): string {
  return l.state === 'loading' ? 'loading...' : l.state === 'error' ? `error: ${l.error}` : '';
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 16, padding: 12, border: '1px solid #8884', borderRadius: 8 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>{title}</h2>
      <div>{children}</div>
    </section>
  );
}
