import { describe, expect, it } from 'vitest';
import { HealthResponse, AuthStatusResponse } from './index.js';

describe('shared schemas', () => {
  it('parses a health response', () => {
    expect(HealthResponse.parse({ ok: true, version: '0.0.0', uptimeMs: 12 }).ok).toBe(true);
  });
  it('rejects a non-ok health response', () => {
    expect(() => HealthResponse.parse({ ok: false, version: 'x', uptimeMs: 0 })).toThrow();
  });
  it('parses an auth status', () => {
    const s = AuthStatusResponse.parse({ provider: 'copilot', isAuthenticated: false });
    expect(s.isAuthenticated).toBe(false);
  });
});
