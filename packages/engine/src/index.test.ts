import { describe, expect, it } from 'vitest';
import { createEngine } from './index.js';

describe('engine api', () => {
  const engine = createEngine({ host: '127.0.0.1', port: 0, authToken: 'secret' });

  it('rejects requests without the bearer token', async () => {
    const res = await engine.app.request('/api/v1/health');
    expect(res.status).toBe(401);
  });

  it('serves health with the bearer token', async () => {
    const res = await engine.app.request('/api/v1/health', { headers: { authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
  });

  it('accepts the token as a query parameter (for WebSocket and browser bootstrapping)', async () => {
    const res = await engine.app.request('/api/v1/health?token=secret');
    expect(res.status).toBe(200);
  });
});
