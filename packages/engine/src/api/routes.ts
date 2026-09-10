import { cors } from 'hono/cors';
import { z } from 'zod';
import {
  API_PREFIX,
  CreateWorkflowRequest,
  DecideApprovalRequest,
  ImportWorkflowRequest,
  ORCA_VERSION,
  SaveWorkflowRequest,
  StartRunRequest,
  WorkflowDocument,
  type HealthResponse,
  type ModelsResponse,
} from '@orca/shared';
import type { Engine } from '../engine.js';
import { copilotAuthStatus, copilotListModels, errorMessage } from '../adapters/copilot/client.js';

export function registerRoutes(engine: Engine, startedAt: number): void {
  const { app, config, workflows, runs, services } = engine;

  if (config.corsOrigins?.length) {
    app.use('*', cors({ origin: config.corsOrigins, allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
  }

  app.use(`${API_PREFIX}/*`, async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : c.req.query('token');
    if (token !== config.authToken) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.onError((err, c) => {
    engine.logger.error({ err: err.message, path: c.req.path }, 'request failed');
    if (err instanceof z.ZodError) return c.json({ error: 'validation', issues: err.issues }, 400);
    return c.json({ error: err.message }, 500);
  });

  // ---------------------------------------------------------------- system
  app.get(`${API_PREFIX}/health`, (c) => {
    const body: HealthResponse = { ok: true, version: ORCA_VERSION, uptimeMs: Date.now() - startedAt };
    return c.json(body);
  });

  app.get(`${API_PREFIX}/system/auth-status`, async (c) => {
    if (config.disableCopilot) return c.json({ provider: 'copilot', isAuthenticated: false, error: 'copilot disabled' });
    return c.json(await copilotAuthStatus({ workingDirectory: config.workingDirectory }));
  });

  app.get(`${API_PREFIX}/system/models`, async (c) => {
    if (config.disableCopilot) return c.json({ models: [], error: 'copilot disabled' } satisfies ModelsResponse);
    try {
      return c.json({ models: await copilotListModels({ workingDirectory: config.workingDirectory }) } satisfies ModelsResponse);
    } catch (err) {
      return c.json({ models: [], error: errorMessage(err) } satisfies ModelsResponse, 502);
    }
  });

  app.get(`${API_PREFIX}/system/info`, (c) => c.json({ version: ORCA_VERSION, cwd: config.workingDirectory ?? process.cwd(), platform: process.platform, activeRuns: runs.activeCount(), pendingApprovals: services.approvals.pendingCount() }));

  // ---------------------------------------------------------------- workflows
  app.get(`${API_PREFIX}/workflows`, (c) => c.json({ workflows: workflows.list() }));

  app.post(`${API_PREFIX}/workflows`, async (c) => {
    const body = CreateWorkflowRequest.parse(await c.req.json());
    return c.json(workflows.create(body.repoPath, body.document), 201);
  });

  app.post(`${API_PREFIX}/workflows/import`, async (c) => {
    const body = ImportWorkflowRequest.parse(await c.req.json());
    return c.json(workflows.importFile(body.path), 201);
  });

  app.post(`${API_PREFIX}/workflows/validate`, async (c) => {
    const body = SaveWorkflowRequest.parse(await c.req.json());
    return c.json({ diagnostics: workflows.validate(body.document) });
  });

  app.get(`${API_PREFIX}/workflows/:id`, (c) => {
    const d = workflows.get(c.req.param('id'));
    return d ? c.json(d) : c.json({ error: 'not found' }, 404);
  });

  app.put(`${API_PREFIX}/workflows/:id`, async (c) => {
    const body = SaveWorkflowRequest.parse(await c.req.json());
    const d = workflows.save(c.req.param('id'), body.document);
    return d ? c.json(d) : c.json({ error: 'not found' }, 404);
  });

  app.delete(`${API_PREFIX}/workflows/:id`, async (c) => {
    const deleteFile = c.req.query('deleteFile') === 'true';
    return c.json({ deleted: workflows.delete(c.req.param('id'), deleteFile) });
  });

  app.get(`${API_PREFIX}/templates`, (c) => c.json({ templates: workflows.templates().map((t) => ({ id: t.id, name: t.name, description: t.description })) }));

  app.post(`${API_PREFIX}/workflows/from-template`, async (c) => {
    const body = z.object({ templateId: z.string(), repoPath: z.string().optional(), name: z.string().optional(), inPlace: z.boolean().default(false) }).parse(await c.req.json());
    if (body.inPlace || !body.repoPath) return c.json(workflows.importTemplate(body.templateId), 201);
    return c.json(workflows.fromTemplate(body.templateId, body.repoPath, body.name), 201);
  });

  // ---------------------------------------------------------------- runs
  app.post(`${API_PREFIX}/runs`, async (c) => {
    const body = StartRunRequest.parse(await c.req.json());
    const { runId } = await runs.startRun({ workflowId: body.workflowId, inputs: body.inputs });
    return c.json({ runId }, 201);
  });

  app.post(`${API_PREFIX}/runs/adhoc`, async (c) => {
    const body = z.object({ document: WorkflowDocument, workflowPath: z.string(), inputs: z.record(z.string(), z.unknown()).default({}) }).parse(await c.req.json());
    const { runId } = await runs.startFromDocument(body.document, body.workflowPath, body.inputs, { type: 'adhoc' });
    return c.json({ runId }, 201);
  });

  app.get(`${API_PREFIX}/runs`, (c) => {
    const status = c.req.query('status') as never;
    return c.json({ runs: runs.list({ workflowId: c.req.query('workflowId'), status, limit: Number(c.req.query('limit') ?? 50) }) });
  });

  app.get(`${API_PREFIX}/runs/:id`, (c) => {
    const d = runs.detail(c.req.param('id'));
    return d ? c.json(d) : c.json({ error: 'not found' }, 404);
  });

  app.get(`${API_PREFIX}/runs/:id/events`, (c) => {
    const after = Number(c.req.query('after') ?? 0);
    return c.json({ events: services.store.events(c.req.param('id'), after) });
  });

  app.get(`${API_PREFIX}/runs/:id/nodes/:nodeId/transcript`, (c) => {
    const scope = c.req.query('scope') ?? '';
    const after = Number(c.req.query('after') ?? 0);
    return c.json({ rows: services.store.transcripts(c.req.param('id'), c.req.param('nodeId'), scope, after) });
  });

  app.post(`${API_PREFIX}/runs/:id/cancel`, (c) => c.json({ cancelled: runs.cancel(c.req.param('id')) }));

  // ---------------------------------------------------------------- worktrees
  app.get(`${API_PREFIX}/runs/:id/worktrees`, (c) => c.json({ worktrees: services.worktrees.list(c.req.param('id')) }));

  app.get(`${API_PREFIX}/runs/:id/worktrees/:owner/diff`, async (c) => {
    const rec = services.worktrees.get(c.req.param('id'), c.req.param('owner'));
    if (!rec) return c.json({ error: 'no active worktree' }, 404);
    const base = c.req.query('base') ?? rec.baseRef;
    return c.json({ worktree: rec, ...(await services.worktrees.diff(rec, base)) });
  });

  app.post(`${API_PREFIX}/runs/:id/worktrees/:owner/remove`, async (c) => {
    const rec = services.worktrees.get(c.req.param('id'), c.req.param('owner'));
    if (!rec) return c.json({ error: 'no active worktree' }, 404);
    await services.worktrees.remove(rec, { force: true, deleteBranch: true, reason: 'discarded from UI', emit: (e) => services.store.append(rec.runId, e) });
    return c.json({ removed: true });
  });

  app.post(`${API_PREFIX}/runs/:id/worktrees/:owner/keep`, (c) => {
    const rec = services.worktrees.get(c.req.param('id'), c.req.param('owner'));
    if (!rec) return c.json({ error: 'no active worktree' }, 404);
    services.worktrees.keep(rec);
    return c.json({ kept: true });
  });

  // ---------------------------------------------------------------- approvals
  app.get(`${API_PREFIX}/approvals`, (c) => {
    const status = (c.req.query('status') ?? 'pending') as never;
    return c.json({ approvals: services.store.listApprovals({ status: status === 'all' ? undefined : status, runId: c.req.query('runId') }) });
  });

  app.post(`${API_PREFIX}/approvals/:id/decide`, async (c) => {
    const body = DecideApprovalRequest.parse(await c.req.json());
    const rec = services.approvals.decide(c.req.param('id'), body);
    return rec ? c.json(rec) : c.json({ error: 'approval not pending' }, 409);
  });
}
