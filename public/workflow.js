/*
 * Apple Design workflow diagram: a compact vertical flowchart of one run.
 * Renders the full lifecycle from prompt → agent messages → tool calls and
 * their results → final status with cost / duration / turns. Lives inside the
 * rail as a tab next to the outline.
 */

import { renderMarkdown } from './md.js';

const GLYPH = {
  start: '▶',
  text: '✦',
  thinking: '◈',
  tool: '●',
  result: '→',
  subagent: '◐',
  end: '◉',
};

const STATUS_GLYPH = { pending: '⏺', ok: '✓', error: '✕' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusClass(status) {
  return status === 'ok' ? 'ok' : status === 'error' ? 'error' : status === 'pending' ? 'pending' : 'neutral';
}

function short(text, n = 90) {
  if (!text) return '';
  return text.length > n ? `${text.slice(0, n).trim()}…` : text;
}

/**
 * Build a vertical workflow diagram into `container` for `run`.
 * `onJump(node)` is called when the user clicks a step, so the main view can
 * scroll to the matching node and expand any collapsed subagent.
 */
export function renderWorkflow(run, container, onJump) {
  container.replaceChildren();
  if (!run) {
    container.append(el('p', 'wf-empty', 'Start a run to see its workflow.'));
    return;
  }

  const root = el('div', 'wf-flow');
  container.append(root);

  // Start node: the user prompt.
  root.append(makeStep({
    kind: 'start',
    title: 'You',
    body: run.prompt || '(no prompt)',
    status: 'ok',
  }, onJump && (() => { if (run.els?.root) run.els.root.scrollIntoView({ block: 'center', behavior: 'smooth' }); })));

  // Group nodes by parent for subagent branch rendering.
  const byParent = new Map();
  byParent.set(null, []);
  for (const node of run.nodeOrder.map((id) => run.nodes.get(id)).filter(Boolean)) {
    const parentId = node.parentToolUseId ?? null;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(node);
  }

  // Render the main sequence (parentToolUseId === null).
  const main = byParent.get(null) ?? [];
  renderBranch(root, run, main, byParent, 0, onJump);

  // End node: final status and numbers.
  const end = makeStep({
    kind: 'end',
    title: run.status === 'running' ? 'Running' : run.status === 'finished' ? 'Finished' : 'Failed',
    status: run.status === 'running' ? 'pending' : run.status === 'finished' ? 'ok' : 'error',
  }, null);

  const meta = el('div', 'wf-meta');
  if (run.stats) {
    if (run.stats.costUsd !== null) meta.append(makeMetaChip(`$${run.stats.costUsd.toFixed(4)}`));
    if (run.stats.durationMs !== null) meta.append(makeMetaChip(`${(run.stats.durationMs / 1000).toFixed(1)} s`));
    if (run.stats.numTurns !== null) meta.append(makeMetaChip(`${run.stats.numTurns} turns`));
  }
  if (run.meta.sessionId) meta.append(makeMetaChip(`session ${run.meta.sessionId.slice(0, 8)}…`));
  if (meta.children.length) end.querySelector('.wf-card').append(meta);

  root.append(end);
}

function renderBranch(parentEl, run, nodes, byParent, depth, onJump) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const step = nodeToStep(run, node, onJump);
    if (step) parentEl.append(step);

    // Subagent branch: children of this tool_use id.
    const children = byParent.get(node.id);
    if (children?.length) {
      const branch = el('div', 'wf-branch');
      const head = el('div', 'wf-branch-head');
      const label = run.nodes.get(node.id)?.name ?? 'subagent';
      head.textContent = `${label} · ${children.length} event${children.length === 1 ? '' : 's'}`;
      branch.append(head);
      renderBranch(branch, run, children, byParent, depth + 1, onJump);
      parentEl.append(branch);
    }
  }
}

function nodeToStep(run, node, onJump) {
  switch (node.kind) {
    case 'text': {
      const body = short(node.text.replace(/\s+/g, ' '), 110);
      return makeStep({ kind: 'text', title: 'Assistant', body, status: 'neutral' },
        onJump && (() => jump(run, node)));
    }
    case 'thinking': {
      return makeStep({ kind: 'thinking', title: 'Thinking', body: short(node.text, 80), status: 'neutral' },
        onJump && (() => jump(run, node)));
    }
    case 'notice': {
      return makeStep({ kind: node.level === 'warn' ? 'thinking' : 'text', title: 'Notice', body: short(node.text, 100), status: node.level === 'warn' ? 'error' : 'neutral' },
        onJump && (() => jump(run, node)));
    }
    case 'tool': {
      const title = [node.name, STATUS_GLYPH[node.status] ?? '·'].filter(Boolean).join(' ');
      const body = node.label || '';
      const step = makeStep({ kind: 'tool', title, body, status: node.status },
        onJump && (() => jump(run, node)));

      if (node.result) {
        const result = makeStep({
          kind: 'result',
          title: 'Result',
          body: node.result.preview ? short(node.result.preview, 100) : '(no output)',
          status: node.status,
        }, onJump && (() => jump(run, node)));
        step.querySelector('.wf-card').append(result.querySelector('.wf-card'));
      }
      return step;
    }
    default:
      return null;
  }
}

function makeStep({ kind, title, body, status }, onClick) {
  const step = el('div', `wf-step wf-kind-${kind}`);
  const track = el('div', 'wf-track');
  const dot = el('span', `wf-dot ${statusClass(status)}`, GLYPH[kind] ?? '·');
  track.append(dot);

  const card = el('div', 'wf-card');
  const head = el('div', 'wf-title', title);
  card.append(head);
  if (body) {
    const b = el('div', 'wf-body', body);
    card.append(b);
  }

  step.append(track, card);
  if (onClick) {
    step.classList.add('wf-clickable');
    step.addEventListener('click', onClick);
  }
  return step;
}

function makeMetaChip(text) {
  return el('span', 'wf-chip', text);
}

function jump(run, node) {
  const el = node.__el;
  if (!el) return;
  const parentSub = el.closest('details.sub');
  if (parentSub) parentSub.open = true;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('is-jumped');
  void el.offsetWidth;
  el.classList.add('is-jumped');
  setTimeout(() => el.classList.remove('is-jumped'), 1200);
}
