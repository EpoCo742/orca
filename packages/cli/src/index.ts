#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { execa } from 'execa';
import open from 'open';
import { copilotAuthStatus, copilotListModels, createEngine, stopCopilotClient } from '@orca/engine';
import { ORCA_VERSION } from '@orca/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(here, '..', '..', 'ui');
const require = createRequire(import.meta.url);

const program = new Command();
program.name('orca').description('Orca: visual orchestration for coding agents').version(ORCA_VERSION);

program
  .command('engine')
  .description('Run the engine API only (no UI)')
  .option('--port <port>', 'port', '4111')
  .option('--token <token>', 'bearer token (default: random)')
  .action(async (opts: { port: string; token?: string }) => {
    const token = opts.token ?? randomBytes(24).toString('hex');
    const engine = createEngine({ host: '127.0.0.1', port: Number(opts.port), authToken: token, workingDirectory: process.cwd() });
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
  .action(async (opts: { port: string; uiPort: string; open: boolean }) => {
    const token = randomBytes(24).toString('hex');
    const enginePort = Number(opts.port);
    const uiPort = Number(opts.uiPort);
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    const engine = createEngine({
      host: '127.0.0.1',
      port: enginePort,
      authToken: token,
      corsOrigins: [uiOrigin, `http://localhost:${uiPort}`],
      workingDirectory: process.cwd(),
    });
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
    const status = await copilotAuthStatus({ workingDirectory: process.cwd() });
    printStatus(status);
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
      const models = await copilotListModels({ workingDirectory: process.cwd() });
      for (const m of models) {
        const mult = m.multiplier !== undefined ? `x${m.multiplier}` : '';
        console.log(`${m.id.padEnd(40)} ${m.name.padEnd(36)} ${mult}`);
      }
    } catch (err) {
      console.error(`failed to list models: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      await stopCopilotClient();
    }
  });

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
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
