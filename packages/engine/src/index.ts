import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { API_PREFIX, ORCA_VERSION, type HealthResponse, type ModelsResponse } from '@orca/shared';
import { copilotAuthStatus, copilotListModels, errorMessage, stopCopilotClient } from './adapters/copilot/client.js';

export interface EngineConfig {
  host: string;
  port: number;
  authToken: string;
  /** Origins allowed to call the API from a browser (the Vite dev server in development). */
  corsOrigins?: string[];
  workingDirectory?: string;
}

export interface Engine {
  app: Hono;
  start(): Promise<{ url: string }>;
  stop(): Promise<void>;
}

export function createEngine(config: EngineConfig): Engine {
  const startedAt = Date.now();
  const app = new Hono();

  if (config.corsOrigins?.length) {
    app.use('*', cors({ origin: config.corsOrigins, allowHeaders: ['Authorization', 'Content-Type'] }));
  }

  // Bearer-token auth on every API route, even on localhost.
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : c.req.query('token');
    if (token !== config.authToken) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.get(`${API_PREFIX}/health`, (c) => {
    const body: HealthResponse = { ok: true, version: ORCA_VERSION, uptimeMs: Date.now() - startedAt };
    return c.json(body);
  });

  app.get(`${API_PREFIX}/system/auth-status`, async (c) => {
    const status = await copilotAuthStatus({ workingDirectory: config.workingDirectory });
    return c.json(status);
  });

  app.get(`${API_PREFIX}/system/models`, async (c) => {
    try {
      const models = await copilotListModels({ workingDirectory: config.workingDirectory });
      const body: ModelsResponse = { models };
      return c.json(body);
    } catch (err) {
      const body: ModelsResponse = { models: [], error: errorMessage(err) };
      return c.json(body, 502);
    }
  });

  let server: ServerType | undefined;

  return {
    app,
    async start() {
      await new Promise<void>((resolve) => {
        server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve());
      });
      return { url: `http://${config.host}:${config.port}` };
    },
    async stop() {
      await stopCopilotClient().catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export { copilotAuthStatus, copilotListModels, getCopilotClient, stopCopilotClient } from './adapters/copilot/client.js';
