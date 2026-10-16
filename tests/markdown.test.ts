import { describe, expect, test } from 'bun:test';
import { escapeHtml, renderMarkdown } from '../public/md.js';

describe('escaping', () => {
  test('html in the agent output is escaped, never executed', () => {
    expect(renderMarkdown('<script>alert(1)</script>'))
      .toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  test('attribute-breaking quotes are escaped', () => {
    expect(escapeHtml('a"b\'c')).toBe('a&quot;b&#39;c');
  });

  test('html inside a code fence stays escaped', () => {
    expect(renderMarkdown('```html\n<b>hi</b>\n```'))
      .toBe('<pre><code class="language-html">&lt;b&gt;hi&lt;/b&gt;</code></pre>');
  });
});

describe('block elements', () => {
  test('headings', () => {
    expect(renderMarkdown('## What I built')).toBe('<h2>What I built</h2>');
    expect(renderMarkdown('###### tiny')).toBe('<h6>tiny</h6>');
  });

  test('paragraphs separated by blank lines', () => {
    expect(renderMarkdown('one\n\ntwo')).toBe('<p>one</p>\n<p>two</p>');
  });

  test('fenced code keeps its body verbatim', () => {
    expect(renderMarkdown('```python\nx = 1\n\nprint(x)\n```'))
      .toBe('<pre><code class="language-python">x = 1\n\nprint(x)</code></pre>');
  });

  test('unordered and ordered lists', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  test('an indented list item nests one level', () => {
    expect(renderMarkdown('- a\n  - a1\n- b'))
      .toBe('<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>');
  });

  test('blockquote', () => {
    expect(renderMarkdown('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
  });

  test('horizontal rule', () => {
    expect(renderMarkdown('---')).toBe('<hr>');
  });

  test('table', () => {
    const md = '| Tool | Status |\n| --- | --- |\n| Bash | ok |';
    expect(renderMarkdown(md)).toBe(
      '<table><thead><tr><th>Tool</th><th>Status</th></tr></thead>'
      + '<tbody><tr><td>Bash</td><td>ok</td></tr></tbody></table>',
    );
  });
});

describe('inline elements', () => {
  test('bold and italic', () => {
    expect(renderMarkdown('**bold** and *italic*')).toBe('<p><strong>bold</strong> and <em>italic</em></p>');
    expect(renderMarkdown('__bold__ and _italic_')).toBe('<p><strong>bold</strong> and <em>italic</em></p>');
  });

  test('strikethrough', () => {
    expect(renderMarkdown('~~gone~~')).toBe('<p><del>gone</del></p>');
  });

  test('inline code, including markup that should stay literal', () => {
    expect(renderMarkdown('use `--json` here')).toBe('<p>use <code>--json</code> here</p>');
    expect(renderMarkdown('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  });

  test('inline code is escaped too', () => {
    expect(renderMarkdown('`<div>`')).toBe('<p><code>&lt;div&gt;</code></p>');
  });

  test('snake_case identifiers are not italicised', () => {
    expect(renderMarkdown('test_parse_fails')).toBe('<p>test_parse_fails</p>');
  });

  test('links get opened safely in a new tab', () => {
    expect(renderMarkdown('[docs](https://code.claude.com/docs)'))
      .toBe('<p><a href="https://code.claude.com/docs" target="_blank" rel="noopener noreferrer">docs</a></p>');
  });

  test('a bare url becomes a link', () => {
    expect(renderMarkdown('see <https://example.com/x>'))
      .toBe('<p>see <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a></p>');
  });

  test('javascript: links are not turned into a link at all', () => {
    expect(renderMarkdown('[click](javascript:alert(1))')).not.toContain('href="javascript:');
  });
});

describe('realistic agent output', () => {
  test('a mixed answer renders without leaking markup', () => {
    const md = [
      'The test expects a **trailing newline**. I will:',
      '',
      '1. Read `tests/test_parse.py`',
      '2. Run `pytest -x`',
      '',
      '```bash',
      'pytest -x',
      '```',
    ].join('\n');
    const html = renderMarkdown(md);
    expect(html).toContain('<strong>trailing newline</strong>');
    expect(html).toContain('<code>tests/test_parse.py</code>');
    expect(html).toContain('<pre><code class="language-bash">pytest -x</code></pre>');
    expect(html).not.toContain('**');
  });

  test('empty and nullish input do not throw', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
    expect(renderMarkdown(null)).toBe('');
  });
});
