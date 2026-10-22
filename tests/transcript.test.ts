import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeTranscript, transcriptEvents } from '../src/transcript.ts';
import { applyEvent, createRunState } from '../src/translate.ts';
import type { RawEvent } from '../src/types.ts';

/** A transcript shaped like the ones Claude Code actually writes. */
function writeTranscript(records: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
  return file;
}

const base = { sessionId: 's1', cwd: 'H:/repo', timestamp: '2026-10-18T10:00:00.000Z' };

async function collect(file: string): Promise<RawEvent[]> {
  const events: RawEvent[] = [];
  for await (const event of transcriptEvents(file)) events.push(event);
  return events;
}

function reduce(file: string) {
  return collect(file).then((events) => {
    const state = createRunState();
    for (const event of events) applyEvent(state, event);
    return state;
  });
}

describe('conversation transcripts', () => {
  test('a human turn becomes a prompt and an assistant reply stays text', async () => {
    const file = writeTranscript([
      { ...base, type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] } },
      { ...base, type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'On it.' }] } },
    ]);
    const state = await reduce(file);

    expect(state.nodes.map((n) => n.kind)).toEqual(['prompt', 'text']);
    // The agent's own words must never be labelled as something the human said.
    expect(state.nodes[0]).toMatchObject({ kind: 'prompt', text: 'fix the bug' });
    expect(state.nodes[1]).toMatchObject({ kind: 'text', text: 'On it.' });
    expect(state.model).toBe('test-model');
  });

  test('tool calls and their results pair up', async () => {
    const file = writeTranscript([
      { ...base, type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'run the tests' }] } },
      { ...base, type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'pytest' } }] } },
      { ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '1 failed', is_error: true }] } },
    ]);
    const state = await reduce(file);

    const tool = state.nodes.find((n) => n.kind === 'tool');
    expect(tool).toMatchObject({ kind: 'tool', name: 'Bash', status: 'error' });
    const preview = tool && 'result' in tool && tool.result ? tool.result.preview : '';
    expect(preview).toContain('1 failed');
  });

  test('the summary counts turns, calls and tokens', async () => {
    const file = writeTranscript([
      { ...base, type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'first ask' }] } },
      {
        ...base,
        type: 'assistant',
        message: {
          id: 'm1',
          role: 'assistant',
          model: 'test-model',
          content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      { ...base, timestamp: '2026-10-18T10:05:00.000Z', type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'second ask' }] } },
    ]);
    const info = await summarizeTranscript(file);

    expect(info.turns).toBe(2);
    expect(info.toolCalls).toBe(1);
    expect(info.tokens).toBe(15);
    expect(info.prompt).toBe('first ask');
    expect(info.cwd).toBe('H:/repo');
    expect(info.startedAt).toBe(Date.parse('2026-10-18T10:00:00.000Z'));
  });
  test('a prompt recorded twice in a row counts once', async () => {
    const ask = { ...base, type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'same ask' }] } };
    const reply = { ...base, type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
    const repeated = await reduce(writeTranscript([ask, ask, reply]));
    expect(repeated.nodes.filter((n) => n.kind === 'prompt')).toHaveLength(1);
    const genuine = await reduce(writeTranscript([ask, reply, ask]));
    expect(genuine.nodes.filter((n) => n.kind === 'prompt')).toHaveLength(2);
  });
});
