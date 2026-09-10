import { describe, expect, it } from 'vitest';
import { WorkflowDocument } from './workflow.js';
import { AgentCopilotConfig, LoopConfig, NODE_TYPES, ShellConfig } from './nodes.js';

describe('workflow schema', () => {
  it('applies nested defaults', () => {
    const doc = WorkflowDocument.parse({
      schemaVersion: 1,
      id: '3f1f8b1e-9b0d-4d0a-8a5e-1f2d3c4b5a69',
      name: 'x',
      nodes: [{ id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } }],
      edges: [],
    });
    expect(doc.settings.defaultModel).toBe('claude-sonnet-5');
    expect(doc.settings.maxConcurrentAgents).toBe(4);
    expect(doc.nodes[0]!.retry.maxAttempts).toBe(1);
  });

  it('rejects bad node ids', () => {
    expect(() =>
      WorkflowDocument.parse({
        schemaVersion: 1,
        id: '3f1f8b1e-9b0d-4d0a-8a5e-1f2d3c4b5a69',
        name: 'x',
        nodes: [{ id: 'Bad-Id', type: 'trigger.manual', position: { x: 0, y: 0 } }],
        edges: [],
      }),
    ).toThrow();
  });

  it('parses node configs with defaults', () => {
    expect(ShellConfig.parse({ command: 'npm test' }).timeoutMs).toBe(600_000);
    expect(LoopConfig.parse({ until: 'true', maxIterations: 3 }).maxIterations).toBe(3);
    const agent = AgentCopilotConfig.parse({ prompt: 'fix it' });
    expect(agent.approval.onUnresolved).toBe('ask');
    expect(agent.maxPremiumRequests).toBe(30);
  });

  it('registry has config schemas for every type', () => {
    for (const def of Object.values(NODE_TYPES)) {
      expect(def.config).toBeDefined();
      expect(def.type).toBeTruthy();
    }
  });
});
