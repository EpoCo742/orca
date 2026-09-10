import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { openDatabase, type Database } from './db/database.js';
import { RunStore } from './run/store.js';
import { ApprovalBroker } from './approvals/broker.js';
import { ExpressionSandbox } from './expr/sandbox.js';
import { WorkflowStore } from './workflows/store.js';
import { RunManager } from './run/manager.js';
import { defaultExecutors } from './run/executors/index.js';
import { FakeAdapter } from './adapters/fake.js';
import { CopilotAdapter } from './adapters/copilot/adapter.js';
import { getCopilotClient, stopCopilotClient } from './adapters/copilot/client.js';
import { createLogger, type Logger } from './logger.js';
import type { EngineServices } from './run/context.js';
import { registerRoutes } from './api/routes.js';
import { registerWebSocket } from './api/ws.js';
import type { AgentAdapter, AdapterId } from './adapters/types.js';

export interface EngineConfig {
  host: string;
  port: number;
  authToken: string;
  corsOrigins?: string[];
  workingDirectory?: string;
  /** Where the SQLite database and blobs live. Default: ~/.orca */
  dataDir?: string;
  /** Override database path (':memory:' for tests). */
  dbPath?: string;
  templatesDir?: string;
  logLevel?: string;
  /** Disable the Copilot adapter (tests, offline development). */
  disableCopilot?: boolean;
  maxConcurrentAgentsGlobal?: number;
}

export interface Engine {
  app: Hono;
  config: EngineConfig;
  db: Database;
  services: EngineServices;
  workflows: WorkflowStore;
  runs: RunManager;
  logger: Logger;
  start(): Promise<{ url: string }>;
  stop(): Promise<void>;
}

export function defaultDataDir(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'orca');
  return path.join(os.homedir(), '.orca');
}

export function defaultTemplatesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates');
}

export async function createEngine(config: EngineConfig): Promise<Engine> {
  const logger = createLogger(config.logLevel);
  const dataDir = config.dataDir ?? defaultDataDir();
  const dbPath = config.dbPath ?? path.join(dataDir, 'orca.db');
  const db = openDatabase(dbPath);
  const store = new RunStore(db);
  const approvals = new ApprovalBroker(store);
  const sandbox = new ExpressionSandbox();
  await sandbox.init();

  const adapters: Partial<Record<AdapterId, AgentAdapter>> = { fake: new FakeAdapter() };
  if (!config.disableCopilot) adapters.copilot = new CopilotAdapter(() => getCopilotClient({ workingDirectory: config.workingDirectory }), logger);

  const services: EngineServices = {
    store,
    sandbox,
    approvals,
    adapters,
    logger,
    agentSlots: { max: config.maxConcurrentAgentsGlobal ?? 8, used: 0 },
  };
  const workflows = new WorkflowStore(db, config.templatesDir ?? defaultTemplatesDir());
  const runs = new RunManager(services, defaultExecutors(), workflows);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const engine: Engine = {
    app,
    config,
    db,
    services,
    workflows,
    runs,
    logger,
    async start() {
      await new Promise<void>((resolve) => {
        server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve());
      });
      injectWebSocket(server!);
      const resumed = await runs.resumeAll();
      if (resumed.length) logger.info({ resumed }, 'resumed in-flight runs');
      return { url: `http://${config.host}:${config.port}` };
    },
    async stop() {
      await stopCopilotClient().catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        server.close((err) => (err ? reject(err) : resolve()));
      });
      db.close();
    },
  };
  let server: ServerType | undefined;
  registerRoutes(engine, Date.now());
  registerWebSocket(engine, upgradeWebSocket);
  return engine;
}
