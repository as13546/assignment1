/**
 * A headless end-to-end check of the server's data path.
 *
 * Connects the real WebSocket, starts a replay turn over the real HTTP API,
 * and reports what the page would have received. Useful for checking a change
 * to translate.ts without clicking through the UI.
 *
 *   bun run scripts/smoke-replay.mjs [fixture.jsonl] [--live "prompt"]
 */

const base = process.env.BASE ?? 'http://127.0.0.1:5177';
const args = process.argv.slice(2);
const liveIndex = args.indexOf('--live');
const livePrompt = liveIndex >= 0 ? args[liveIndex + 1] : null;
const fixture = args.find((a) => !a.startsWith('--') && a !== livePrompt) ?? 'basic.jsonl';

const runs = new Map();
const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let markDone;
const finished = new Promise((resolve) => { markDone = resolve; });

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.kind === 'snapshot') return;

  if (message.kind === 'run_started') {
    runs.set(message.run.runId, {
      argv: message.run.argv, ops: 0, kinds: new Map(), tools: new Map(),
      meta: null, run: null, t0: Date.now(), firstOp: null, lastOp: null,
    });
    return;
  }

  if (message.kind === 'ops') {
    const record = runs.get(message.runId);
    if (!record) return;
    record.ops += message.ops.length;
    record.lastOp = Date.now();
    record.firstOp ??= Date.now();
    for (const op of message.ops) {
      record.kinds.set(op.op, (record.kinds.get(op.op) ?? 0) + 1);
      if (op.op === 'node' && op.node.kind === 'tool') {
        record.tools.set(op.node.id, { name: op.node.name, status: op.node.status, parent: op.node.parentToolUseId });
      }
      if (op.op === 'node' && op.node.kind !== 'tool') {
        const key = `node:${op.node.kind}`;
        record.kinds.set(key, (record.kinds.get(key) ?? 0) + 1);
      }
      if (op.op === 'tool_result') {
        const tool = record.tools.get(op.id);
        if (tool) Object.assign(tool, {
          status: op.status, totalLines: op.result.totalLines,
          previewLines: op.result.previewLines, truncated: op.result.truncated,
        });
      }
      if (op.op === 'meta') record.meta = op;
      if (op.op === 'run') record.run = op;
    }
    return;
  }

  if (message.kind === 'run_end') markDone();
});

const body = livePrompt
  ? { prompt: livePrompt, cwd: process.env.CWD ?? process.cwd() }
  : { prompt: `replay ${fixture}`, replayFile: fixture, replayDelayMs: 1 };

const response = await fetch(`${base}/api/turns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
console.log(`POST /api/turns → ${response.status} ${await response.text()}`);

await finished;

for (const record of runs.values()) {
  console.log(`\nargv            : ${record.argv.join(' ')}`);
  console.log(`ops             : ${record.ops}  (first after ${record.firstOp - record.t0} ms, span ${record.lastOp - record.t0} ms)`);
  console.log(`op kinds        : ${JSON.stringify(Object.fromEntries(record.kinds))}`);
  console.log(`meta            : ${JSON.stringify(record.meta)}`);
  console.log(`run             : ${JSON.stringify(record.run)}`);
  console.log('tools:');
  for (const [id, tool] of record.tools) {
    console.log(`  ${id.padEnd(34)} ${JSON.stringify(tool)}`);
  }
}

ws.close();
process.exit(0);
