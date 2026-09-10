import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { Redactor } from '../secrets/resolve.js';
import { defaultExecutors } from './executors/index.js';
import type { EngineServices } from './context.js';

const sandbox = new ExpressionSandbox();
let tmp: string;

function harness() {
  const db = openDatabase(':memory:');
  const store = new RunStore(db);
  const logger = createLogger('silent');
  const secrets = new MemorySecretsProvider();
  store.redactor = new Redactor(secrets);
  const services: EngineServices = { store, sandbox, approvals: new ApprovalBroker(store), worktrees: new WorktreeManager(db, logger), secrets, adapters: { fake: new FakeAdapter() }, logger, agentSlots: { max: 8, used: 0 } };
  const workflows = new WorkflowStore(db);
  const runs = new RunManager(services, defaultExecutors(), workflows);
  services.runs = runs;
  services.workflows = workflows;
  return { db, store, services, runs, workflows, secrets };
}

const pos = { x: 0, y: 0 };
const edge = (from: string, to: string, fromPort = 'done') => ({ id: `${from}-${fromPort}-${to}`, from: { node: from, port: fromPort }, to: { node: to, port: 'trigger' } });
const doc = (input: Omit<WorkflowDocumentInput, 'schemaVersion' | 'id' | 'name'> & { name?: string }): WorkflowDocument =>
  WorkflowDocument.parse({ schemaVersion: 1, id: crypto.randomUUID(), name: input.name ?? 'm3', ...input });

beforeAll(async () => {
  await sandbox.init();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-m3-'));
});
const wfPath = (name = 'wf') => path.join(tmp, `${name}.workflow.json`);

describe('map fan-out', () => {
  it('runs the body per item with bounded concurrency and collects results', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.', maxConcurrentAgents: 8 },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'files', type: 'data.transform', position: pos, config: { code: "return ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']" } },
        { id: 'review', type: 'control.map', position: pos, config: { items: 'nodes.files.value', concurrency: 2 } },
        { id: 'judge', type: 'agent.copilot', position: pos, parent: 'review', config: { adapter: 'fake', prompt: '@fake:slow 60\n@fake:result {"file": "{{ item }}", "index": {{ index }}, "ok": true}', outputSchema: { type: 'object' } } },
        { id: 'merge', type: 'data.transform', position: pos, config: { code: 'return nodes.review.results.map(r => r.judge.json.file).join(",") + " ok=" + nodes.review.succeeded' } },
      ],
      edges: [edge('start', 'files'), edge('files', 'review'), edge('review', 'merge')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath(), {}, { type: 'test' });
    // observe concurrency while running
    let maxRunning = 0;
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      const p = h.runs.projection(runId)!;
      const running = Object.values(p.nodes).filter((n) => n.nodeId === 'judge' && n.status === 'running').length;
      maxRunning = Math.max(maxRunning, running);
      if (p.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('completed');
    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(maxRunning).toBeGreaterThanOrEqual(1);
    expect(p.nodes['review@']?.outputs?.succeeded).toBe(5);
    expect(p.nodes['merge@']?.outputs?.value).toBe('a.ts,b.ts,c.ts,d.ts,e.ts ok=5');
    expect(p.nodes['judge@review[3]']?.outputs?.json).toMatchObject({ file: 'd.ts', index: 3 });
  });

  it('tolerates item failures by default and reports them in results', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'm', type: 'control.map', position: pos, config: { items: '[1, 2, 3]', concurrency: 3 } },
        { id: 'work', type: 'agent.copilot', position: pos, parent: 'm', config: { adapter: 'fake', prompt: '{{ item === 2 ? "@fake:fail" : "@fake:say fine" }}' } },
        { id: 'after', type: 'data.transform', position: pos, config: { code: 'return nodes.m.failed + ":" + nodes.m.succeeded' } },
      ],
      edges: [edge('start', 'm'), edge('m', 'after')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath('tol'), {}, { type: 'test' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('completed');
    expect(p.nodes['after@']?.outputs?.value).toBe('1:2');
    const results = p.nodes['m@']?.outputs?.results as Array<Record<string, unknown>>;
    expect(results[1]).toMatchObject({ error: 'fake failure' });
  });

  it('fails the run when continueOnError is false', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'm', type: 'control.map', position: pos, config: { items: '[1, 2]', continueOnError: false } },
        { id: 'work', type: 'agent.copilot', position: pos, parent: 'm', config: { adapter: 'fake', prompt: '@fake:fail' } },
      ],
      edges: [edge('start', 'm')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath('strict'), {}, { type: 'test' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('failed');
    expect(p.error).toMatch(/2 item\(s\) failed/);
  });
});

describe('join', () => {
  it('waits for all branches and merges outputs; any-mode fires on the first live branch', async () => {
    const h = harness();
    const d = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'a', type: 'data.transform', position: pos, config: { code: 'return 1' } },
        { id: 'b', type: 'data.transform', position: pos, config: { code: 'return 2' } },
        { id: 'gate', type: 'control.condition', position: pos, config: { expression: 'false' } },
        { id: 'c', type: 'data.transform', position: pos, config: { code: 'return 3' } },
        { id: 'all', type: 'control.join', position: pos, config: { mode: 'all' } },
        { id: 'any', type: 'control.join', position: pos, config: { mode: 'any' } },
        { id: 'strict', type: 'control.join', position: pos, config: { mode: 'all' } },
      ],
      edges: [edge('start', 'a'), edge('start', 'b'), edge('start', 'gate'), edge('gate', 'c', 'true'), edge('a', 'all'), edge('b', 'all'), edge('a', 'any'), edge('c', 'any'), edge('a', 'strict'), edge('c', 'strict')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath('join'), {}, { type: 'test' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('completed');
    expect(p.nodes['all@']?.outputs?.merged).toEqual({ a: { value: 1 }, b: { value: 2 } });
    expect(p.nodes['any@']?.status).toBe('completed');
    expect(p.nodes['any@']?.outputs?.merged).toEqual({ a: { value: 1 } });
    expect(p.nodes['strict@']?.status).toBe('skipped'); // c never ran
  });
});

describe('sub-workflow', () => {
  it('runs a child workflow and returns its top-level outputs', async () => {
    const h = harness();
    const child = doc({
      name: 'child',
      inputs: [{ name: 'n', type: 'number' }],
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'double', type: 'data.transform', position: pos, config: { code: 'return inputs.n * 2' } },
      ],
      edges: [edge('start', 'double')],
    });
    fs.writeFileSync(wfPath('child'), JSON.stringify(child));
    const parent = doc({
      settings: { repoPath: '.' },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'sub', type: 'workflow.sub', position: pos, config: { workflowRef: 'child.workflow.json', inputs: { n: '{{ 21 }}' } } },
        { id: 'after', type: 'data.transform', position: pos, config: { code: 'return nodes.sub.outputs.double.value' } },
      ],
      edges: [edge('start', 'sub'), edge('sub', 'after')],
    });
    const { runId } = await h.runs.startFromDocument(parent, wfPath('parent'), {}, { type: 'test' });
    const p = await h.runs.wait(runId, 20_000);
    expect(p.status).toBe('completed');
    expect(p.nodes['after@']?.outputs?.value).toBe(42);
    expect(p.nodes['sub@']?.outputs?.status).toBe('completed');
    const childRun = h.store.listRuns({ workflowId: child.id })[0]!;
    expect(childRun.status).toBe('completed');
  });
});

describe('secrets redaction', () => {
  it('never persists secret values in events or transcripts', async () => {
    const h = harness();
    h.secrets.set('API_TOKEN', 'tok_supersecret_9f8e7d');
    const d = doc({
      settings: { repoPath: '.', env: { TOKEN_ECHO: 'value is ${SECRET:API_TOKEN}' } },
      nodes: [
        { id: 'start', type: 'trigger.manual', position: pos },
        { id: 'leak', type: 'agent.copilot', position: pos, config: { adapter: 'fake', prompt: 'The token is tok_supersecret_9f8e7d, keep it safe\n@fake:say echoed tok_supersecret_9f8e7d' } },
      ],
      edges: [edge('start', 'leak')],
    });
    const { runId } = await h.runs.startFromDocument(d, wfPath('leak'), {}, { type: 'test' });
    const p = await h.runs.wait(runId);
    expect(p.status).toBe('completed');
    expect(p.nodes['leak@']?.outputs?.text).toBe('echoed ***');
    const events = JSON.stringify(h.store.events(runId));
    const transcript = JSON.stringify(h.store.transcripts(runId, 'leak', ''));
    expect(events).not.toContain('supersecret');
    expect(transcript).not.toContain('supersecret');
    expect(transcript).toContain('***');
  });
});
