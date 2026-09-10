import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';
import { WorkflowDocument, type WorkflowDocumentInput } from '@orca/shared';
import { openDatabase } from '../db/database.js';
import { RunStore } from './store.js';
import { ApprovalBroker } from '../approvals/broker.js';
import { ExpressionSandbox } from '../expr/sandbox.js';
import { FakeAdapter } from '../adapters/fake.js';
import { createLogger } from '../logger.js';
import { WorkflowStore } from '../workflows/store.js';
import { RunManager } from './manager.js';
import { WorktreeManager } from './worktrees.js';
import { MemorySecretsProvider } from '../secrets/provider.js';
import { defaultExecutors } from './executors/index.js';
import type { EngineServices } from './context.js';

const sandbox = new ExpressionSandbox();
let repo: string;

async function git(args: string[], cwd = repo) {
  return execa('git', args, { cwd, windowsHide: true });
}

function harness() {
  const db = openDatabase(':memory:');
  const store = new RunStore(db);
  const logger = createLogger('silent');
  const worktrees = new WorktreeManager(db, logger);
  const services: EngineServices = { store, sandbox, approvals: new ApprovalBroker(store), worktrees, secrets: new MemorySecretsProvider(), adapters: { fake: new FakeAdapter() }, logger, agentSlots: { max: 8, used: 0 } };
  const runs = new RunManager(services, defaultExecutors(), new WorkflowStore(db));
  return { store, services, runs, worktrees, approvals: services.approvals };
}

const pos = { x: 0, y: 0 };
const edge = (from: string, to: string, fromPort = 'done') => ({ id: `${from}-${fromPort}-${to}`, from: { node: from, port: fromPort }, to: { node: to, port: 'trigger' } });
const doc = (input: Omit<WorkflowDocumentInput, 'schemaVersion' | 'id' | 'name'>): WorkflowDocument => WorkflowDocument.parse({ schemaVersion: 1, id: crypto.randomUUID(), name: 'wt test', ...input });

beforeAll(async () => {
  await sandbox.init();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-repo-'));
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'orca@example.com']);
  await git(['config', 'user.name', 'Orca Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'init']);
});

describe('worktree isolation', () => {
  it('runs an isolated agent in a worktree, diffs, commits, and leaves the main checkout untouched', async () => {
    const h = harness();
    const wfPath = path.join(repo, '.orca', 'workflows', 'x.workflow.json');
    const d = doc({
      settings: { worktree: { linkDirs: ['node_modules'] } }, // repoPath derived from <repo>/.orca/workflows/x.workflow.json
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'implement', type: 'agent.copilot', position: pos, config: { adapter: 'fake', prompt: '@fake:write feature.txt new feature\n@fake:say wrote it', isolation: 'worktree' } },
        { id: 'test', type: 'action.shell', position: pos, config: { command: process.platform === 'win32' ? 'Get-Content feature.txt' : 'cat feature.txt', worktreeOf: 'implement' } },
        { id: 'changes', type: 'action.git', position: pos, config: { op: 'diff', target: 'implement' } },
        { id: 'commit', type: 'action.git', position: pos, config: { op: 'commit', target: 'implement', message: 'add feature' } },
        { id: 'gate', type: 'control.gate', position: pos, config: { title: 'ok?', show: [{ label: 'Diff', expression: 'nodes.changes.diff', render: 'diff' }] } },
        { id: 'discard', type: 'action.git', position: pos, config: { op: 'worktree.remove', target: 'implement' } },
      ],
      edges: [edge('start', 'implement'), edge('implement', 'test'), edge('test', 'changes'), edge('changes', 'commit'), edge('commit', 'gate'), edge('gate', 'discard', 'rejected')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath, {}, { type: 'test' });

    // wait for the gate
    let pending = h.store.listApprovals({ status: 'pending', runId });
    for (let i = 0; i < 400 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
      pending = h.store.listApprovals({ status: 'pending', runId });
    }
    if (pending.length === 0) {
      const p = h.runs.projection(runId)!;
      throw new Error(`no gate; run ${p.status} ${p.error ?? ''}: ${Object.values(p.nodes).map((n) => `${n.nodeId}=${n.status}${n.error ? `(${n.error})` : ''}`).join(', ')}`);
    }
    const gate = pending[0]!;
    expect(gate.kind).toBe('gate');
    const items = (gate.request as { items: Array<{ label: string; value: unknown }> }).items;
    expect(String(items[0]!.value)).toContain('+new feature');

    const p1 = h.runs.projection(runId)!;
    const wt = h.worktrees.get(runId, 'implement')!;
    expect(wt).toBeDefined();
    expect(fs.existsSync(path.join(wt.path, 'feature.txt'))).toBe(true);
    expect(fs.existsSync(path.join(repo, 'feature.txt'))).toBe(false); // main checkout untouched
    expect(fs.existsSync(path.join(wt.path, 'node_modules', 'dep', 'index.js'))).toBe(true); // linked
    expect(p1.nodes['test@']?.outputs?.stdout).toContain('new feature');
    expect(p1.nodes['implement@']?.outputs?.files_changed).toEqual(['feature.txt']);
    expect(p1.nodes['commit@']?.outputs?.committed).toBe(true);
    const log = await git(['log', '--oneline', wt.branch]);
    expect(log.stdout).toContain('add feature');

    h.approvals.decide(gate.id, { status: 'rejected', comment: 'nope', remember: 'none', decidedBy: 'tester' });
    const p = await h.runs.wait(runId, 30_000);
    expect(p.status).toBe('completed');
    expect(p.nodes['gate@']?.outputs?.decision).toBe('rejected');
    expect(p.nodes['discard@']?.outputs?.removed).toBe(true);
    expect(fs.existsSync(wt.path)).toBe(false);
    const branches = await git(['branch', '--list', wt.branch]);
    expect(branches.stdout.trim()).toBe('');
  }, 60_000);

  it('gives structured results to judge nodes and exposes approve/score', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'judge', type: 'agent.copilot', position: pos, config: { adapter: 'fake', prompt: '@fake:result {"approve": true, "score": 0.9, "findings": []}', outputSchema: { type: 'object' } } },
        { id: 'route', type: 'control.condition', position: pos, config: { expression: 'nodes.judge.json.approve && nodes.judge.score > 0.5' } },
      ],
      edges: [edge('start', 'judge'), edge('judge', 'route')],
    });
    const { runId } = await h.runs.startFromDocument(d, path.join(repo, 'y.workflow.json'), {}, { type: 'test' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('completed');
    expect(p.nodes['judge@']?.outputs?.approve).toBe(true);
    expect(p.nodes['route@']?.outputs?.value).toBe(true);
  });

  it('fails a judge node that never submits a result', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'judge', type: 'agent.copilot', position: pos, config: { adapter: 'fake', prompt: '@fake:say no result', outputSchema: { type: 'object' } } },
      ],
      edges: [edge('start', 'judge')],
    });
    const { runId } = await h.runs.startFromDocument(d, path.join(repo, 'z.workflow.json'), {}, { type: 'test' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('failed');
    expect(p.nodes['judge@']?.error).toMatch(/submit_result/);
  });
});
