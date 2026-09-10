#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { execa } from 'execa';
import open from 'open';
import { copilotAuthStatus, copilotListModels, createEngine, stopCopilotClient, type Engine } from '@orca/engine';
import { ORCA_VERSION, type StoredRunEvent } from '@orca/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const uiDir = path.resolve(repoRoot, 'packages', 'ui');
const templatesDir = path.resolve(repoRoot, 'templates');
const require = createRequire(import.meta.url);

const program = new Command();
program.name('orca').description('Orca: visual orchestration for coding agents').version(ORCA_VERSION);

async function makeEngine(opts: { port: number; token: string; corsOrigins?: string[]; disableCopilot?: boolean }): Promise<Engine> {
  return createEngine({
    host: '127.0.0.1',
    port: opts.port,
    authToken: opts.token,
    corsOrigins: opts.corsOrigins,
    workingDirectory: process.cwd(),
    templatesDir,
    disableCopilot: opts.disableCopilot,
  });
}

program
  .command('engine')
  .description('Run the engine API only (no UI)')
  .option('--port <port>', 'port', '4111')
  .option('--token <token>', 'bearer token (default: random)')
  .action(async (opts: { port: string; token?: string }) => {
    const token = opts.token ?? randomBytes(24).toString('hex');
    const engine = await makeEngine({ port: Number(opts.port), token });
    const { url } = await engine.start();
    console.log(`engine listening at ${url}  token=${token}`);
    onShutdown(() => engine.stop());
  });

program
  .command('dev')
  .description('Run the engine and the UI dev server, then open the browser')
  .option('--port <port>', 'engine port', '4111')
  .option('--ui-port <port>', 'UI port', '5173')
  .option('--no-open', 'do not open the browser')
  .option('--no-copilot', 'disable the Copilot adapter (fake agents only)')
  .action(async (opts: { port: string; uiPort: string; open: boolean; copilot: boolean }) => {
    const token = randomBytes(24).toString('hex');
    const enginePort = Number(opts.port);
    const uiPort = Number(opts.uiPort);
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    const engine = await makeEngine({ port: enginePort, token, corsOrigins: [uiOrigin, `http://localhost:${uiPort}`], disableCopilot: !opts.copilot });
    const { url } = await engine.start();
    console.log(`[orca] engine ${url}`);

    const vite = execa('pnpm', ['exec', 'vite', '--port', String(uiPort), '--strictPort', '--host', '127.0.0.1'], {
      cwd: uiDir,
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    let opened = false;
    vite.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text.replace(/^/gm, '[ui] '));
      if (!opened && /ready in|Local:/i.test(text)) {
        opened = true;
        const target = `${uiOrigin}/#engine=${encodeURIComponent(url)}&token=${token}`;
        console.log(`[orca] UI ${target}`);
        if (opts.open) void open(target);
      }
    });
    vite.catch(() => undefined);

    onShutdown(async () => {
      vite.kill();
      await engine.stop();
    });
  });

program
  .command('run')
  .description('Run a workflow file (or a bundled template id) headlessly and stream events')
  .argument('<workflow>', 'path to a .workflow.json file, or a template id such as fix-until-green')
  .option('--input <kv...>', 'workflow inputs as key=value')
  .option('--approve-all', 'approve every tool permission request (default: deny)')
  .option('--no-copilot', 'disable the Copilot adapter')
  .option('--timeout <sec>', 'give up after N seconds', '1800')
  .action(async (workflow: string, opts: { input?: string[]; approveAll?: boolean; copilot: boolean; timeout: string }) => {
    const engine = await makeEngine({ port: 0, token: randomBytes(8).toString('hex'), disableCopilot: !opts.copilot });
    const inputs: Record<string, unknown> = {};
    for (const kv of opts.input ?? []) {
      const i = kv.indexOf('=');
      if (i > 0) inputs[kv.slice(0, i)] = parseValue(kv.slice(i + 1));
    }
    const detail = workflow.endsWith('.json') ? engine.workflows.importFile(workflow) : engine.workflows.importTemplate(workflow);
    const errors = detail.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length) {
      for (const e of errors) console.error(`error: ${e.message}`);
      process.exit(2);
    }
    for (const w of detail.diagnostics) console.warn(`warning: ${w.message}`);

    engine.services.store.on('event', (ev: StoredRunEvent) => printEvent(ev));
    engine.services.store.on('transcript', (row) => {
      if (row.summary) console.log(`      [${row.nodeId}] ${row.kind}: ${row.summary}`);
    });
    engine.services.store.on('approval', (a) => {
      if (a.status !== 'pending') return;
      const req = a.request as { summary?: string };
      console.log(`  ?? approval ${a.id} for ${a.nodeId}: ${req.summary ?? a.kind} -> ${opts.approveAll ? 'approve' : 'deny'}`);
      setTimeout(() => engine.services.approvals.decide(a.id, { status: opts.approveAll ? 'approved' : 'rejected', comment: 'orca run --approve-all', remember: 'none', decidedBy: 'cli' }), 10);
    });

    const { runId } = await engine.runs.startRun({ workflowId: detail.id, inputs, trigger: { type: 'cli' } });
    console.log(`run ${runId} started (${detail.name})`);
    const p = await engine.runs.wait(runId, Number(opts.timeout) * 1000);
    console.log(`run ${p.status}${p.error ? `: ${p.error}` : ''}  premium requests: ${p.cost.premiumRequests}`);
    for (const [key, st] of Object.entries(p.nodes)) {
      if (st.status === 'completed' && st.outputs && key.endsWith('@')) console.log(`  ${key.slice(0, -1)}: ${JSON.stringify(st.outputs).slice(0, 300)}`);
    }
    await engine.stop();
    process.exit(p.status === 'completed' ? 0 : 1);
  });

const auth = program.command('auth').description('GitHub Copilot authentication');

auth
  .command('login')
  .description('Sign in to GitHub Copilot (runs the official Copilot CLI login flow)')
  .option('--device-code', 'force the OAuth device-code flow instead of the browser flow')
  .action(async (opts: { deviceCode?: boolean }) => {
    const cliPkg = require.resolve('@github/copilot/package.json');
    const loader = path.join(path.dirname(cliPkg), 'npm-loader.js');
    const args = [loader, 'login', ...(opts.deviceCode ? ['--device-code'] : [])];
    const result = await execa(process.execPath, args, { stdio: 'inherit', reject: false, windowsHide: false });
    if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
    printStatus(await copilotAuthStatus({ workingDirectory: process.cwd() }));
    await stopCopilotClient();
  });

auth
  .command('status')
  .description('Show Copilot authentication status as seen by the SDK')
  .action(async () => {
    const status = await copilotAuthStatus({ workingDirectory: process.cwd() });
    printStatus(status);
    await stopCopilotClient();
    process.exit(status.isAuthenticated ? 0 : 1);
  });

program
  .command('models')
  .description('List models available to the signed-in Copilot account')
  .action(async () => {
    try {
      for (const m of await copilotListModels({ workingDirectory: process.cwd() })) {
        console.log(`${m.id.padEnd(40)} ${m.name.padEnd(36)} ${m.multiplier !== undefined ? `x${m.multiplier}` : ''}`);
      }
    } catch (err) {
      console.error(`failed to list models: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      await stopCopilotClient();
    }
  });

function printEvent(ev: StoredRunEvent): void {
  const e = ev.event;
  const t = ev.ts.slice(11, 19);
  switch (e.type) {
    case 'node.started':
      console.log(`${t}  > ${e.nodeId}${e.scope ? ` [${e.scope}]` : ''} started (attempt ${e.attempt})`);
      break;
    case 'node.completed':
      console.log(`${t}  + ${e.nodeId}${e.scope ? ` [${e.scope}]` : ''} completed ${summarizeOutputs(e.outputs)}`);
      break;
    case 'node.failed':
      console.log(`${t}  x ${e.nodeId}${e.scope ? ` [${e.scope}]` : ''} failed: ${e.error}${e.retryable ? ' (will retry)' : ''}`);
      break;
    case 'node.skipped':
      console.log(`${t}  - ${e.nodeId}${e.scope ? ` [${e.scope}]` : ''} skipped`);
      break;
    case 'node.progress':
      if (e.kind === 'summary' || e.kind === 'warning') console.log(`${t}    ${e.nodeId}: ${e.text.trim()}`);
      break;
    case 'loop.iteration':
      console.log(`${t}  @ ${e.nodeId} iteration ${e.index}`);
      break;
    case 'loop.exit':
      console.log(`${t}  @ ${e.nodeId} exit (${e.exitedBy}) after ${e.iterations}`);
      break;
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
      console.log(`${t}  ${e.type}${'error' in e ? `: ${e.error}` : ''}`);
      break;
    default:
      break;
  }
}

function summarizeOutputs(outputs: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(outputs)) {
    if (k === 'stdout' || k === 'stderr') continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s !== undefined) parts.push(`${k}=${s.length > 60 ? s.slice(0, 60) + '...' : s}`);
  }
  return parts.join(' ');
}

function parseValue(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
    try {
      return JSON.parse(v);
    } catch {
      /* fall through */
    }
  }
  return v;
}

function printStatus(s: Awaited<ReturnType<typeof copilotAuthStatus>>) {
  if (s.isAuthenticated) console.log(`signed in as ${s.login ?? 'unknown'} (${s.authType ?? '?'}, ${s.host ?? 'github.com'})`);
  else console.log(`not signed in${s.statusMessage ? `: ${s.statusMessage}` : ''}${s.error ? `: ${s.error}` : ''}`);
}

function onShutdown(fn: () => Promise<void> | void) {
  let done = false;
  const handler = async () => {
    if (done) return;
    done = true;
    try {
      await fn();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
