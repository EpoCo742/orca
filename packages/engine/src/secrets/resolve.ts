import type { SecretsProvider } from './provider.js';

const SECRET_RE = /\$\{SECRET:([A-Z][A-Z0-9_]*)\}/g;

export class MissingSecretError extends Error {
  constructor(public readonly name: string) {
    super(`secret "${name}" is not set (add it under Settings > Secrets)`);
    this.name = 'MissingSecretError';
  }
}

/** Replace `${SECRET:NAME}` and `${CWD}` in a string. Throws for unknown secrets. */
export function resolveString(s: string, secrets: SecretsProvider, vars: { cwd?: string } = {}): string {
  return s
    .replace(SECRET_RE, (_m, name: string) => {
      const v = secrets.get(name);
      if (v === undefined) throw new MissingSecretError(name);
      return v;
    })
    .replace(/\$\{CWD\}/g, vars.cwd ?? process.cwd());
}

/** Deep-resolve every string in a JSON-like value. */
export function resolveDeep<T>(value: T, secrets: SecretsProvider, vars: { cwd?: string } = {}): T {
  if (typeof value === 'string') return resolveString(value, secrets, vars) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, secrets, vars)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveDeep(v, secrets, vars);
    return out as T;
  }
  return value;
}

/** Secret names referenced by a value (for validation). */
export function referencedSecrets(value: unknown, acc = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const m of value.matchAll(SECRET_RE)) acc.add(m[1]!);
  else if (Array.isArray(value)) for (const v of value) referencedSecrets(v, acc);
  else if (value && typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) referencedSecrets(v, acc);
  return acc;
}

/** Replaces known secret values in text. Values shorter than 4 characters are not redacted (too many false positives). */
export class Redactor {
  private values: string[] = [];
  constructor(private readonly secrets?: SecretsProvider) {
    this.refresh();
    secrets?.onChange(() => this.refresh());
  }
  refresh(): void {
    this.values = (this.secrets?.values() ?? []).filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
  }
  redact(text: string): string {
    let out = text;
    for (const v of this.values) if (out.includes(v)) out = out.split(v).join('***');
    return out;
  }
  redactJson<T>(value: T): T {
    if (this.values.length === 0) return value;
    const s = JSON.stringify(value);
    if (s === undefined) return value;
    const r = this.redact(s);
    return r === s ? value : (JSON.parse(r) as T);
  }
}
