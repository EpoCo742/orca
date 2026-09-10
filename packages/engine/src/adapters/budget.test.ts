import { describe, expect, it } from 'vitest';
import { BudgetTracker } from './budget.js';

describe('BudgetTracker', () => {
  it('stops at the premium request cap, counting fractional costs', () => {
    const b = new BudgetTracker({ maxPremiumRequests: 3, maxToolCalls: 100 });
    expect(b.recordModelCall(1)).toBeUndefined();
    expect(b.recordModelCall(0.5)).toBeUndefined();
    expect(b.recordModelCall(1)).toBeUndefined();
    expect(b.recordModelCall(1)).toBe('error_max_turns');
    expect(b.premiumRequests).toBe(3.5);
    expect(b.modelCalls).toBe(4);
    expect(b.describe()).toMatch(/premium request cap/);
  });

  it('stops when tool calls exceed the cap and keeps the first stop reason', () => {
    const b = new BudgetTracker({ maxPremiumRequests: 100, maxToolCalls: 2 });
    expect(b.recordToolCall()).toBeUndefined();
    expect(b.recordToolCall()).toBeUndefined();
    expect(b.recordToolCall()).toBe('error_max_tool_calls');
    expect(b.recordModelCall(1000)).toBeUndefined(); // already stopped for another reason
    expect(b.stopReason).toBe('error_max_tool_calls');
  });

  it('treats a missing cost as one request', () => {
    const b = new BudgetTracker({ maxPremiumRequests: 2, maxToolCalls: 10 });
    b.recordModelCall(Number.NaN);
    expect(b.premiumRequests).toBe(1);
  });
});
