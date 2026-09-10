import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { nanoid } from 'nanoid';
import type { RunEvent, WorktreeRecord, WorkflowSettings } from '@orca/shared';
import { nowIso, type Database } from '../db/database.js';
import type { Logger } from '../logger.js';
import { shellInvocation } from './executors/basic.js';

export interface DiffResult {
  patch: string;
  stats: { files: number; insertions: number; deletions: number };
  files: string[];
}

async function git(cwd: string, args: string[], opts: { reject?: boolean } = {}) {
  return execa('git', args, { cwd, windowsHide: true, reject: opts.reject ?? true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

/** One worktree per (run, owner node). Created lazily, reused across loop iterations, swept later. */
export class WorktreeManager {
  private creating = new Map<string, Promise<WorktreeRecord>>();

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  get(runId: string, ownerNodeId: string): WorktreeRecord | undefined {
    const r = this.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND owner_node_id=? AND status IN ('active','kept')").get(runId, ownerNodeId) as Record<string, unknown> | undefined;
    return r ? toRecord(r) : undefined;
  }

  list(runId: string): WorktreeRecord[] {
    return (this.db.prepare('SELECT * FROM worktrees WHERE run_id=? ORDER BY created_at').all(runId) as Record<string, unknown>[]).map(toRecord);
  }

  async ensure(args: {
    runId: string;
    ownerNodeId: string;
    repoPath: string;
    workflowSlug: string;
    settings: WorkflowSettings['worktree'];
    emit: (event: RunEvent) => void;
    nodeId: string;
    scope: string;
  }): Promise<WorktreeRecord> {
    const existing = this.get(args.runId, args.ownerNodeId);
    if (existing && fs.existsSync(existing.path)) return existing;
    const key = `${args.runId}:${args.ownerNodeId}`;
    let p = this.creating.get(key);
    if (!p) {
      p = this.create(args).finally(() => this.creating.delete(key));
      this.creating.set(key, p);
    }
    return p;
  }

  private async create(args: Parameters<WorktreeManager['ensure']>[0]): Promise<WorktreeRecord> {
    const { repoPath, settings } = args;
    const top = (await git(repoPath, ['rev-parse', '--show-toplevel'])).stdout.trim();
    const run8 = args.runId.slice(0, 8);
    const dir = path.resolve(top, settings.dir);
    fs.mkdirSync(dir, { recursive: true });
    const wtPath = path.join(dir, `${run8}-${args.ownerNodeId}`);
    const branch = `orca/${args.workflowSlug}/${run8}/${args.ownerNodeId}`;
    let base = 'HEAD';
    if (settings.baseRef === 'default-branch') {
      const r = await git(top, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { reject: false });
      if (r.exitCode === 0 && r.stdout.trim()) base = r.stdout.trim();
    }
    const baseSha = (await git(top, ['rev-parse', base])).stdout.trim();

    await git(top, ['config', 'core.longpaths', 'true'], { reject: false });
    excludeOrcaDir(top);
    if (fs.existsSync(wtPath)) await git(top, ['worktree', 'remove', '--force', wtPath], { reject: false });
    await git(top, ['branch', '-D', branch], { reject: false });
    await git(top, ['worktree', 'add', '-b', branch, wtPath, baseSha]);
    await git(top, ['worktree', 'lock', '--reason', `orca run ${args.runId}`, wtPath], { reject: false });

    // Relative repoPath inside a bigger repo (monorepo): the agent's cwd is the same subpath inside the worktree.
    const rel = path.relative(top, path.resolve(repoPath));
    const workPath = rel && !rel.startsWith('..') ? path.join(wtPath, rel) : wtPath;

    for (const d of settings.linkDirs) {
      const src = path.resolve(repoPath, d);
      const dst = path.resolve(workPath, d);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (err) {
        this.logger.warn({ err: String(err), d }, 'could not link directory into worktree');
      }
    }
    if (settings.setupCommand) {
      const { file, args: a } = shellInvocation('auto', settings.setupCommand);
      const r = await execa(file, a, { cwd: workPath, reject: false, windowsHide: true, timeout: 600_000 });
      if (r.exitCode !== 0) this.logger.warn({ code: r.exitCode, stderr: r.stderr.slice(0, 500) }, 'worktree setup command failed');
    }

    const rec: WorktreeRecord = {
      id: nanoid(10),
      runId: args.runId,
      ownerNodeId: args.ownerNodeId,
      repoPath: top,
      path: workPath,
      branch,
      baseRef: baseSha,
      status: 'active',
      createdAt: nowIso(),
    };
    this.db
      .prepare('INSERT OR REPLACE INTO worktrees (id, run_id, owner_node_id, repo_path, path, branch, base_ref, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(rec.id, rec.runId, rec.ownerNodeId, rec.repoPath, rec.path, rec.branch, rec.baseRef, rec.status, rec.createdAt);
    args.emit({ type: 'worktree.created', nodeId: args.nodeId, scope: args.scope, ownerNodeId: args.ownerNodeId, path: rec.path, branch });
    this.logger.info({ path: rec.path, branch }, 'worktree created');
    return rec;
  }

  async diff(rec: WorktreeRecord, base?: string): Promise<DiffResult> {
    const cwd = rec.path;
    const ref = base ?? 'HEAD';
    await git(cwd, ['add', '-A', '-N'], { reject: false }); // intent-to-add so new files show in the diff
    const patch = (await git(cwd, ['diff', ref, '--', '.'])).stdout;
    const numstat = (await git(cwd, ['diff', ref, '--numstat', '--', '.'])).stdout;
    const files = (await git(cwd, ['diff', ref, '--name-only', '--', '.'])).stdout.split(/\r?\n/).filter(Boolean);
    await git(cwd, ['reset', '-q'], { reject: false });
    let insertions = 0;
    let deletions = 0;
    for (const line of numstat.split(/\r?\n/)) {
      const [a, d] = line.split('\t');
      if (a && a !== '-') insertions += Number(a);
      if (d && d !== '-') deletions += Number(d);
    }
    return { patch, stats: { files: files.length, insertions, deletions }, files };
  }

  async changedFiles(cwd: string): Promise<string[]> {
    const r = await git(cwd, ['status', '--porcelain'], { reject: false });
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
  }

  async commit(rec: WorktreeRecord, message: string, opts: { addAll: boolean; allowEmpty: boolean }): Promise<{ commit: string; committed: boolean }> {
    const cwd = rec.path;
    if (opts.addAll) await git(cwd, ['add', '-A']);
    const status = (await git(cwd, ['status', '--porcelain'])).stdout.trim();
    if (!status && !opts.allowEmpty) return { commit: (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim(), committed: false };
    const args = ['commit', '-m', message, '--no-verify'];
    if (opts.allowEmpty) args.push('--allow-empty');
    await git(cwd, args);
    return { commit: (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim(), committed: true };
  }

  async push(rec: WorktreeRecord, remote: string, setUpstream: boolean): Promise<void> {
    const args = ['push', ...(setUpstream ? ['-u'] : []), remote, rec.branch];
    await git(rec.path, args);
  }

  async createPr(rec: WorktreeRecord, opts: { title: string; body: string; base?: string; draft: boolean }): Promise<{ url: string }> {
    const args = ['pr', 'create', '--head', rec.branch, '--title', opts.title, '--body', opts.body || '(no description)'];
    if (opts.base) args.push('--base', opts.base);
    if (opts.draft) args.push('--draft');
    const r = await execa('gh', args, { cwd: rec.path, windowsHide: true, reject: false, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    if (r.exitCode !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    const url = (r.stdout.match(/https?:\/\/\S+/) ?? [r.stdout.trim()])[0]!;
    return { url };
  }

  async remove(rec: WorktreeRecord, opts: { force: boolean; deleteBranch: boolean; reason: string; emit?: (e: RunEvent) => void; nodeId?: string; scope?: string }): Promise<void> {
    const top = rec.repoPath;
    const wtTop = worktreeTop(rec);
    await git(top, ['worktree', 'unlock', wtTop], { reject: false });
    const r = await git(top, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), wtTop], { reject: false });
    if (r.exitCode !== 0) this.logger.warn({ stderr: r.stderr.slice(0, 300) }, 'git worktree remove failed');
    if (fs.existsSync(wtTop)) {
      try {
        fs.rmSync(wtTop, { recursive: true, force: true });
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'could not delete worktree directory');
      }
      await git(top, ['worktree', 'prune'], { reject: false });
    }
    if (opts.deleteBranch) await git(top, ['branch', '-D', rec.branch], { reject: false });
    this.db.prepare("UPDATE worktrees SET status='removed', removed_at=? WHERE id=?").run(nowIso(), rec.id);
    opts.emit?.({ type: 'worktree.removed', nodeId: opts.nodeId ?? rec.ownerNodeId, scope: opts.scope ?? '', ownerNodeId: rec.ownerNodeId, path: rec.path, reason: opts.reason });
  }

  /** Remove worktrees of finished runs older than `days`. Returns the number removed. */
  async sweep(days: number, isRunActive: (runId: string) => boolean): Promise<number> {
    const cutoff = Date.now() - days * 86_400_000;
    const rows = this.db.prepare("SELECT * FROM worktrees WHERE status IN ('active','kept')").all() as Record<string, unknown>[];
    let removed = 0;
    for (const r of rows.map(toRecord)) {
      if (isRunActive(r.runId)) continue;
      if (new Date(r.createdAt).getTime() > cutoff && fs.existsSync(r.path)) continue;
      try {
        await this.remove(r, { force: true, deleteBranch: true, reason: fs.existsSync(r.path) ? `retention sweep (${days} days)` : 'directory missing' });
        removed++;
      } catch (err) {
        this.logger.warn({ err: String(err), path: r.path }, 'sweep could not remove worktree');
      }
    }
    return removed;
  }

  keep(rec: WorktreeRecord): void {
    this.db.prepare("UPDATE worktrees SET status='kept' WHERE id=?").run(rec.id);
    void git(rec.repoPath, ['worktree', 'unlock', worktreeTop(rec)], { reject: false });
  }
}

/** The git worktree root for a record whose `path` may point at a subdirectory (monorepo target). */
function worktreeTop(rec: WorktreeRecord): string {
  const run8 = rec.runId.slice(0, 8);
  const marker = `${run8}-${rec.ownerNodeId}`;
  const idx = rec.path.indexOf(marker);
  return idx >= 0 ? rec.path.slice(0, idx + marker.length) : rec.path;
}

function excludeOrcaDir(top: string): void {
  try {
    const excl = path.join(top, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes('.orca/worktrees/')) fs.appendFileSync(excl, `${cur.endsWith('\n') || !cur ? '' : '\n'}.orca/worktrees/\n`);
  } catch {
    /* worktrees still work without the exclude */
  }
}

function toRecord(r: Record<string, unknown>): WorktreeRecord {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    ownerNodeId: r.owner_node_id as string,
    repoPath: r.repo_path as string,
    path: r.path as string,
    branch: r.branch as string,
    baseRef: r.base_ref as string,
    status: r.status as WorktreeRecord['status'],
    createdAt: r.created_at as string,
    removedAt: (r.removed_at as string | null) ?? undefined,
  };
}
