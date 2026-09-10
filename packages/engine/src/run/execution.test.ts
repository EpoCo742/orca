import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WorkflowDocument, type WorkflowDocumentInput } from '@orca/shared';
import { openDatabase, type Database } from '../db/database.js';
import { RunStore } from './store.js';
import { ApprovalBroker } from '../approvals/broker.js';
import { ExpressionSandbox } from '../expr/sandbox.js';
import { FakeAdapter } from '../adapters/fake.js';
import { createLogger } from '../logger.js';
import { WorkflowStore } from '../workflows/store.js';
import { RunManager } from './manager.js';
import { defaultExecutors } from './executors/index.js';
import type { EngineServices } from './context.js';

const sandbox = new ExpressionSandbox();
let tmp: string;

function harness(dbPath = ':memory:') {
  const db: Database = openDatabase(dbPath);
  const store = new RunStore(db);
  const approvals = new ApprovalBroker(store);
  const services: EngineServices = { store, sandbox, approvals, adapters: { fake: new FakeAdapter() }, logger: createLogger('silent'), agentSlots: { max: 8, used: 0 } };
  const workflows = new WorkflowStore(db);
  const runs = new RunManager(services, defaultExecutors(), workflows);
  return { db, store, approvals, services, workflows, runs };
}

function doc(input: Omit<WorkflowDocumentInput, 'schemaVersion' | 'id' | 'name'> & { name?: string }): WorkflowDocument {
  return WorkflowDocument.parse({ schemaVersion: 1, id: crypto.randomUUID(), name: input.name ?? 'test', ...input });
}

const pos = { x: 0, y: 0 };
const edge = (from: string, to: string, fromPort = 'done', toPort = 'trigger', when?: string) => ({ id: `${from}-${fromPort}-${to}`, from: { node: from, port: fromPort }, to: { node: to, port: toPort }, when });

beforeAll(async () => {
  await sandbox.init();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-exec-'));
});
afterEach(() => {
  /* keep tmp for inspection on failure */
});

const wfPath = () => path.join(tmp, 'wf.workflow.json');

describe('RunExecution', () => {
  it('runs a linear chain and exposes upstream outputs to templates', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'calc', type: 'data.transform', position: pos, config: { code: 'return inputs.n * 2' } },
        { id: 'agent', type: 'agent.copilot', position: pos, config: { adapter: 'fake', prompt: 'value is {{ nodes.calc.value }}\n@fake:say got {{ nodes.calc.value }}' } },
      ],
      edges: [edge('start', 'calc'), edge('calc', 'agent')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath(), { n: 21 }, { type: 'test' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('completed');
    expect(p.nodes['calc@']?.outputs?.value).toBe(42);
    expect(p.nodes['agent@']?.outputs?.text).toBe('got 42');
    expect(p.cost.premiumRequests).toBeGreaterThan(0);
    const transcript = h.store.transcripts(runId, 'agent', '');
    expect(transcript.some((r) => r.kind === 'assistant.message')).toBe(true);
  });

  it('routes conditions and skips the untaken branch', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'check', type: 'control.condition', position: pos, config: { expression: 'inputs.go === true' } },
        { id: 'yes', type: 'data.transform', position: pos, config: { code: "return 'yes'" } },
        { id: 'no', type: 'data.transform', position: pos, config: { code: "return 'no'" } },
        { id: 'after', type: 'data.transform', position: pos, config: { code: "return (nodes.yes ? nodes.yes.value : '') + (nodes.no ? nodes.no.value : '')" } },
      ],
      edges: [edge('start', 'check'), edge('check', 'yes', 'true'), edge('check', 'no', 'false'), edge('yes', 'after'), edge('no', 'after')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath(), { go: true }, { type: 'test' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('completed');
    expect(p.nodes['yes@']?.status).toBe('completed');
    expect(p.nodes['no@']?.status).toBe('skipped');
    expect(p.nodes['after@']?.outputs?.value).toBe('yes');
  });

  it('iterates a loop until the condition holds, exposing previous iteration outputs', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'loop', type: 'control.loop', position: pos, config: { until: 'nodes.count.value >= 3', maxIterations: 10 } },
        { id: 'count', type: 'data.transform', position: pos, parent: 'loop', config: { code: 'return (ctx.iteration.previous ? ctx.iteration.previous.count.value : 0) + 1' } },
        { id: 'after', type: 'data.transform', position: pos, config: { code: 'return nodes.loop.last.count.value * 10 + nodes.loop.iterations' } },
      ],
      edges: [edge('start', 'loop'), edge('loop', 'after')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath(), {}, { type: 'test' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('completed');
    expect(p.nodes['loop@']?.outputs?.iterations).toBe(3);
    expect(p.nodes['loop@']?.outputs?.exited_by).toBe('until');
    expect(p.nodes['count@loop[2]']?.outputs?.value).toBe(3);
    expect(p.nodes['after@']?.outputs?.value).toBe(33);
  });

  it('stops a loop at maxIterations', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'loop', type: 'control.loop', position: pos, config: { until: 'false', maxIterations: 2 } },
        { id: 'body', type: 'data.transform', position: pos, parent: 'loop', config: { code: 'return 1' } },
      ],
      edges: [edge('start', 'loop')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath(), {}, { type: 'test' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('completed');
    expect(p.nodes['loop@']?.outputs?.exited_by).toBe('max');
    expect(p.nodes['loop@']?.outputs?.iterations).toBe(2);
  });

  it('runs shell commands and captures exit codes', async () => {
    const h = harness();
    const cmd = process.platform === 'win32' ? 'Write-Output hello; exit 3' : 'echo hello; exit 3';
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'sh', type: 'action.shell', position: pos, config: { command: cmd } },
        { id: 'check', type: 'control.condition', position: pos, config: { expression: 'nodes.sh.exit_code === 3 && nodes.sh.stdout.trim() === "hello"' } },
      ],
      edges: [edge('start', 'sh'), edge('sh', 'check')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath(), {}, { type: 'test' });
    const p = await h.runs.wait(runId, 30_000);
    expect(p.status).toBe('completed');
    expect(p.nodes['check@']?.outputs?.value).toBe(true);
  });

  it('fails the run when a node fails without an error edge, and retries per policy', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'bad', type: 'agent.copilot', position: pos, retry: { maxAttempts: 2, backoffMs: 1 }, config: { adapter: 'fake', prompt: '@fake:fail' } },
        { id: 'never', type: 'data.transform', position: pos, config: { code: 'return 1' } },
      ],
      edges: [edge('start', 'bad'), edge('bad', 'never')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath(), {}, { type: 'test' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('failed');
    expect(p.nodes['bad@']?.attempt).toBe(2);
    expect(p.nodes['never@']?.status ?? 'pending').not.toBe('completed');
    expect(h.store.events(runId).filter((e) => e.event.type === 'node.retry')).toHaveLength(1);
  });

  it('routes failures through an error edge', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'bad', type: 'agent.copilot', position: pos, config: { adapter: 'fake', prompt: '@fake:fail' } },
        { id: 'handler', type: 'data.transform', position: pos, config: { code: "return 'handled'" } },
      ],
      edges: [edge('start', 'bad'), edge('bad', 'handler', 'error')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath(), {}, { type: 'test' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('completed');
    expect(p.nodes['handler@']?.outputs?.value).toBe('handled');
  });

  it('asks for permission through the broker and honors the decision', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'agent', type: 'agent.copilot', position: pos, config: { adapter: 'fake', prompt: '@fake:say done\n@fake:permission shell npm install left-pad', allowedTools: ['Read'], approval: { timeoutSec: 5 } } },
      ],
      edges: [edge('start', 'agent')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath(), {}, { type: 'test' });
    // wait for the approval to appear
    let pending = h.store.listApprovals({ status: 'pending', runId });
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pending = h.store.listApprovals({ status: 'pending', runId });
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]!.request).toMatchObject({ kind: 'tool_permission', toolKind: 'shell', command: 'npm install left-pad' });
    expect(h.runs.projection(runId)?.nodes['agent@']?.status).toBe('waiting');
    h.approvals.decide(pending[0]!.id, { status: 'rejected', comment: 'nope', remember: 'none', decidedBy: 'tester' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('completed');
    expect(p.nodes['agent@']?.outputs?.text).toMatch(/permission denied: rejected by tester: nope/);
  });

  it('times out approvals per policy', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'agent', type: 'agent.copilot', position: pos, config: { adapter: 'fake', prompt: '@fake:permission shell rm -rf build\n@fake:say ok', allowedTools: [], approval: { timeoutSec: 1, onTimeout: 'allow' } } },
      ],
      edges: [edge('start', 'agent')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath(), {}, { type: 'test' });
    const p = await h.runs.wait(runId, 10_000);
    expect(p.status).toBe('completed');
    expect(p.nodes['agent@']?.outputs?.text).toBe('ok');
  });

  it('cancels a run', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'slow', type: 'agent.copilot', position: pos, config: { adapter: 'fake', prompt: '@fake:slow 2000\n@fake:say late' } },
      ],
      edges: [edge('start', 'slow')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath(), {}, { type: 'test' });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.runs.cancel(runId)).toBe(true);
    const p = await h.runs.wait(runId, 10_000);
    expect(p.status).toBe('cancelled');
  });

  it('resumes an in-flight run after a restart without re-running completed nodes', async () => {
    const dbFile = path.join(tmp, `resume-${Date.now()}.db`);
    const h1 = harness(dbFile);
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'first', type: 'data.transform', position: pos, config: { code: 'return 1' } },
        { id: 'slow', type: 'agent.copilot', position: pos, config: { adapter: 'fake', prompt: '@fake:slow 60000\n@fake:say late' } },
        { id: 'last', type: 'data.transform', position: pos, config: { code: 'return nodes.first.value + 1' } },
      ],
      edges: [edge('start', 'first'), edge('first', 'slow'), edge('slow', 'last')],
    });
    const { runId } = await h1.runs.startFromDocument(d, wfPath(), {}, { type: 'test' });
    await new Promise((r) => setTimeout(r, 200));
    expect(h1.runs.projection(runId)?.nodes['slow@']?.status).toBe('running');
    // Simulate a crash: drop the process state without emitting anything, reopen the DB.
    h1.db.close();

    const h2 = harness(dbFile);
    // Speed up the re-run by swapping the adapter script: the snapshot still says slow 60000, so use a
    // fake adapter that ignores @fake:slow.
    const fast = new FakeAdapter();
    const orig = fast.run.bind(fast);
    fast.run = (spec, hooks, signal) => orig({ ...spec, prompt: spec.prompt.replace('@fake:slow 60000', '') }, hooks, signal);
    h2.services.adapters.fake = fast;
    const resumed = await h2.runs.resumeAll();
    expect(resumed).toEqual([runId]);
    const p = await h2.runs.wait(runId, 10_000);
    expect(p.status).toBe('completed');
    const starts = h2.store.events(runId).filter((e) => e.event.type === 'node.started' && (e.event as { nodeId: string }).nodeId === 'first');
    expect(starts).toHaveLength(1); // memoized, not re-run
    expect(p.nodes['slow@']?.attempt).toBe(2); // re-dispatched
    expect(p.nodes['last@']?.outputs?.value).toBe(2);
    h2.db.close();
  });
});
