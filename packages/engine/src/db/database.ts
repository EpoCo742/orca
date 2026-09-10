import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Database = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  repo_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_hash TEXT NOT NULL,
  workflow_snapshot TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  status TEXT NOT NULL,
  inputs TEXT NOT NULL,
  trigger TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  cost_premium_requests REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS runs_workflow ON runs(workflow_id, created_at DESC);
CREATE TABLE IF NOT EXISTS run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  node_id TEXT,
  scope TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, seq);
CREATE TABLE IF NOT EXISTS transcripts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transcripts_node ON transcripts(run_id, node_id, scope, seq);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status, created_at);
`;

export function openDatabase(dbPath: string): Database {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', '1');
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
