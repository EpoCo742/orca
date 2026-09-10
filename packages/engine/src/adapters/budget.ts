/** Counts premium requests and tool calls for one agent session and decides when to stop. */
export class BudgetTracker {
  premiumRequests = 0;
  toolCalls = 0;
  modelCalls = 0;
  stopReason: 'error_max_turns' | 'error_max_tool_calls' | undefined;

  constructor(private readonly caps: { maxPremiumRequests: number; maxToolCalls: number }) {}

  /** Record a model call with its premium-request cost. Returns a stop reason when a cap is hit. */
  recordModelCall(cost: number): 'error_max_turns' | undefined {
    this.modelCalls++;
    this.premiumRequests += Number.isFinite(cost) ? cost : 1;
    if (!this.stopReason && this.premiumRequests >= this.caps.maxPremiumRequests) this.stopReason = 'error_max_turns';
    return this.stopReason === 'error_max_turns' ? this.stopReason : undefined;
  }

  recordToolCall(): 'error_max_tool_calls' | undefined {
    this.toolCalls++;
    if (!this.stopReason && this.toolCalls > this.caps.maxToolCalls) this.stopReason = 'error_max_tool_calls';
    return this.stopReason === 'error_max_tool_calls' ? this.stopReason : undefined;
  }

  describe(): string {
    return this.stopReason === 'error_max_turns'
      ? `premium request cap reached (${this.caps.maxPremiumRequests})`
      : this.stopReason === 'error_max_tool_calls'
        ? `tool call cap reached (${this.caps.maxToolCalls})`
        : '';
  }
}
