import { describe, expect, test } from 'bun:test';
import {
  applyEvent, buildTree, createRunState, failRun, finishRun,
  outline, redactSecrets, toolSummary, FOLD_MAX_LINES,
} from '../src/translate.ts';
import type { Op, RawEvent, RunState, TextNode, ToolNode } from '../src/types.ts';

const assistant = (content: unknown[], parent: string | null = null, id = 'msg_1'): RawEvent => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id, role: 'assistant', content: content as never },
});

const toolUse = (id: string, name: string, input: unknown = {}) =>
  ({ type: 'tool_use', id, name, input });

const toolResult = (id: string, content: unknown, isError = false, parent: string | null = null): RawEvent => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] as never },
});

/** Collect ops from a sequence, so tests can assert on what the browser sees. */
function opsOf(events: RawEvent[]): { state: RunState; ops: Op[] } {
  const state = createRunState();
  const ops: Op[] = [];
  for (const event of events) ops.push(...applyEvent(state, event));
  return { state, ops };
}

describe('init and noise', () => {
  test('system/init records session, cwd and model', () => {
    const { state, ops } = opsOf([{
      type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '/tmp/demo', model: 'claude-fable-5',
    }]);
    expect(state.sessionId).toBe('sess-1');
    expect(state.cwd).toBe('/tmp/demo');
    expect(state.model).toBe('claude-fable-5');
    expect(ops).toEqual([{ op: 'meta', sessionId: 'sess-1', model: 'claude-fable-5', cwd: '/tmp/demo' }]);
  });

  test('thinking_tokens are counted, never rendered as nodes', () => {
    const { state } = opsOf([
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1 },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 9 },
    ]);
    expect(state.nodes).toHaveLength(0);
    expect(state.thinkingTokens).toBe(9);
  });

  test('hook events are counted, never rendered as nodes', () => {
    const { state } = opsOf([
      { type: 'system', subtype: 'hook_started', hook_id: 'x' },
      { type: 'system', subtype: 'hook_response', output: 'a very long blob' },
    ]);
    expect(state.nodes).toHaveLength(0);
    expect(state.hookEvents).toBe(2);
  });

  test('unknown event types are ignored rather than crashing', () => {
    const { state } = opsOf([
      { type: 'stream_event', event: { anything: true } },
      { type: 'system', subtype: 'something_new' },
    ]);
    expect(state.nodes).toHaveLength(0);
    expect(state.status).toBe('running');
  });

  test('system/informational becomes a notice node', () => {
    const { state } = opsOf([{ type: 'system', subtype: 'informational', content: 'heads up' }]);
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0].kind).toBe('notice');
  });
});

describe('trajectory', () => {
  test('assistant text becomes a text node', () => {
    const { state } = opsOf([assistant([{ type: 'text', text: 'Reading the parser first.' }])]);
    expect(state.nodes).toHaveLength(1);
    expect((state.nodes[0] as TextNode).text).toBe('Reading the parser first.');
  });

  test('consecutive chunks of one message merge into a single node', () => {
    const { state } = opsOf([
      assistant([{ type: 'text', text: 'Reading ' }]),
      assistant([{ type: 'text', text: 'the parser.' }]),
    ]);
    expect(state.nodes).toHaveLength(1);
    expect((state.nodes[0] as TextNode).text).toBe('Reading the parser.');
  });

  test('a new message starts a new node', () => {
    const { state } = opsOf([
      assistant([{ type: 'text', text: 'one' }], null, 'msg_1'),
      assistant([{ type: 'text', text: 'two' }], null, 'msg_2'),
    ]);
    expect(state.nodes).toHaveLength(2);
  });

  test('tool_use becomes a pending tool node, in order with the text', () => {
    const { state } = opsOf([
      assistant([
        { type: 'text', text: 'I will read it.' },
        toolUse('tu_1', 'Read', { file_path: 'src/parser.py' }),
      ]),
    ]);
    expect(state.nodes.map((n) => n.kind)).toEqual(['text', 'tool']);
    const tool = state.nodes[1] as ToolNode;
    expect(tool.name).toBe('Read');
    expect(tool.status).toBe('pending');
    expect(tool.result).toBeNull();
  });
});

describe('feature 3 — tool results', () => {
  test('a result attaches to its call by id and marks it ok', () => {
    const { state, ops } = opsOf([
      assistant([toolUse('tu_1', 'Bash', { command: 'pytest -x' })]),
      toolResult('tu_1', 'all good'),
    ]);
    const tool = state.nodes[0] as ToolNode;
    expect(tool.status).toBe('ok');
    expect(tool.result?.text).toBe('all good');
    expect(ops.at(-1)).toMatchObject({ op: 'tool_result', id: 'tu_1', status: 'ok' });
  });

  test('is_error produces a visibly errored call', () => {
    const { state } = opsOf([
      assistant([toolUse('tu_1', 'Bash', { command: 'pytest -x' })]),
      toolResult('tu_1', 'FAILED tests/test_parse.py', true),
    ]);
    const tool = state.nodes[0] as ToolNode;
    expect(tool.status).toBe('error');
    expect(tool.result?.isError).toBe(true);
  });

  test('a long result is folded but the full text still travels', () => {
    const long = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    const { state } = opsOf([
      assistant([toolUse('tu_1', 'Bash', { command: 'pytest' })]),
      toolResult('tu_1', long),
    ]);
    const result = (state.nodes[0] as ToolNode).result!;
    expect(result.totalLines).toBe(100);
    expect(result.previewLines).toBe(FOLD_MAX_LINES);
    expect(result.truncated).toBe(true);
    expect(result.text.split('\n')).toHaveLength(100);
  });

  test('a short result is not folded', () => {
    const { state } = opsOf([
      assistant([toolUse('tu_1', 'Bash', { command: 'ls' })]),
      toolResult('tu_1', 'a\nb\nc'),
    ]);
    const result = (state.nodes[0] as ToolNode).result!;
    expect(result.truncated).toBe(false);
    expect(result.preview).toBe('a\nb\nc');
  });

  test('a result for an unknown call is ignored, not crashed on', () => {
    const { state } = opsOf([toolResult('tu_missing', 'orphan')]);
    expect(state.nodes).toHaveLength(0);
  });

  test('structured result blocks are flattened to text', () => {
    const { state } = opsOf([
      assistant([toolUse('tu_1', 'Read', { file_path: 'a.py' })]),
      toolResult('tu_1', [{ type: 'text', text: 'contents' }]),
    ]);
    expect((state.nodes[0] as ToolNode).result?.text).toBe('contents');
  });
});

describe('feature 5 — resume', () => {
  test('the session id survives into the final event and is reported', () => {
    const { state } = opsOf([
      { type: 'system', subtype: 'init', session_id: 'fe891e8a' },
      { type: 'result', subtype: 'success', session_id: 'fe891e8a', num_turns: 12 },
    ]);
    expect(state.sessionId).toBe('fe891e8a');
  });
});

describe('feature 6 — the run numbers', () => {
  test('cost, duration and turns come from the result event', () => {
    const { state, ops } = opsOf([{
      type: 'result', subtype: 'success',
      total_cost_usd: 0.58, duration_ms: 42000, num_turns: 12, session_id: 's',
    }]);
    expect(state.stats).toEqual({ costUsd: 0.58, durationMs: 42000, numTurns: 12, isError: false });
    expect(state.status).toBe('finished');
    expect(ops.at(-1)).toMatchObject({ op: 'run', status: 'finished' });
  });

  test('falls back to duration_api_ms when duration_ms is absent', () => {
    const { state } = opsOf([{ type: 'result', subtype: 'success', duration_api_ms: 5352 }]);
    expect(state.stats?.durationMs).toBe(5352);
  });

  test('an errored result marks the run failed and carries a message', () => {
    const { state } = opsOf([{
      type: 'result', subtype: 'error', is_error: true, result: 'boom', num_turns: 1,
    }]);
    expect(state.status).toBe('failed');
    expect(state.error).toBe('boom');
  });

  test('a failure reported only in `errors` still names the reason', () => {
    const { state } = opsOf([{
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 0,
      errors: ['No conversation found with session ID: 00000000'],
    }]);
    expect(state.status).toBe('failed');
    expect(state.error).toBe('No conversation found with session ID: 00000000');
  });
});

describe('feature 4 — run status', () => {
  test('a run starts running and a bare exit finishes it', () => {
    const state = createRunState();
    expect(state.status).toBe('running');
    finishRun(state);
    expect(state.status).toBe('finished');
  });

  test('finishRun does not overwrite an already-failed run', () => {
    const state = createRunState();
    failRun(state, 'not a directory');
    finishRun(state);
    expect(state.status).toBe('failed');
    expect(state.error).toBe('not a directory');
  });
});

describe('feature 7 — the subagent tree', () => {
  const events: RawEvent[] = [
    assistant([{ type: 'text', text: 'I will survey the repo.' }]),
    assistant([toolUse('task_1', 'Task', { subagent_type: 'Explore', description: 'survey the code' })]),
    assistant([toolUse('sub_tool_1', 'Read', { file_path: 'src/cli.py' })], 'task_1'),
    toolResult('sub_tool_1', 'cli.py implements --json', false, 'task_1'),
    assistant([{ type: 'text', text: 'cli.py implements --json.' }], 'task_1'),
    assistant([toolUse('tu_2', 'Edit', { file_path: 'README.md' })]),
  ];

  test('subagent events are nested under the call that spawned them', () => {
    const { state } = opsOf(events);
    const tree = buildTree(state.nodes);
    const taskCall = tree.find((t) => t.node.kind === 'tool' && (t.node as ToolNode).name === 'Task');
    expect(taskCall).toBeDefined();
    // Two children, not three: the subagent's tool_result attaches to its
    // existing Read call rather than becoming a node of its own.
    expect(taskCall!.children).toHaveLength(2);
    expect(taskCall!.children.map((c) => c.node.kind)).toEqual(['tool', 'text']);
    const read = taskCall!.children[0].node as ToolNode;
    expect(read.name).toBe('Read');
    expect(read.status).toBe('ok');
    expect(read.result?.text).toBe('cli.py implements --json');
    // The Edit call stays at the top level.
    expect(tree.map((t) => (t.node.kind === 'tool' ? (t.node as ToolNode).name : t.node.kind)))
      .toEqual(['text', 'Task', 'Edit']);
  });

  test('a run with no subagents still renders as a flat list', () => {
    const { state } = opsOf([
      assistant([{ type: 'text', text: 'hi' }]),
      assistant([toolUse('tu_1', 'Bash', { command: 'ls' })]),
    ]);
    const tree = buildTree(state.nodes);
    expect(tree).toHaveLength(2);
    expect(tree.every((t) => t.children.length === 0)).toBe(true);
  });

  test('an orphan event whose parent is missing stays at the top level', () => {
    const { state } = opsOf([assistant([toolUse('tu_1', 'Read', {})], 'task_gone')]);
    expect(buildTree(state.nodes)).toHaveLength(1);
  });

  test('the outline lists call names only, with nesting depth', () => {
    const { state } = opsOf(events);
    expect(outline(state.nodes)).toEqual([
      { id: 'task_1', name: 'Task', status: 'pending', depth: 0 },
      { id: 'sub_tool_1', name: 'Read', status: 'ok', depth: 1 },
      { id: 'tu_2', name: 'Edit', status: 'pending', depth: 0 },
    ]);
  });
});

describe('secret redaction', () => {
  test('provider keys are cut down', () => {
    expect(redactSecrets('key sk-ant-abcdef1234567890 end')).not.toContain('abcdef1234567890');
  });

  test('a key in a command is not shown in the call label', () => {
    const { state } = opsOf([
      assistant([toolUse('tu_1', 'Bash', { command: 'export ANTHROPIC_API_KEY=hunter2hunter2 && ./run.sh' })]),
    ]);
    expect((state.nodes[0] as ToolNode).label).not.toContain('hunter2hunter2');
  });

  test('a key in a tool result is not shown either', () => {
    const { state } = opsOf([
      assistant([toolUse('tu_1', 'Read', { file_path: '.env' })]),
      toolResult('tu_1', 'ANTHROPIC_API_KEY=supersecretvalue'),
    ]);
    expect((state.nodes[0] as ToolNode).result?.text).not.toContain('supersecretvalue');
  });

  test('env-style assignments are redacted whatever the name', () => {
    expect(redactSecrets('ANTHROPIC_API_KEY=supersecretvalue')).toBe('ANTHROPIC_API_KEY=[redacted]');
    expect(redactSecrets('MY_ACCESS_TOKEN: hunter2hunter2')).toBe('MY_ACCESS_TOKEN: [redacted]');
  });

  test('bearer tokens are redacted', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });

  test('ordinary text is untouched', () => {
    expect(redactSecrets('FAILED tests/test_parse.py::test_parse')).toBe('FAILED tests/test_parse.py::test_parse');
  });
});

describe('tool summary lines', () => {
  test('the common tools get a one-line label', () => {
    expect(toolSummary('Bash', { command: 'pytest -x' })).toBe('pytest -x');
    expect(toolSummary('Read', { file_path: 'src/parser.py' })).toBe('src/parser.py');
    expect(toolSummary('Grep', { pattern: 'TODO', path: 'src' })).toBe('TODO  in  src');
    expect(toolSummary('Glob', { pattern: '**/*.py' })).toBe('**/*.py');
  });

  test('both names for the delegating call show its type and description', () => {
    const input = { subagent_type: 'Explore', description: 'survey the code' };
    expect(toolSummary('Agent', input)).toBe('Explore: survey the code');
    expect(toolSummary('Task', input)).toBe('Explore: survey the code');
  });

  test('an unknown tool falls back to its scalar inputs', () => {
    expect(toolSummary('Weird', { alpha: 'one', beta: 2, nested: { x: 1 } }))
      .toBe('alpha=one  beta=2');
  });
});

describe('applyEvent contract', () => {
  test('returned ops always carry the data the browser needs, and nothing raw', () => {
    const { ops } = opsOf([
      { type: 'system', subtype: 'init', session_id: 's', cwd: '/x', model: 'm' },
      assistant([toolUse('tu_1', 'Bash', { command: 'ls' })]),
      toolResult('tu_1', 'ok'),
    ]);
    for (const op of ops) {
      expect(JSON.stringify(op)).not.toContain('parent_tool_use_id');
    }
    expect(ops.map((o) => o.op)).toEqual(['meta', 'node', 'tool_result']);
  });
});
