import type { AgentAdapter, AgentResult, AgentRunSpec, AdapterHooks } from './types.js';

/**
 * Scriptable fake adapter for tests and UI development.
 * The prompt can carry directives on their own lines:
 *   @fake:permission shell <command>   -> asks for permission; denied -> result text notes it
 *   @fake:fail                          -> throws
 *   @fake:slow <ms>                     -> waits
 *   @fake:say <text>                    -> final text (default "fake result")
 *   @fake:run <cmd>                     -> executes the command via node child_process in cwd (used by fix-until-green-fake)
 *   @fake:result <json>                 -> structured result (as if submit_result was called)
 *   @fake:write <file> <text>           -> writes a file in cwd (\n escapes allowed)
 */
export class FakeAdapter implements AgentAdapter {
  id = 'fake' as const;

  async run(spec: AgentRunSpec, hooks: AdapterHooks, signal: AbortSignal): Promise<AgentResult> {
    const started = Date.now();
    const sessionId = `fake-${Math.random().toString(36).slice(2, 10)}`;
    hooks.onSession(sessionId);
    hooks.onEvent('session.start', { sessionId, model: spec.model });
    hooks.onEvent('user.message', { content: spec.prompt });
    let text = 'fake result';
    let structured: unknown = undefined;
    let toolCalls = 0;
    let turns = 1;
    for (const line of spec.prompt.split(/\r?\n/)) {
      const m = /^@fake:(\w+)(?:\s+(.*))?$/.exec(line.trim());
      if (!m) continue;
      const [, cmd, arg = ''] = m;
      if (signal.aborted) throw new Error('cancelled');
      if (cmd === 'slow') await new Promise((r) => setTimeout(r, Number(arg) || 100));
      if (cmd === 'fail') throw new Error('fake failure');
      if (cmd === 'say') text = arg;
      if (cmd === 'result') {
        try {
          structured = JSON.parse(arg) as unknown;
        } catch {
          structured = arg;
        }
        hooks.onEvent('tool.execution_start', { toolName: 'submit_result', arguments: structured }, 'submit_result');
      }
      if (cmd === 'write') {
        const [file, ...rest] = arg.split(/\s+/);
        const fs = await import('node:fs');
        const path = await import('node:path');
        if (file) fs.writeFileSync(path.resolve(spec.cwd, file), rest.join(' ').replace(/\\n/g, '\n') + '\n');
        toolCalls++;
        hooks.onEvent('tool.execution_start', { toolName: 'write', arguments: { file } }, `write ${file}`);
      }
      if (cmd === 'permission') {
        const [kind, ...rest] = arg.split(/\s+/);
        const subject = rest.join(' ');
        hooks.onEvent('permission.requested', { kind, subject });
        const d = await hooks.onPermission({ kind: (kind as 'shell') ?? 'shell', subject }, { kind, subject });
        hooks.onEvent('permission.completed', { allow: d.allow, reason: d.reason });
        if (!d.allow) text = `permission denied: ${d.reason}`;
      }
      if (cmd === 'run') {
        toolCalls++;
        turns++;
        hooks.onEvent('tool.execution_start', { toolName: 'shell', arguments: { command: arg } }, `$ ${arg}`);
        const { execa } = await import('execa');
        const r = await execa(arg, { cwd: spec.cwd, shell: true, reject: false, env: { ...process.env, ...spec.env } });
        hooks.onEvent('tool.execution_complete', { success: r.exitCode === 0, result: { content: `${r.stdout}\n${r.stderr}` } }, `exit ${r.exitCode}`);
        hooks.onCost({ unit: 'premium_requests', amount: 1 });
      }
    }
    hooks.onEvent('assistant.message', { content: text });
    hooks.onCost({ unit: 'premium_requests', amount: 1 });
    return { subtype: 'success', text, structured, sessionId, cost: { unit: 'premium_requests', amount: turns }, numTurns: turns, toolCalls, durationMs: Date.now() - started };
  }
}
