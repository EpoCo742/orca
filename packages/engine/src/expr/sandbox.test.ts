import { beforeAll, describe, expect, it } from 'vitest';
import { ExpressionSandbox, ExprError, type ExprContext } from './sandbox.js';

const ctx: ExprContext = {
  inputs: { issue: 'ABC-1' },
  nodes: { test: { exit_code: 1, stdout: 'x\ny\nz' }, plan: { json: { files: ['a.ts', 'b.ts'] } } },
  run: { id: 'r1', startedAt: '2026-09-10T00:00:00Z', workflow: { id: 'w', name: 'wf' } },
  env: { CI: '1' },
};

describe('ExpressionSandbox', () => {
  const sb = new ExpressionSandbox({ cpuMs: 50 });
  beforeAll(() => sb.init());

  it('evaluates expressions against the context', () => {
    expect(sb.evaluate('nodes.test.exit_code !== 0', ctx)).toBe(true);
    expect(sb.evaluate("nodes['plan'].json.files.length", ctx)).toBe(2);
    expect(sb.evaluate('inputs.issue + env.CI', ctx)).toBe('ABC-11');
  });

  it('renders templates', () => {
    expect(sb.render('Exit {{ nodes.test.exit_code }}: {{ orca.lines(nodes.test.stdout).length }} lines, {{ nodes.missing }}', { ...ctx, nodes: { ...ctx.nodes, missing: undefined as never } })).toBe(
      'Exit 1: 3 lines, ',
    );
    expect(sb.render('{{ nodes.plan.json }}', ctx)).toContain('"a.ts"');
    expect(sb.render('literal \\{{ braces', ctx)).toBe('literal {{ braces');
  });

  it('runs function bodies', () => {
    expect(sb.callFunction('return ctx.nodes.plan.json.files.map(f => f.toUpperCase())', ctx)).toEqual(['A.TS', 'B.TS']);
  });

  it('rejects nondeterminism', () => {
    expect(() => sb.evaluate('Date.now()', ctx)).toThrow(/not allowed/);
    expect(() => sb.evaluate('Math.random()', ctx)).toThrow(/not allowed/);
    expect(() => sb.evaluate('new Date()', ctx)).toThrow(/not allowed/);
    expect(sb.evaluate('new Date(0).toISOString()', ctx)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('interrupts runaway code', () => {
    expect(() => sb.evaluate('(() => { while (true) {} })()', ctx)).toThrow(ExprError);
  });

  it('reports reference errors with the expression', () => {
    try {
      sb.evaluate('nodes.nope.value', ctx);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ExprError);
      expect((e as ExprError).expression).toBe('nodes.nope.value');
    }
  });

  it('cannot mutate the context', () => {
    expect(() => sb.evaluate("(__ctx.inputs.issue = 'hacked')", ctx)).toThrow();
  });
});
