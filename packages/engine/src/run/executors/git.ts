import type { GitConfig } from '@orca/shared';
import { NodeExecError, type ExecContext, type ExecResult, type NodeExecutor } from '../context.js';

/** Acts on the worktree owned by another node (`target`). */
export const gitExecutor: NodeExecutor<GitConfig> = {
  type: 'action.git',
  async execute(ctx: ExecContext<GitConfig>): Promise<ExecResult> {
    const cfg = ctx.config;
    const wt = ctx.services.worktrees;
    const rec = wt.get(ctx.runId, cfg.target);
    if (!rec) throw new NodeExecError(`no worktree exists for node "${cfg.target}" in this run (did it run with isolation: worktree?)`);
    const base = { branch: rec.branch, worktree_path: rec.path };
    switch (cfg.op) {
      case 'diff': {
        const d = await wt.diff(rec, cfg.base);
        ctx.progress('summary', `${d.stats.files} files, +${d.stats.insertions} -${d.stats.deletions}`);
        return { outputs: { ...base, diff: d.patch, files: d.files, stats: d.stats } };
      }
      case 'commit': {
        const r = await wt.commit(rec, cfg.message, { addAll: cfg.addAll, allowEmpty: cfg.allowEmpty });
        ctx.progress('summary', r.committed ? `committed ${r.commit.slice(0, 8)}` : 'nothing to commit');
        return { outputs: { ...base, commit: r.commit, committed: r.committed } };
      }
      case 'push': {
        await wt.push(rec, cfg.remote, cfg.setUpstream);
        ctx.progress('summary', `pushed ${rec.branch} to ${cfg.remote}`);
        return { outputs: { ...base, pushed: true } };
      }
      case 'pr.create': {
        const r = await wt.createPr(rec, { title: cfg.title, body: cfg.body, base: cfg.base, draft: cfg.draft });
        ctx.progress('summary', `PR ${r.url}`);
        return { outputs: { ...base, pr_url: r.url } };
      }
      case 'worktree.remove': {
        await wt.remove(rec, { force: cfg.force, deleteBranch: cfg.deleteBranch, reason: `git node ${ctx.node.node.id}`, emit: ctx.emit, nodeId: ctx.node.node.id, scope: ctx.scope });
        return { outputs: { ...base, removed: true } };
      }
      case 'worktree.keep': {
        wt.keep(rec);
        return { outputs: { ...base, kept: true } };
      }
      default:
        throw new NodeExecError(`unknown git op`);
    }
  },
};
