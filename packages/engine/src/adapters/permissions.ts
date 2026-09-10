/**
 * Orca permission rules, adapter-agnostic.
 *   Read | Write | Shell | Shell(<glob>) | Mcp(<server>/<tool-glob>) | Url(<glob>)
 * Globs: `*` matches any run of characters; matching is case-insensitive and anchored.
 */
export type PermissionKind = 'read' | 'write' | 'shell' | 'mcp' | 'url' | 'other';

export interface PermissionQuery {
  kind: PermissionKind;
  /** Full command text for shell, file path for read/write, `server/tool` for mcp, url for url. */
  subject?: string;
  /** For shell requests: whether every parsed command is read-only according to the runtime. */
  readOnly?: boolean;
}

export interface ParsedRule {
  kind: PermissionKind;
  pattern?: RegExp;
  raw: string;
}

const RULE_RE = /^(Read|Write|Shell|Mcp|Url)(?:\((.*)\))?$/;

export function parseRule(raw: string): ParsedRule | undefined {
  const m = RULE_RE.exec(raw.trim());
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase() as PermissionKind;
  const glob = m[2];
  return { kind, raw, pattern: glob !== undefined ? globToRegex(glob) : undefined };
}

export function parseRules(raws: string[]): ParsedRule[] {
  return raws.map(parseRule).filter((r): r is ParsedRule => !!r);
}

export function globToRegex(glob: string): RegExp {
  const escaped = glob
    .trim()
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'is');
}

export function ruleMatches(rule: ParsedRule, q: PermissionQuery): boolean {
  if (rule.kind !== q.kind) return false;
  if (!rule.pattern) return true;
  if (q.subject === undefined) return false;
  return rule.pattern.test(q.subject.trim());
}

export function anyRuleMatches(rules: ParsedRule[], q: PermissionQuery): boolean {
  return rules.some((r) => ruleMatches(r, q));
}

/** Engine-wide hard denies. Applied before any allow rule, regardless of permission mode. */
const HARD_DENY_SHELL: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|~|\$HOME|[a-z]:\\?)(\s|$)/i, // rm -rf / or ~ or C:\
  /\bRemove-Item\b.*-Recurse.*\s(\/|[a-z]:\\|\$env:USERPROFILE|~)(\s|$)/i,
  /\brd\s+\/s\s+\/q\s+[a-z]:\\?(\s|$)/i,
  /\bdel\s+\/[sf]/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs(\.\w+)?\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/, // fork bomb
  /\bgit\s+push\b.*(--force|-f)\b.*\b(main|master)\b/i,
  /\bgit\s+push\b.*\b(main|master)\b.*(--force|-f)\b/i,
  /\bshutdown\b|\breboot\b|\bStop-Computer\b|\bRestart-Computer\b/i,
];

export function hardDenyReason(q: PermissionQuery): string | undefined {
  if (q.kind === 'shell' && q.subject) {
    for (const re of HARD_DENY_SHELL) if (re.test(q.subject)) return `blocked by Orca policy: destructive command pattern ${re.source.slice(0, 40)}`;
  }
  return undefined;
}

export interface PolicyDecision {
  decision: 'allow' | 'deny' | 'ask';
  reason: string;
}

export function evaluatePolicy(q: PermissionQuery, allowRules: ParsedRule[], denyRules: ParsedRule[], opts: { autoAllowReadOnly: boolean; onUnresolved: 'ask' | 'deny' }): PolicyDecision {
  const hard = hardDenyReason(q);
  if (hard) return { decision: 'deny', reason: hard };
  const deny = denyRules.find((r) => ruleMatches(r, q));
  if (deny) return { decision: 'deny', reason: `denied by rule ${deny.raw}` };
  if (opts.autoAllowReadOnly && (q.kind === 'read' || (q.kind === 'shell' && q.readOnly === true))) return { decision: 'allow', reason: 'read-only' };
  const allow = allowRules.find((r) => ruleMatches(r, q));
  if (allow) return { decision: 'allow', reason: `allowed by rule ${allow.raw}` };
  return opts.onUnresolved === 'deny' ? { decision: 'deny', reason: 'no matching allow rule (policy: deny unresolved)' } : { decision: 'ask', reason: 'no matching allow rule' };
}

/** A rule that would allow this query in future within the run ("remember for this run"). */
export function rememberRuleFor(q: PermissionQuery): string | undefined {
  switch (q.kind) {
    case 'read':
      return 'Read';
    case 'write':
      return 'Write';
    case 'shell': {
      const first = (q.subject ?? '').trim().split(/\s+/)[0];
      return first ? `Shell(${first}*)` : 'Shell';
    }
    case 'mcp':
      return q.subject ? `Mcp(${q.subject})` : undefined;
    case 'url':
      return q.subject ? `Url(${q.subject})` : undefined;
    default:
      return undefined;
  }
}
