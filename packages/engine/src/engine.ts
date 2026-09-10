import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { openDatabase, type Database } from './db/database.js';
import { RunStore } from './run/store.js';
import { ApprovalBroker } from './approvals/broker.js';
import { WorktreeManager } from './run/worktrees.js';
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
import { FileSecretsProvider, MemorySecretsProvider, type SecretsProvider } from './secrets/provider.js';
import { Redactor } from './secrets/resolve.js';

export interface EngineConfig {
  host: string;
  port: number;
  authToken: string;
  corsOrigins?: string[];
  workingDirectory?: string;
  /** Where the SQLite database, secrets, and blobs live. Default: ~/.orca */
  dataDir?: string;
  /** Override database path (':memory:' for tests). */
  dbPath?: string;
  templatesDir?: string;
  logLevel?: string;
  /** Disable the Copilot adapter (tests, offline development). */
  disableCopilot?: boolean;
  maxConcurrentAgentsGlobal?: number;
  /** Use an in-memory secrets store (tests). */
  memorySecrets?: boolean;
  /** Worktree retention sweep on start (days). 0 disables. */
  worktreeRetentionDays?: number;
}

export interface Engine {
  app: Hono;
  config: EngineConfig;
  db: Database;
  services: EngineServices;
  workflows: WorkflowStore;
  runs: RunManager;
  secrets: SecretsProvider;
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
  const secrets: SecretsProvider = config.memorySecrets || dbPath === ':memory:' ? new MemorySecretsProvider() : new FileSecretsProvider(dataDir);
  const store = new RunStore(db);
  store.redactor = new Redactor(secrets);
  const approvals = new ApprovalBroker(store);
  const sandbox = new ExpressionSandbox();
  await sandbox.init();

  const adapters: Partial<Record<AdapterId, AgentAdapter>> = { fake: new FakeAdapter() };
  if (!config.disableCopilot) adapters.copilot = new CopilotAdapter(() => getCopilotClient({ workingDirectory: config.workingDirectory }), logger);

  const worktrees = new WorktreeManager(db, logger);
  const services: EngineServices = {
    store,
    sandbox,
    approvals,
    worktrees,
    secrets,
    adapters,
    logger,
    agentSlots: { max: config.maxConcurrentAgentsGlobal ?? 8, used: 0 },
  };
  const workflows = new WorkflowStore(db, config.templatesDir ?? defaultTemplatesDir());
  const runs = new RunManager(services, defaultExecutors(), workflows);
  services.runs = runs;
  services.workflows = workflows;

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  let server: ServerType | undefined;
  const engine: Engine = {
    app,
    config,
    db,
    services,
    workflows,
    runs,
    secrets,
    logger,
    async start() {
      await new Promise<void>((resolve) => {
        server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve());
      });
      injectWebSocket(server!);
      const resumed = await runs.resumeAll();
      if (resumed.length) logger.info({ resumed }, 'resumed in-flight runs');
      const days = config.worktreeRetentionDays ?? 7;
      if (days > 0) {
        const active = new Set(store.activeRunIds());
        worktrees
          .sweep(days, (id) => active.has(id))
          .then((n) => n && logger.info({ removed: n }, 'worktree sweep'))
          .catch((err) => logger.warn({ err: String(err) }, 'worktree sweep failed'));
      }
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
  registerRoutes(engine, Date.now());
  registerWebSocket(engine, upgradeWebSocket);
  return engine;
}
