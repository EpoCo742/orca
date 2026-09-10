import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Named secrets, AES-256-GCM encrypted at rest in <dataDir>/secrets.enc.json.
 * Key: ORCA_MASTER_KEY (64 hex chars) or a generated <dataDir>/master.key.
 * The desktop shell (M5) will swap this for the OS keychain behind the same interface.
 */
export interface SecretsProvider {
  list(): string[];
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): boolean;
  values(): string[];
  onChange(listener: () => void): () => void;
}

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function assertSecretName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid secret name "${name}" (use UPPER_SNAKE_CASE)`);
}

export class FileSecretsProvider implements SecretsProvider {
  private readonly file: string;
  private readonly key: Buffer;
  private cache: Record<string, string> | undefined;
  private listeners = new Set<() => void>();

  constructor(dataDir: string, masterKeyHex = process.env.ORCA_MASTER_KEY) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'secrets.enc.json');
    if (masterKeyHex) {
      if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) throw new Error('ORCA_MASTER_KEY must be 64 hex characters');
      this.key = Buffer.from(masterKeyHex, 'hex');
    } else {
      const keyFile = path.join(dataDir, 'master.key');
      if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
      this.key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    }
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    if (!fs.existsSync(this.file)) return (this.cache = {});
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(raw.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]).toString('utf8');
    return (this.cache = JSON.parse(plain) as Record<string, string>);
  }

  private save(values: Record<string, string>): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(values), 'utf8')), cipher.final()]);
    const out = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    fs.writeFileSync(this.file, JSON.stringify(out), { mode: 0o600 });
    this.cache = values;
    for (const l of this.listeners) l();
  }

  list(): string[] {
    return Object.keys(this.load()).sort();
  }
  get(name: string): string | undefined {
    return this.load()[name];
  }
  set(name: string, value: string): void {
    assertSecretName(name);
    this.save({ ...this.load(), [name]: value });
  }
  delete(name: string): boolean {
    const v = { ...this.load() };
    if (!(name in v)) return false;
    delete v[name];
    this.save(v);
    return true;
  }
  values(): string[] {
    return Object.values(this.load());
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class MemorySecretsProvider implements SecretsProvider {
  private map = new Map<string, string>();
  private listeners = new Set<() => void>();
  list() {
    return [...this.map.keys()].sort();
  }
  get(name: string) {
    return this.map.get(name);
  }
  set(name: string, value: string) {
    assertSecretName(name);
    this.map.set(name, value);
    for (const l of this.listeners) l();
  }
  delete(name: string) {
    const r = this.map.delete(name);
    for (const l of this.listeners) l();
    return r;
  }
  values() {
    return [...this.map.values()];
  }
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
