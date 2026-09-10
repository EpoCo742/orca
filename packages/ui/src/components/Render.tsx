/** Small renderers for gate items and diffs. Deliberately dependency-free. */

export function DiffView({ patch }: { patch: string }) {
  if (!patch.trim()) return <div className="note">No changes.</div>;
  const lines = patch.split(/\r?\n/);
  return (
    <pre className="diff mono small">
      {lines.map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') ? 'diff-file' : l.startsWith('@@') ? 'diff-hunk' : l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : l.startsWith('diff --git') ? 'diff-file' : '';
        return (
          <div key={i} className={cls}>
            {l || ' '}
          </div>
        );
      })}
    </pre>
  );
}

/** Minimal markdown: headings, bullet lists, numbered lists, fenced code, inline code, bold. */
export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) buf.push(lines[i++]!);
      i++;
      blocks.push(
        <pre key={key++} className="mono small">
          {buf.join('\n')}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const Tag = (`h${Math.min(level + 2, 6)}` as unknown) as 'h3';
      blocks.push(<Tag key={key++}>{inline(h[2]!)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const L = ordered ? 'ol' : 'ul';
      blocks.push(<L key={key++}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</L>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={key++}>{inline(para.join(' '))}</p>);
  }
  return <div className="md">{blocks}</div>;
}

function inline(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0]!;
    if (t.startsWith('`')) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else out.push(<b key={k++}>{t.slice(2, -2)}</b>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function ValueView({ value, render }: { value: unknown; render: 'text' | 'markdown' | 'json' | 'diff' }) {
  if (render === 'diff') return <DiffView patch={typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)} />;
  if (render === 'json') return <pre className="mono small">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (render === 'markdown') return <Markdown text={text ?? ''} />;
  return <pre className="small" style={{ fontFamily: 'inherit' }}>{text}</pre>;
}
