import { describe, expect, it } from 'vitest';
import { parseTemplate, referencedNodeIds, templateExpressions } from './template.js';

describe('template parsing', () => {
  it('splits text and expressions', () => {
    const segs = parseTemplate('Tests failed:\n{{ nodes.test.stdout }} and {{nodes.test.exit_code}}');
    expect(segs.map((s) => s.kind)).toEqual(['text', 'expr', 'text', 'expr']);
    expect(templateExpressions('a {{ b }} c {{ d.e }}')).toEqual(['b', 'd.e']);
  });
  it('escapes literal braces', () => {
    expect(parseTemplate('x \\{{ y')).toEqual([{ kind: 'text', text: 'x {{ y' }]);
  });
  it('leaves unterminated expressions as text', () => {
    expect(parseTemplate('a {{ b')).toEqual([{ kind: 'text', text: 'a {{ b' }]);
  });
  it('finds referenced node ids', () => {
    expect(referencedNodeIds("nodes.test.exit_code === 0 && nodes['fix'].text.length > nodes.plan.json.n")).toEqual(['test', 'fix', 'plan']);
  });
});
