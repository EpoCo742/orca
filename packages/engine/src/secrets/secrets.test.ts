import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSecretsProvider, MemorySecretsProvider } from './provider.js';
import { Redactor, referencedSecrets, resolveDeep, resolveString } from './resolve.js';

describe('secrets', () => {
  it('encrypts at rest and round-trips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-secrets-'));
    const a = new FileSecretsProvider(dir);
    a.set('GITHUB_TOKEN', 'ghp_supersecretvalue');
    const raw = fs.readFileSync(path.join(dir, 'secrets.enc.json'), 'utf8');
    expect(raw).not.toContain('supersecret');
    const b = new FileSecretsProvider(dir);
    expect(b.get('GITHUB_TOKEN')).toBe('ghp_supersecretvalue');
    expect(b.list()).toEqual(['GITHUB_TOKEN']);
    expect(b.delete('GITHUB_TOKEN')).toBe(true);
    expect(new FileSecretsProvider(dir).list()).toEqual([]);
    expect(() => a.set('bad-name', 'x')).toThrow(/invalid secret name/);
  });

  it('resolves placeholders and reports missing ones', () => {
    const s = new MemorySecretsProvider();
    s.set('TOKEN', 'abc123');
    expect(resolveString('Bearer ${SECRET:TOKEN} in ${CWD}', s, { cwd: '/w' })).toBe('Bearer abc123 in /w');
    expect(resolveDeep({ headers: { Authorization: 'Bearer ${SECRET:TOKEN}' }, args: ['${CWD}'] }, s, { cwd: '/w' })).toEqual({ headers: { Authorization: 'Bearer abc123' }, args: ['/w'] });
    expect(() => resolveString('${SECRET:NOPE}', s)).toThrow(/NOPE/);
    expect([...referencedSecrets({ a: '${SECRET:X}', b: ['${SECRET:Y}', 'plain'] })]).toEqual(['X', 'Y']);
  });

  it('redacts secret values from text and JSON', () => {
    const s = new MemorySecretsProvider();
    s.set('TOKEN', 'abc123xyz');
    s.set('SHORT', 'ab');
    const r = new Redactor(s);
    expect(r.redact('token=abc123xyz and ab')).toBe('token=*** and ab');
    expect(r.redactJson({ h: 'Bearer abc123xyz', n: 1 })).toEqual({ h: 'Bearer ***', n: 1 });
    s.set('OTHER', 'zzzzzz');
    expect(r.redact('zzzzzz')).toBe('***');
  });
});
