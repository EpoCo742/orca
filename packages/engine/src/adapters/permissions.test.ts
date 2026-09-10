import { describe, expect, it } from 'vitest';
import { evaluatePolicy, globToRegex, parseRule, parseRules, rememberRuleFor } from './permissions.js';

describe('permission rules', () => {
  it('parses rule forms', () => {
    expect(parseRule('Read')?.kind).toBe('read');
    expect(parseRule('Shell(npm test*)')?.pattern?.test('npm test -- --run')).toBe(true);
    expect(parseRule('Shell(npm test*)')?.pattern?.test('npm install')).toBe(false);
    expect(parseRule('Mcp(github/list_*)')?.pattern?.test('github/list_issues')).toBe(true);
    expect(parseRule('Bogus(x)')).toBeUndefined();
  });

  it('globs are anchored and case-insensitive', () => {
    expect(globToRegex('npx vitest*').test('NPX VITEST run')).toBe(true);
    expect(globToRegex('git status*').test('echo; git status')).toBe(false);
  });

  it('evaluates deny before allow, read-only auto-allow, and unresolved policy', () => {
    const allow = parseRules(['Read', 'Write', 'Shell(npx vitest*)']);
    const deny = parseRules(['Shell(npx vitest --update*)']);
    const opts = { autoAllowReadOnly: true, onUnresolved: 'ask' as const };
    expect(evaluatePolicy({ kind: 'shell', subject: 'npx vitest run' }, allow, deny, opts).decision).toBe('allow');
    expect(evaluatePolicy({ kind: 'shell', subject: 'npx vitest --update-snapshots' }, allow, deny, opts).decision).toBe('deny');
    expect(evaluatePolicy({ kind: 'shell', subject: 'Get-ChildItem', readOnly: true }, allow, deny, opts).decision).toBe('allow');
    expect(evaluatePolicy({ kind: 'shell', subject: 'npm install left-pad' }, allow, deny, opts).decision).toBe('ask');
    expect(evaluatePolicy({ kind: 'shell', subject: 'npm install left-pad' }, allow, deny, { ...opts, onUnresolved: 'deny' }).decision).toBe('deny');
    expect(evaluatePolicy({ kind: 'read', subject: 'src/x.ts' }, [], deny, opts).decision).toBe('allow');
  });

  it('hard-denies destructive commands even when allowed', () => {
    const allow = parseRules(['Shell']);
    expect(evaluatePolicy({ kind: 'shell', subject: 'rm -rf /' }, allow, [], { autoAllowReadOnly: true, onUnresolved: 'ask' }).decision).toBe('deny');
    expect(evaluatePolicy({ kind: 'shell', subject: 'git push --force origin main' }, allow, [], { autoAllowReadOnly: true, onUnresolved: 'ask' }).decision).toBe('deny');
    expect(evaluatePolicy({ kind: 'shell', subject: 'rm -rf node_modules' }, allow, [], { autoAllowReadOnly: true, onUnresolved: 'ask' }).decision).toBe('allow');
  });

  it('derives remember-for-run rules', () => {
    expect(rememberRuleFor({ kind: 'shell', subject: 'npm install x' })).toBe('Shell(npm*)');
    expect(rememberRuleFor({ kind: 'write', subject: 'a.ts' })).toBe('Write');
  });
});
