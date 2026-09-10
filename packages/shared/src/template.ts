/**
 * Template parsing shared by the engine (rendering) and the UI (autocomplete, validation).
 * Grammar: `{{ expression }}` segments; `\{{` is a literal `{{`.
 */
export type TemplateSegment = { kind: 'text'; text: string } | { kind: 'expr'; expr: string; start: number; end: number };

export function parseTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let text = '';
  let i = 0;
  while (i < template.length) {
    if (template.startsWith('\\{{', i)) {
      text += '{{';
      i += 3;
      continue;
    }
    if (template.startsWith('{{', i)) {
      const close = template.indexOf('}}', i + 2);
      if (close === -1) {
        text += template.slice(i);
        break;
      }
      if (text) segments.push({ kind: 'text', text });
      text = '';
      segments.push({ kind: 'expr', expr: template.slice(i + 2, close).trim(), start: i, end: close + 2 });
      i = close + 2;
      continue;
    }
    text += template[i];
    i++;
  }
  if (text) segments.push({ kind: 'text', text });
  return segments;
}

export function templateExpressions(template: string): string[] {
  return parseTemplate(template)
    .filter((s): s is Extract<TemplateSegment, { kind: 'expr' }> => s.kind === 'expr')
    .map((s) => s.expr);
}

/** Node ids referenced as `nodes.<id>` inside an expression. Tolerant regex scan, good enough for dependency analysis. */
export function referencedNodeIds(expr: string): string[] {
  const ids = new Set<string>();
  const re = /\bnodes\s*(?:\.\s*([a-z][a-z0-9_]*)|\[\s*['"]([a-z][a-z0-9_]*)['"]\s*\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) ids.add((m[1] ?? m[2])!);
  return [...ids];
}

/** Read a dotted path such as `system.append` from an object. */
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj);
}
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    const next = cur[k];
    if (!next || typeof next !== 'object') return;
    cur = next as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}
