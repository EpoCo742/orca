import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSWASMModule } from 'quickjs-emscripten';
import { parseTemplate } from '@orca/shared';

/** Frozen, JSON-serializable context visible to expressions and templates. */
export interface ExprContext {
  inputs: Record<string, unknown>;
  nodes: Record<string, Record<string, unknown>>;
  item?: unknown;
  index?: number;
  iteration?: { index: number; previous?: Record<string, Record<string, unknown>> };
  run: { id: string; startedAt: string; workflow: { id: string; name: string } };
  env: Record<string, string>;
}

export class ExprError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
  ) {
    super(message);
    this.name = 'ExprError';
  }
}

export interface SandboxOptions {
  cpuMs?: number;
  memoryBytes?: number;
}

const PRELUDE = `
  const __deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) __deepFreeze(o[k]); } return o; };
  const __throwDeterminism = (what) => { throw new Error(what + ' is not allowed in workflow expressions (non-deterministic). Pass values in as inputs.'); };
  Date.now = () => __throwDeterminism('Date.now()');
  Math.random = () => __throwDeterminism('Math.random()');
  const __OrigDate = Date;
  globalThis.Date = new Proxy(__OrigDate, { construct(target, args) { if (args.length === 0) __throwDeterminism('new Date()'); return new target(...args); }, apply() { __throwDeterminism('Date()'); } });
  globalThis.orca = Object.freeze({
    json: (x) => JSON.stringify(x, null, 2),
    lines: (s) => String(s ?? '').split(/\\r?\\n/).filter(Boolean),
    truncate: (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '...' : s; },
    tail: (s, n) => { const l = String(s ?? '').split(/\\r?\\n/); return l.slice(Math.max(0, l.length - n)).join('\\n'); },
  });
`;

export class ExpressionSandbox {
  private module: QuickJSWASMModule | undefined;
  private readonly cpuMs: number;
  private readonly memoryBytes: number;

  constructor(opts: SandboxOptions = {}) {
    this.cpuMs = opts.cpuMs ?? 50;
    this.memoryBytes = opts.memoryBytes ?? 16 * 1024 * 1024;
  }

  async init(): Promise<void> {
    if (!this.module) this.module = await getQuickJS();
  }

  /** Evaluate a bare JavaScript expression against the context. */
  evaluate(expression: string, ctx: ExprContext): unknown {
    return this.run(`"use strict"; (${expression}\n)`, ctx, expression);
  }

  /** Run a function body `(ctx) => { ... }` and return its result. */
  callFunction(body: string, ctx: ExprContext): unknown {
    return this.run(`"use strict"; ((ctx) => {\n${body}\n})(__ctx)`, ctx, body);
  }

  /** Render `{{ }}` templates. Objects are JSON-stringified; null/undefined render as empty strings. */
  render(template: string, ctx: ExprContext): string {
    let out = '';
    for (const seg of parseTemplate(template)) {
      if (seg.kind === 'text') out += seg.text;
      else {
        const v = this.evaluate(seg.expr, ctx);
        out += v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
      }
    }
    return out;
  }

  private run(code: string, ctx: ExprContext, source: string): unknown {
    if (!this.module) throw new Error('ExpressionSandbox.init() must be awaited before use');
    const runtime = this.module.newRuntime();
    try {
      runtime.setMemoryLimit(this.memoryBytes);
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.cpuMs));
      const vm = runtime.newContext();
      try {
        const setup = vm.evalCode(
          `${PRELUDE}\nconst __ctx = ${JSON.stringify(ctx)};\nconst { inputs, nodes, item, index, iteration, run, env } = __ctx;\n__deepFreeze(__ctx);`,
        );
        if (setup.error) {
          const err = vm.dump(setup.error);
          setup.error.dispose();
          throw new ExprError(`sandbox setup failed: ${describeError(err)}`, source);
        }
        setup.value.dispose();
        const result = vm.evalCode(code);
        if (result.error) {
          const err = vm.dump(result.error);
          result.error.dispose();
          throw new ExprError(describeError(err), source);
        }
        const value = vm.dump(result.value);
        result.value.dispose();
        return value;
      } finally {
        vm.dispose();
      }
    } finally {
      runtime.dispose();
    }
  }
}

function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string };
    if (e.message) return e.name ? `${e.name}: ${e.message}` : e.message;
  }
  return String(err);
}

let shared: ExpressionSandbox | undefined;
export async function getSharedSandbox(): Promise<ExpressionSandbox> {
  if (!shared) {
    shared = new ExpressionSandbox();
    await shared.init();
  }
  return shared;
}
