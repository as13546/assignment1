/**
 * A stand-in for the `claude` binary, so the spawn path can be tested without
 * spending a real run. It takes the same argv shape and writes the same
 * stream-json on stdout.
 *
 * Behaviour is chosen by the prompt (argv[0] after the script):
 *   contains "FAIL"    → a result event with is_error, exit code 1
 *   contains "NOISE"   → a non-JSON banner line before the events
 *   contains "NOEXIT"  → events with no result event, exit code 0
 *   otherwise          → init, assistant text, a tool call + result, done
 *
 * It always writes ~1 MB to stderr. That is deliberate: a reader that drains
 * stderr only after stdout would block on the full pipe, so this turns that
 * deadlock into a hanging test.
 */
const prompt = process.argv[2] ?? '';
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const big = 'x'.repeat(1024) + '\n';
for (let i = 0; i < 1024; i++) process.stderr.write(big);

write({ type: 'system', subtype: 'init', session_id: 'fake-session-1', cwd: process.cwd(), model: 'fake-model' });

if (prompt.includes('NOISE')) process.stdout.write('this line is not json\n');

for (let i = 0; i < 5; i++) write({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: i + 1 });

write({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Reading the parser first.' }] },
});

write({
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    id: 'm2',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'pytest -x' } }],
  },
});

write({
  type: 'user',
  parent_tool_use_id: null,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'FAILED tests/test_parse.py', is_error: false }],
  },
});

if (prompt.includes('FAIL')) {
  write({ type: 'result', subtype: 'error', is_error: true, result: 'the agent gave up', num_turns: 1 });
  process.exit(1);
}

write({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'All 12 tests pass.' }] } });

if (prompt.includes('NOEXIT')) process.exit(0);

write({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'fake-session-1',
  total_cost_usd: 0.58,
  duration_ms: 42000,
  num_turns: 12,
});
process.exit(0);
