import { execa } from 'execa';
import type { ConditionConfig, ShellConfig, TransformConfig } from '@orca/shared';
import { NodeExecError, type ExecContext, type ExecResult, type NodeExecutor } from '../context.js';

export const manualTriggerExecutor: NodeExecutor = {
  type: 'trigger.manual',
  async execute(ctx): Promise<ExecResult> {
    return { outputs: { inputs: ctx.exprCtx.inputs } };
  },
};

export const conditionExecutor: NodeExecutor<ConditionConfig> = {
  type: 'control.condition',
  async execute(ctx): Promise<ExecResult> {
    const value = Boolean(ctx.services.sandbox.evaluate(ctx.config.expression, ctx.exprCtx));
    return { outputs: { value }, fired: [value ? 'true' : 'false', 'done'] };
  },
};

export const transformExecutor: NodeExecutor<TransformConfig> = {
  type: 'data.transform',
  async execute(ctx): Promise<ExecResult> {
    const value = ctx.services.sandbox.callFunction(ctx.config.code, ctx.exprCtx);
    return { outputs: { value } };
  },
};

export function shellInvocation(shell: ShellConfig['shell'], command: string): { file: string; args: string[] } {
  const resolved = shell === 'auto' ? (process.platform === 'win32' ? 'powershell' : 'bash') : shell;
  switch (resolved) {
    case 'powershell':
      // Propagate the native command's exit code; PowerShell would otherwise report 0/1 only.
      return { file: 'powershell', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${command}\nif ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }`] };
    case 'cmd':
      return { file: 'cmd', args: ['/d', '/s', '/c', command] };
    case 'sh':
      return { file: 'sh', args: ['-c', command] };
    case 'bash':
    default:
      return { file: 'bash', args: ['-lc', command] };
  }
}

export const shellExecutor: NodeExecutor<ShellConfig> = {
  type: 'action.shell',
  async execute(ctx: ExecContext<ShellConfig>): Promise<ExecResult> {
    const { file, args } = shellInvocation(ctx.config.shell, ctx.config.command);
    const started = Date.now();
    ctx.progress('summary', `$ ${ctx.config.command}`);
    const child = execa(file, args, {
      cwd: ctx.cwd,
      env: { ...process.env, ...ctx.exprCtx.env, ...ctx.config.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      timeout: ctx.config.timeoutMs,
      maxBuffer: ctx.config.captureLimitBytes,
      reject: false,
      windowsHide: true,
      cancelSignal: ctx.signal,
      stripFinalNewline: false,
    });
    child.stdout?.on('data', (chunk: Buffer) => ctx.progress('stdout', chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => ctx.progress('stderr', chunk.toString()));
    const result = await child;
    if (ctx.signal.aborted) throw new NodeExecError('cancelled', 'cancelled');
    if (result.timedOut) throw new NodeExecError(`command timed out after ${ctx.config.timeoutMs} ms`, 'timeout');
    const exitCode = result.exitCode ?? (result.failed ? 1 : 0);
    const outputs = { exit_code: exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '', duration_ms: Date.now() - started };
    if (ctx.config.failOnNonZero && exitCode !== 0) throw new NodeExecError(`command exited with code ${exitCode}`, 'nonzero_exit');
    return { outputs };
  },
};
