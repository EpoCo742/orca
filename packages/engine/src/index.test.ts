import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from './engine.js';

const templatesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates');

describe('engine api', () => {
  let engine: Engine;
  const headers = { authorization: 'Bearer secret' };

  beforeAll(async () => {
    engine = await createEngine({ host: '127.0.0.1', port: 0, authToken: 'secret', dbPath: ':memory:', disableCopilot: true, templatesDir, logLevel: 'silent' });
  });
  afterAll(async () => {
    engine.db.close();
  });

  it('rejects requests without the bearer token', async () => {
    const res = await engine.app.request('/api/v1/health');
    expect(res.status).toBe(401);
  });

  it('serves health with the bearer token', async () => {
    const res = await engine.app.request('/api/v1/health', { headers });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('lists templates and validates documents', async () => {
    const res = await engine.app.request('/api/v1/templates', { headers });
    const body = (await res.json()) as { templates: Array<{ id: string }> };
    expect(body.templates.map((t) => t.id)).toContain('fix-until-green-fake');

    const tpl = engine.workflows.templates().find((t) => t.id === 'fix-until-green-fake')!;
    const v = await engine.app.request('/api/v1/workflows/validate', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ document: tpl.document }) });
    const diag = (await v.json()) as { diagnostics: Array<{ severity: string }> };
    expect(diag.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('runs the fake fix-until-green template end to end against examples/sample-target', async () => {
    const detail = engine.workflows.importTemplate('fix-until-green-fake');
    const res = await engine.app.request('/api/v1/runs', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: detail.id }) });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    const p = await engine.runs.wait(runId, 120_000);
    expect(p.status).toBe('completed');
    expect(p.nodes['loop@']?.outputs?.exited_by).toBe('until');
    expect(p.nodes['loop@']?.outputs?.iterations).toBe(2);
    expect(p.nodes['summary@']?.outputs?.value).toMatchObject({ green: true, iterations: 2 });
    const events = await engine.app.request(`/api/v1/runs/${runId}/events`, { headers });
    const { events: list } = (await events.json()) as { events: Array<{ event: { type: string } }> };
    expect(list.some((e) => e.event.type === 'loop.iteration')).toBe(true);
  }, 150_000);
});
