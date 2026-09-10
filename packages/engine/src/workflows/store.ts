import fs from 'node:fs';
import path from 'node:path';
import { WorkflowDocument, type Diagnostic, type WorkflowDetail, type WorkflowSummary } from '@orca/shared';
import { nowIso, type Database } from '../db/database.js';
import { hashDocument } from '../run/store.js';
import { compileWorkflow } from '../compiler/compile.js';
import { resolveRepoPath } from '../run/context.js';

export interface TemplateInfo {
  id: string;
  name: string;
  description?: string;
  path: string;
  document: WorkflowDocument;
}

/** Workflow files are the source of truth; the DB row is an index (id -> path). */
export class WorkflowStore {
  constructor(
    private readonly db: Database,
    private readonly templatesDir?: string,
  ) {}

  list(): WorkflowSummary[] {
    const rows = this.db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    const out: WorkflowSummary[] = [];
    for (const r of rows) {
      const p = r.path as string;
      if (!fs.existsSync(p)) {
        this.db.prepare('DELETE FROM workflows WHERE id=?').run(r.id as string);
        continue;
      }
      out.push({ id: r.id as string, name: r.name as string, path: p, repoPath: r.repo_path as string, updatedAt: r.updated_at as string, contentHash: r.content_hash as string });
    }
    return out;
  }

  pathOf(id: string): string | undefined {
    const r = this.db.prepare('SELECT path FROM workflows WHERE id=?').get(id) as { path: string } | undefined;
    return r?.path;
  }

  get(id: string): WorkflowDetail | undefined {
    const p = this.pathOf(id);
    if (!p || !fs.existsSync(p)) return undefined;
    return this.readDetail(p);
  }

  readDocument(filePath: string): WorkflowDocument {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return WorkflowDocument.parse(raw);
  }

  private readDetail(filePath: string): WorkflowDetail {
    const document = this.readDocument(filePath);
    const diagnostics = compileWorkflow(document).diagnostics;
    const repoPath = resolveRepoPath(filePath, document);
    const stat = fs.statSync(filePath);
    return { id: document.id, name: document.name, path: filePath, repoPath, updatedAt: stat.mtime.toISOString(), contentHash: hashDocument(document), document, diagnostics };
  }

  importFile(filePath: string): WorkflowDetail {
    const abs = path.resolve(filePath);
    const detail = this.readDetail(abs);
    this.index(detail);
    return detail;
  }

  create(repoPath: string, document: WorkflowDocument): WorkflowDetail {
    const dir = path.resolve(repoPath, '.orca', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, `${slugify(document.name)}.workflow.json`);
    let n = 2;
    while (fs.existsSync(file)) file = path.join(dir, `${slugify(document.name)}-${n++}.workflow.json`);
    writeDocument(file, document);
    return this.importFile(file);
  }

  save(id: string, document: WorkflowDocument): WorkflowDetail | undefined {
    const p = this.pathOf(id);
    if (!p) return undefined;
    if (document.id !== id) throw new Error('document id does not match workflow id');
    writeDocument(p, document);
    const detail = this.readDetail(p);
    this.index(detail);
    return detail;
  }

  validate(document: WorkflowDocument): Diagnostic[] {
    return compileWorkflow(document).diagnostics;
  }

  delete(id: string, deleteFile: boolean): boolean {
    const p = this.pathOf(id);
    if (!p) return false;
    this.db.prepare('DELETE FROM workflows WHERE id=?').run(id);
    if (deleteFile && fs.existsSync(p)) fs.rmSync(p);
    return true;
  }

  private index(detail: WorkflowDetail): void {
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, path, repo_path, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path, repo_path=excluded.repo_path, content_hash=excluded.content_hash, updated_at=excluded.updated_at`,
      )
      .run(detail.id, detail.name, detail.path, detail.repoPath, detail.contentHash, nowIso());
  }

  // ---------------------------------------------------------------- templates
  templates(): TemplateInfo[] {
    if (!this.templatesDir || !fs.existsSync(this.templatesDir)) return [];
    const out: TemplateInfo[] = [];
    for (const f of fs.readdirSync(this.templatesDir)) {
      if (!f.endsWith('.workflow.json')) continue;
      const p = path.join(this.templatesDir, f);
      try {
        const document = this.readDocument(p);
        out.push({ id: f.replace(/\.workflow\.json$/, ''), name: document.name, description: document.description, path: p, document });
      } catch {
        // ignore malformed templates
      }
    }
    return out;
  }

  fromTemplate(templateId: string, repoPath: string, name?: string): WorkflowDetail {
    const t = this.templates().find((x) => x.id === templateId);
    if (!t) throw new Error(`template not found: ${templateId}`);
    const doc: WorkflowDocument = { ...structuredClone(t.document), id: crypto.randomUUID(), name: name ?? t.name };
    // Template repoPath values are relative to the templates directory; rebase onto the new file location.
    if (doc.settings.repoPath) {
      const absRepo = path.resolve(this.templatesDir!, doc.settings.repoPath);
      const newDir = path.resolve(repoPath, '.orca', 'workflows');
      doc.settings.repoPath = path.relative(newDir, absRepo) || '.';
    }
    return this.create(repoPath, doc);
  }

  /** Register a template directly (runs it in place; used for `orca dev` demos). */
  importTemplate(templateId: string): WorkflowDetail {
    const t = this.templates().find((x) => x.id === templateId);
    if (!t) throw new Error(`template not found: ${templateId}`);
    return this.importFile(t.path);
  }
}

function writeDocument(file: string, document: WorkflowDocument): void {
  fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n', 'utf8');
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'workflow'
  );
}
