/*
 * Nothing here decides what an event means — `src/translate.ts` does that
 * server-side. This file draws nodes as they arrive and updates a tool call in
 * place when its result lands, rather than rebuilding the page on every event
 * (a run emits a few hundred, and that would fight the user's scroll).
 */

import { renderMarkdown } from './md.js';
import { renderWorkflow } from './workflow.js';

const AUTO_COLLAPSE_AFTER = 8; // subagent children before we fold them away

const $ = (id) => document.getElementById(id);

const ui = {
  cwd: $('cwd'),
  noise: $('noise'),
  clear: $('clear'),
  conn: $('conn'),
  outline: $('outline'),
  outlineEmpty: $('outline-empty'),
  trajectory: $('trajectory'),
  emptyState: $('empty-state'),
  workflow: $('workflow'),
  tabOutline: $('tab-outline'),
  tabFlow: $('tab-flow'),
  outlinePanel: $('outline-panel'),
  flowPanel: $('flow-panel'),
  prompt: $('prompt'),
  run: $('run'),
  stop: $('stop'),
  resumeNote: $('resume-note'),
  fixtures: $('fixtures'),
};

const token = new URLSearchParams(location.search).get('token');
const withToken = (url) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url);

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ---------------------------------------------------------- window chrome */

const THEME_KEY = 'agent-view-theme';
const themeButtons = [...document.querySelectorAll('[data-theme-choice]')];
let themeChoice = 'auto';

function applyTheme(choice) {
  themeChoice = choice;
  if (choice === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  for (const button of themeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === choice));
  }
}

try { themeChoice = localStorage.getItem(THEME_KEY) ?? 'auto'; } catch {}
applyTheme(themeChoice);

for (const button of themeButtons) {
  button.addEventListener('click', () => {
    applyTheme(button.dataset.themeChoice);
    try { localStorage.setItem(THEME_KEY, themeChoice); } catch {}
  });
}

// The translucent bars float over the scroll areas, so their measured heights
// set the content insets when the toolbar wraps or the dev panel opens.
const topbar = document.querySelector('.topbar');
const composerBar = document.querySelector('.composer');
const syncChrome = () => {
  const style = document.documentElement.style;
  style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
  style.setProperty('--composer-h', `${composerBar.offsetHeight}px`);
};
new ResizeObserver(syncChrome).observe(topbar);
new ResizeObserver(syncChrome).observe(composerBar);
syncChrome();

/** runId -> run view model. */
const runs = new Map();
const order = [];
let activeRunId = null;
let followOutput = true;
let outlineDirty = false;
/** True between POSTing a turn and the run showing up over the socket. */
let starting = false;
let workflowDirty = false;
/** Active side panel: 'outline' | 'flow'. */
let sidePanel = 'outline';

function makeRun(snapshot) {
  return {
    id: snapshot.runId,
    prompt: snapshot.prompt,
    cwd: snapshot.cwd,
    argv: snapshot.argv ?? [],
    resumedFrom: snapshot.resumedFrom ?? null,
    replayed: snapshot.replayed ?? null,
    nodes: new Map(),
    nodeOrder: [],
    meta: { sessionId: null, model: null, cwd: null },
    status: 'running',
    stats: null,
    error: null,
    thinkingTokens: 0,
    hookEvents: 0,
    subs: new Map(),
    els: null,
  };
}

function lastRun() {
  return order.length ? runs.get(order[order.length - 1]) : null;
}

function anyRunning() {
  return [...runs.values()].some((r) => r.status === 'running');
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(withToken(`${proto}//${location.host}/ws`));

  ws.addEventListener('open', () => { ui.conn.dataset.state = 'open'; ui.conn.textContent = 'Connected'; });
  ws.addEventListener('close', () => {
    ui.conn.dataset.state = 'closed';
    ui.conn.textContent = 'Reconnecting…';
    setTimeout(connect, 1500);
  });
  ws.addEventListener('error', () => ws.close());

  ws.addEventListener('message', (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    handle(payload);
  });
}

function handle(payload) {
  switch (payload.kind) {
    case 'snapshot':
      // A page that loaded (or reloaded) mid-run rebuilds from server state.
      for (const snapshot of payload.runs) ingestSnapshot(snapshot);
      break;
    case 'run_started':
      ingestSnapshot(payload.run);
      break;
    case 'ops':
      applyOps(runs.get(payload.runId), payload.ops);
      break;
    case 'run_end': {
      const run = runs.get(payload.runId);
      if (run) run.els?.root.classList.remove('running');
      refreshComposer();
      break;
    }
  }
}

function ingestSnapshot(snapshot) {
  let run = runs.get(snapshot.runId);
  const isNew = !run;
  if (isNew) {
    run = makeRun(snapshot);
    runs.set(run.id, run);
    order.push(run.id);
  }

  run.prompt = snapshot.prompt;
  run.cwd = snapshot.cwd;
  run.argv = snapshot.argv ?? run.argv;
  run.resumedFrom = snapshot.resumedFrom ?? null;
  run.replayed = snapshot.replayed ?? null;

  const state = snapshot.state ?? {};
  run.state = state; // the full node list, used when rebuilding the DOM
  run.meta.sessionId = state.sessionId ?? null;
  run.meta.model = state.model ?? null;
  run.status = state.status ?? 'running';
  run.stats = state.stats ?? null;
  run.error = state.error ?? null;
  run.thinkingTokens = state.thinkingTokens ?? 0;
  run.hookEvents = state.hookEvents ?? 0;

  if (isNew) mountTurn(run);
  renderAll(run);
  refreshComposer();
}

/** Rebuild one turn's DOM from its full node list (used on attach/reload). */
function renderAll(run) {
  run.nodes.clear();
  run.nodeOrder = [];
  run.subs.clear();
  run.els.body.replaceChildren();
  run.bulk = true;
  for (const node of run.state?.nodes ?? []) {
    run.nodes.set(node.id, node);
    run.nodeOrder.push(node.id);
    placeNode(run, node);
  }
  run.bulk = false;
  updateFoot(run);
  markOutlineDirty();
}

function applyOps(run, ops) {
  if (!run || !ops) return;
  for (const op of ops) {
    switch (op.op) {
      case 'node': {
        const existing = run.nodes.get(op.node.id);
        run.nodes.set(op.node.id, op.node);
        if (existing) updateNode(run, op.node);
        else { run.nodeOrder.push(op.node.id); placeNode(run, op.node); }
        markWorkflowDirty();
        break;
      }
      case 'tool_result': {
        const node = run.nodes.get(op.id);
        if (!node) break;
        node.status = op.status;
        node.result = op.result;
        updateNode(run, node);
        markWorkflowDirty();
        break;
      }
      case 'thinking':
        run.thinkingTokens = op.total;
        run.hookEvents = op.hookEvents;
        updateFoot(run);
        break;
      case 'meta':
        run.meta = { sessionId: op.sessionId, model: op.model, cwd: op.cwd };
        updateFoot(run);
        refreshComposer();
        break;
      case 'run':
        run.status = op.status;
        run.stats = op.stats;
        run.error = op.error;
        updateFoot(run);
        markOutlineDirty();
        markWorkflowDirty();
        break;
    }
  }
  if (followOutput) scrollToBottom();
}

function mountTurn(run) {
  if (ui.emptyState) ui.emptyState.hidden = true;

  const root = document.createElement('article');
  root.className = 'turn running';
  root.dataset.runId = run.id;

  const head = document.createElement('div');
  head.className = 'turn-head';

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = 'You';

  const prompt = document.createElement('span');
  prompt.className = 'prompt';
  prompt.textContent = run.prompt || '(no prompt)';

  head.append(who, prompt);

  if (run.replayed) {
    const badge = document.createElement('span');
    badge.className = 'badge replay';
    badge.textContent = `replay: ${run.replayed}`;
    head.append(badge);
  } else if (run.resumedFrom) {
    const badge = document.createElement('span');
    badge.className = 'badge resume';
    badge.textContent = `resumed session ${short(run.resumedFrom)}`;
    head.append(badge);
  }

  const body = document.createElement('div');
  body.className = 'turn-body';

  const errorBanner = document.createElement('div');
  errorBanner.className = 'error-banner';
  errorBanner.hidden = true;

  const foot = document.createElement('div');
  foot.className = 'turn-foot';

  root.append(head, body, errorBanner, foot);
  ui.trajectory.append(root);

  run.els = { root, head, prompt, body, foot, errorBanner };
  activeRunId = run.id;
  scrollToBottom(true);
}

function updateFoot(run) {
  const { foot, errorBanner, root } = run.els;
  foot.replaceChildren();

  const pill = document.createElement('span');
  pill.className = `pill ${run.status}`;
  pill.textContent = run.status === 'running' ? 'Running' : run.status === 'finished' ? 'Finished' : 'Failed';
  foot.append(pill);

  if (run.stats) {
    const stat = document.createElement('span');
    stat.className = 'stat';
    const parts = [];
    if (run.stats.costUsd !== null) parts.push(`$${run.stats.costUsd.toFixed(4)}`);
    if (run.stats.durationMs !== null) parts.push(`${(run.stats.durationMs / 1000).toFixed(1)} s`);
    if (run.stats.numTurns !== null) parts.push(`${run.stats.numTurns} turns`);
    stat.textContent = parts.join(' · ');
    foot.append(stat);
  }

  if (run.meta.sessionId) {
    const session = document.createElement('span');
    session.className = 'session';
    session.textContent = `session_id ${short(run.meta.sessionId)}`;
    session.title = run.meta.sessionId;
    foot.append(session);
  }

  if (run.argv.length) {
    const argv = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'what runs';
    const pre = document.createElement('div');
    pre.className = 'argv';
    pre.textContent = run.argv.join(' ');
    argv.append(summary, pre);
    foot.append(argv);
  }

  if (ui.noise.checked && (run.thinkingTokens > 0 || run.hookEvents > 0 || run.meta.model)) {
    const chatter = document.createElement('span');
    chatter.className = 'chatter';
    const parts = [];
    if (run.meta.model) parts.push(run.meta.model);
    if (run.thinkingTokens > 0) parts.push(`${run.thinkingTokens.toLocaleString()} thinking tokens`);
    if (run.hookEvents > 0) parts.push(`${run.hookEvents} hook events`);
    chatter.textContent = `⋯ ${parts.join(' · ')}`;
    chatter.title = 'Counting-only events, folded rather than listed one per line';
    foot.append(chatter);
  }

  if (run.error) {
    errorBanner.textContent = run.error;
    errorBanner.hidden = false;
  } else {
    errorBanner.hidden = true;
  }
  root.classList.toggle('running', run.status === 'running');
}

function containerFor(run, node) {
  if (node.parentToolUseId) {
    return run.subs.get(node.parentToolUseId) ?? createSubContainer(run, node.parentToolUseId);
  }
  return null;
}

function placeNode(run, node) {
  const el = renderNode(run, node);
  node.__el = el;
  // Only nodes that arrive while watching animate in; a rebuild on reload
  // should settle the page instantly.
  if (!run.bulk) el.classList.add('is-new');
  const sub = containerFor(run, node);
  if (sub) {
    sub.body.append(el);
    sub.count++;
    sub.refresh();
  } else {
    run.els.body.append(el);
  }
  markOutlineDirty();
}

function updateNode(run, node) {
  const prev = node.__el;
  const el = renderNode(run, node);
  node.__el = el;
  if (prev) prev.replaceWith(el);
  else {
    const sub = containerFor(run, node);
    (sub ? sub.body : run.els.body).append(el);
  }
  markOutlineDirty();
}

function renderNode(run, node) {
  switch (node.kind) {
    case 'text': {
      const div = document.createElement('div');
      div.className = 'node msg';
      div.innerHTML = renderMarkdown(node.text);
      return div;
    }
    case 'thinking': {
      const details = document.createElement('details');
      details.className = 'thinking';
      const summary = document.createElement('summary');
      summary.textContent = 'thinking';
      const body = document.createElement('div');
      body.className = 'thinking-body';
      body.textContent = node.text;
      details.append(summary, body);
      return details;
    }
    case 'notice': {
      const div = document.createElement('div');
      div.className = `node notice ${node.level === 'warn' ? 'warn' : ''}`;
      div.textContent = node.text;
      return div;
    }
    case 'tool':
      return toolElement(run, node);
    default:
      return document.createElement('div');
  }
}

const STATUS_GLYPH = { pending: '⏺', ok: '✓', error: '✕' };

function toolElement(run, node) {
  const wrap = document.createElement('div');
  wrap.className = 'node tool';
  wrap.dataset.status = node.status;
  wrap.dataset.nodeId = node.id;

  const head = document.createElement('div');
  head.className = 'tool-head';

  const status = document.createElement('span');
  status.className = 'tool-status';
  status.textContent = STATUS_GLYPH[node.status] ?? '·';
  status.title = node.status;

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = node.name;

  const summary = document.createElement('span');
  summary.className = 'tool-summary';
  summary.textContent = node.label ?? '';

  head.append(status, name, summary);
  wrap.append(head);

  if (node.result) {
    wrap.append(resultElement(node));
  }

  // Where this call's subagent events will be nested (feature 7).
  const slot = document.createElement('div');
  slot.className = 'sub-slot';
  wrap.append(slot);

  if (run.subs.has(node.id)) {
    const sub = run.subs.get(node.id);
    slot.append(sub.details);
    sub.wrap = wrap;
  }
  return wrap;
}

function resultElement(node) {
  const result = node.result;
  const wrap = document.createElement('div');
  wrap.className = 'tool-result';

  const pre = document.createElement('pre');
  const fold = document.createElement('button');
  fold.className = 'fold';
  fold.type = 'button';

  let expanded = false;
  const draw = () => {
    const body = expanded ? result.text : result.preview;
    pre.textContent = body || '(no output)';
    if (!result.truncated) { fold.hidden = true; return; }
    fold.hidden = false;
    const hidden = result.totalLines - result.previewLines;
    fold.textContent = expanded
      ? 'Show less'
      : `Show ${hidden} more line${hidden === 1 ? '' : 's'}${result.capped ? ' · result capped for transport' : ''}`;
  };
  fold.addEventListener('click', () => { expanded = !expanded; draw(); });
  draw();

  wrap.append(pre, fold);
  return wrap;
}

/** Create the container that holds a subagent's events, under its Task call. */
function createSubContainer(run, parentId) {
  let sub = run.subs.get(parentId);
  if (sub) return sub;

  const details = document.createElement('details');
  details.className = 'sub';
  details.open = true; // short subagent runs read better open; long ones fold below
  const summary = document.createElement('summary');
  const body = document.createElement('div');
  body.className = 'sub-body';
  details.append(summary, body);

  const label = run.nodes.get(parentId)?.name ?? 'subagent';
  sub = { details, summary, body, count: 0, wrap: null, autoFolded: false, label };
  sub.refresh = () => {
    sub.summary.textContent = `${label} · ${sub.count} event${sub.count === 1 ? '' : 's'}`;
    if (!sub.autoFolded && sub.count > AUTO_COLLAPSE_AFTER) {
      sub.autoFolded = true;
      details.open = false;
      sub.summary.textContent = `${label} · ${sub.count} events collapsed`;
    }
  };
  run.subs.set(parentId, sub);

  const parentEl = run.nodes.get(parentId)?.__el;
  if (parentEl) parentEl.querySelector('.sub-slot')?.append(details);
  else run.els.body.append(details);
  return sub;
}

function markOutlineDirty() {
  if (outlineDirty) return;
  outlineDirty = true;
  requestAnimationFrame(() => { outlineDirty = false; renderOutline(); });
}
function markWorkflowDirty() {
  if (workflowDirty) return;
  workflowDirty = true;
  requestAnimationFrame(() => { workflowDirty = false; renderWorkflowPanel(); });
}
function renderWorkflowPanel() {
  // Show the most recent run's lifecycle; the outline already surveys all runs.
  const run = lastRun();
  renderWorkflow(run, ui.workflow, true);
}

let outlineActiveRaf = 0;

/** Highlight the last call above the reading line, so the rail tracks the eye. */
function markActiveOutline() {
  outlineActiveRaf = 0;
  if (!ui.outline.children.length) return;
  const line = ui.trajectory.getBoundingClientRect().top + 200;
  let activeKey = null;
  for (const el of ui.trajectory.querySelectorAll('.tool')) {
    // Collapsed subagent children have no box; they must not claim the rail.
    if (!el.getClientRects().length) continue;
    if (el.getBoundingClientRect().top > line) break;
    const runId = el.closest('.turn')?.dataset.runId;
    if (runId && el.dataset.nodeId) activeKey = `${runId}:${el.dataset.nodeId}`;
  }
  for (const li of ui.outline.children) {
    if (li.dataset.key && li.dataset.key === activeKey) li.dataset.active = 'true';
    else delete li.dataset.active;
  }
}

function depthOf(run, node) {
  let depth = 0;
  let cur = node;
  const seen = new Set();
  while (cur.parentToolUseId && !seen.has(cur.parentToolUseId)) {
    seen.add(cur.parentToolUseId);
    const parent = run.nodes.get(cur.parentToolUseId);
    if (!parent) break;
    depth++;
    cur = parent;
  }
  return depth;
}

function renderOutline() {
  const frag = document.createDocumentFragment();
  let count = 0;

  order.forEach((runId, index) => {
    const run = runs.get(runId);
    const tools = run.nodeOrder.map((id) => run.nodes.get(id)).filter((n) => n?.kind === 'tool');
    if (!tools.length) return;

    const heading = document.createElement('li');
    heading.className = 'outline-turn';
    heading.textContent = `turn ${index + 1} · ${run.status}`;
    frag.append(heading);

    for (const node of tools) {
      const li = document.createElement('li');
      const depth = depthOf(run, node);
      if (depth > 0) li.classList.add('nested');
      li.dataset.status = node.status;
      li.dataset.nodeId = node.id;
      // Replayed fixtures reuse tool ids across runs, so scope the key to its turn.
      li.dataset.key = `${runId}:${node.id}`;

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = STATUS_GLYPH[node.status] ?? '·';
      const label = document.createElement('span');
      label.textContent = node.name;
      li.append(dot, label);

      li.addEventListener('click', () => jumpTo(node));
      frag.append(li);
      count++;
    }
  });

  ui.outline.replaceChildren(frag);
  ui.outlineEmpty.hidden = count > 0;
  if (!outlineActiveRaf) outlineActiveRaf = requestAnimationFrame(markActiveOutline);
}

function jumpTo(node) {
  const el = node.__el;
  if (!el) return;
  const parentSub = el.closest('details.sub');
  if (parentSub) parentSub.open = true;
  followOutput = false;
  el.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  el.classList.remove('is-jumped');
  void el.offsetWidth;
  el.classList.add('is-jumped');
  setTimeout(() => el.classList.remove('is-jumped'), 1200);
}

function refreshComposer() {
  // `starting` covers the gap between POSTing a turn and the run appearing on
  // the socket, so the Run button cannot be double-clicked into two runs.
  const running = anyRunning() || starting;
  ui.run.disabled = running;
  ui.stop.hidden = !running;
  ui.prompt.disabled = running;
  ui.cwd.disabled = running;

  const last = lastRun();
  // Only a run that finished has a session worth continuing. After a failure
  // the id may belong to a conversation the CLI never created, and resuming it
  // just reproduces the same error.
  const canResume = last && last.meta.sessionId && last.status === 'finished' && !running;

  if (canResume) {
    ui.resumeNote.hidden = false;
    ui.resumeNote.textContent = `Continues session ${short(last.meta.sessionId)}`;
  } else if (running) {
    ui.resumeNote.hidden = false;
    ui.resumeNote.textContent = 'A run is in progress';
  } else {
    ui.resumeNote.hidden = true;
  }

  ui.prompt.placeholder = canResume
    ? 'Follow up — the agent keeps its context from the previous turn…'
    : 'Ask the agent to do something…  (⌘/Ctrl + ⏎ to run)';
}

async function startRun(options = {}) {
  const prompt = options.prompt ?? ui.prompt.value.trim();
  if (!prompt && !options.replayFile) return;

  const body = { cwd: ui.cwd.value.trim() };
  if (options.replayFile) {
    body.replayFile = options.replayFile;
    body.prompt = prompt || `replay ${options.replayFile}`;
  } else {
    body.prompt = prompt;
    const last = lastRun();
    if (last?.meta.sessionId && last.status === 'finished') body.resumeSessionId = last.meta.sessionId;
  }

  starting = true;
  refreshComposer();
  try {
    const res = await fetch(withToken('/api/turns'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      showLocalError(detail.error ?? `request failed (${res.status})`);
      return;
    }
    if (!options.replayFile) ui.prompt.value = '';
  } catch (error) {
    showLocalError(`cannot reach the server: ${error.message}`);
  } finally {
    starting = false;
    refreshComposer();
  }
}

/** Surface a failure that never reached the agent (bad request, no server). */
function showLocalError(message) {
  const run = lastRun();
  if (!run) {
    window.alert(message);
    return;
  }
  run.status = 'failed';
  run.error = message;
  updateFoot(run);
  refreshComposer();
}

async function stopRun() {
  const running = [...runs.values()].filter((run) => run.status === 'running');
  const target = running[running.length - 1] ?? (activeRunId ? runs.get(activeRunId) : null);
  if (!target) return;
  await fetch(withToken(`/api/turns/${target.id}/stop`), { method: 'POST' });
}

let scrollRaf = 0;

/**
 * Follow new output with a short, interruptible ease rather than a hard jump:
 * each frame recomputes the target because the trajectory keeps growing.
 */
function scrollToBottom(force = false) {
  if (!force && !followOutput) return;
  if (force || reduceMotion.matches) {
    ui.trajectory.scrollTop = ui.trajectory.scrollHeight;
    return;
  }
  if (!scrollRaf) scrollRaf = requestAnimationFrame(stepScroll);
}

function stepScroll() {
  scrollRaf = 0;
  if (!followOutput) return;
  const el = ui.trajectory;
  const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
  if (distance <= 0.5) return;
  el.scrollTop += Math.max(1, distance * 0.22);
  scrollRaf = requestAnimationFrame(stepScroll);
}

let lastScrollTop = 0;
ui.trajectory.addEventListener('scroll', () => {
  const el = ui.trajectory;
  const top = el.scrollTop;
  const atBottom = el.scrollHeight - top - el.clientHeight < 60;
  // Scrolling up is a deliberate read; stop chasing the bottom. Scrolling
  // down is harmless, and our own follow animation only increases scrollTop.
  if (atBottom) followOutput = true;
  else if (top < lastScrollTop) followOutput = false;
  lastScrollTop = top;
  if (!outlineActiveRaf) outlineActiveRaf = requestAnimationFrame(markActiveOutline);
});

ui.run.addEventListener('click', () => startRun());
ui.stop.addEventListener('click', () => stopRun());
ui.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    startRun();
  }
});
ui.noise.addEventListener('change', () => { for (const run of runs.values()) updateFoot(run); });
function setSidePanel(name) {
  sidePanel = name;
  const isOutline = name === 'outline';
  ui.tabOutline.setAttribute('aria-selected', String(isOutline));
  ui.tabFlow.setAttribute('aria-selected', String(!isOutline));
  ui.outlinePanel.hidden = !isOutline;
  ui.flowPanel.hidden = isOutline;
  if (!isOutline) renderWorkflowPanel();
}
ui.tabOutline.addEventListener('click', () => setSidePanel('outline'));
ui.tabFlow.addEventListener('click', () => setSidePanel('flow'));

ui.clear.addEventListener('click', () => {
  if (anyRunning()) { window.alert('A run is still going. Stop it first.'); return; }
  runs.clear();
  order.length = 0;
  activeRunId = null;
  ui.trajectory.replaceChildren(ui.emptyState);
  ui.emptyState.hidden = false;
  renderOutline();
  refreshComposer();
});

function short(id) {
  return id ? `${id.slice(0, 8)}…` : '';
}

async function boot() {
  connect();
  refreshComposer();
  setSidePanel('outline');

  // ?replay=<fixture> renders a recorded stream on load, which is how the page
  // is checked from a script (and handy for a demo).
  const params = new URLSearchParams(location.search);
  const replay = params.get('replay');
  if (replay) void startRun({ replayFile: replay, prompt: params.get('prompt') ?? '' });

  try {
    const config = await (await fetch(withToken('/api/config'))).json();
    ui.cwd.value = config.defaultCwd ?? '';
    for (const name of config.fixtures ?? []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.addEventListener('click', () => startRun({ replayFile: name, prompt: ui.prompt.value.trim() }));
      ui.fixtures.append(button);
    }
    if (!config.fixtures?.length) ui.fixtures.textContent = '(no fixtures recorded yet)';
  } catch {
    /* the banner already says the socket is down */
  }
}

boot();
