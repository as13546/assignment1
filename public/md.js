/*
 * Hand-written Markdown: the agent's output is untrusted, so everything is
 * escaped before a tag is emitted, and anything unrecognised falls through as
 * an escaped paragraph. Headings, fenced and indented code, blockquotes, lists
 * (one level of nesting), rules, tables, paragraphs, and inline code / bold /
 * italic / strikethrough / links.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for HTML. Always the first thing that happens to user input. */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

const INLINE_CODE_OPEN = '\u0000C';
const INLINE_CODE_CLOSE = '\u0001';

/**
 * Only let through hrefs that cannot execute. The agent writes this markdown,
 * so `[click](javascript:...)` is a link we must not build.
 */
function safeHref(href) {
  const raw = href.trim();
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !/^(https?|mailto)$/i.test(scheme[1])) return null;
  return raw;
}

/** Apply inline markup to already-escaped text. */
function inline(escaped) {
  const codes = [];
  let out = escaped;

  // Code spans first, parked behind placeholders so nothing else touches them.
  out = out.replace(/(`+)([\s\S]*?)\1/g, (_m, _t, code) => {
    codes.push(code.replace(/^ | $/g, ''));
    return `${INLINE_CODE_OPEN}${codes.length - 1}${INLINE_CODE_CLOSE}`;
  });

  // Links: [label](href) and autolinked <https://...> (already escaped to &lt;).
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label, href) => {
    const safe = safeHref(href);
    // An unsafe target degrades to plain text; the label is already escaped.
    if (safe === null) return `${label} (${href})`;
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g, (_m, href) => {
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
  });

  // Bold before italic so ** is not eaten by *.
  out = out.replace(/\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^\s_](?:[^_]*[^\s_])?)__/g, '<strong>$1</strong>');
  // Italic; the boundary guards keep snake_case_identifiers intact.
  out = out.replace(/(^|[\s(])_([^\s_](?:[^_]*[^\s_])?)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])\*([^\s*](?:[^*]*[^\s*])?)\*(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
  out = out.replace(/~~([^\s~](?:[^~]*[^\s~])?)~~/g, '<del>$1</del>');

  // Restore code spans, escaped, as <code>.
  out = out.replace(new RegExp(`${INLINE_CODE_OPEN}(\\d+)${INLINE_CODE_CLOSE}`, 'g'), (_m, i) => {
    return `<code>${codes[Number(i)]}</code>`;
  });
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(```|~~~)\s*([\w+#.-]*)\s*$/;
const ULIST = /^(\s*)([-*+])\s+(.*)$/;
const OLIST = /^(\s*)(\d+)[.)]\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/** Render a Markdown string to an HTML string. All input is escaped first. */
export function renderMarkdown(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Fenced code block.
    const fence = line.match(FENCE);
    if (fence) {
      const closer = fence[1];
      const lang = fence[2] || '';
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(closer)) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence (or run off the end)
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      html.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Indented code block (4 spaces), but only when the previous line was blank.
    if (/^ {4}\S/.test(line) && (html.length === 0 || lines[i - 1]?.trim() === '')) {
      const body = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim())) {
        if (!lines[i].trim() && !/^ {4}/.test(lines[i + 1] ?? '')) break;
        body.push(lines[i].replace(/^ {4}/, ''));
        i++;
      }
      html.push(`<pre><code>${escapeHtml(body.join('\n').replace(/\n+$/, ''))}</code></pre>`);
      continue;
    }

    if (RULE.test(line)) { html.push('<hr>'); i++; continue; }

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(escapeHtml(heading[2].replace(/\s+#+\s*$/, '')))}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote.
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() && body.length))) {
        const m = lines[i].match(QUOTE);
        if (!m) break;
        body.push(m[1]);
        i++;
      }
      html.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    // Table: a header row followed by a divider row.
    if (TABLE_ROW.test(line) && TABLE_DIVIDER.test(lines[i + 1] ?? '')) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      const th = head.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('');
      const tb = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`)
        .join('');
      html.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    // Lists (unordered or ordered), with one level of nesting by indentation.
    if (ULIST.test(line) || OLIST.test(line)) {
      const ordered = OLIST.test(line) && !ULIST.test(line);
      const items = [];
      let current = null;
      while (i < lines.length) {
        const raw = lines[i];
        const m = raw.match(ULIST) || raw.match(OLIST);
        if (m) {
          const indent = m[1].length;
          const content = m[3];
          if (indent >= 2 && current) {
            // Nested item: keep it inside the current <li> as a sub-list.
            current.sub = current.sub ?? [];
            current.sub.push(content);
          } else {
            current = { text: content, sub: [] };
            items.push(current);
          }
          i++;
          continue;
        }
        // A plain continuation line belongs to the item above it.
        if (raw.trim() && current && /^\s{2,}/.test(raw)) {
          current.text += ' ' + raw.trim();
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const body = items
        .map((item) => {
          const sub = item.sub.length
            ? `<${tag}>${item.sub.map((s) => `<li>${inline(escapeHtml(s))}</li>`).join('')}</${tag}>`
            : '';
          return `<li>${inline(escapeHtml(item.text))}${sub}</li>`;
        })
        .join('');
      html.push(`<${tag}>${body}</${tag}>`);
      continue;
    }

    // Paragraph: gather until a blank line or the start of another block.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !ULIST.test(lines[i]) &&
      !OLIST.test(lines[i]) &&
      !TABLE_ROW.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) html.push(`<p>${inline(escapeHtml(para.join('\n'))).replace(/\n/g, '<br>')}</p>`);
  }

  return html.join('\n');
}
