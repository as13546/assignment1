import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LineDecoder, buildArgs, readEventFile, runTurn } from '../src/runner.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-runner-'));

function write(name: string, bytes: Buffer): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, bytes);
  return file;
}

describe('LineDecoder', () => {
  test('splits utf-8 lines and ignores a trailing newline', () => {
    const decoder = new LineDecoder();
    const lines = [...decoder.push(Buffer.from('{"a":1}\n{"b":2}\n', 'utf8')), ...decoder.flush()];
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test('reassembles a line split across chunks', () => {
    const decoder = new LineDecoder();
    const first = decoder.push(Buffer.from('{"half', 'utf8'));
    const second = decoder.push(Buffer.from('":1}\n', 'utf8'));
    expect([...first, ...second]).toEqual(['{"half":1}']);
  });

  test('strips a utf-8 BOM', () => {
    const decoder = new LineDecoder();
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}\n', 'utf8')]);
    expect(decoder.push(bytes)).toEqual(['{"a":1}']);
  });

  test('handles a multi-byte character split across chunks without mangling it', () => {
    const decoder = new LineDecoder();
    const payload = Buffer.from('{"t":"中文"}\n', 'utf8');
    const cut = payload.length - 4; // inside the final multi-byte character
    const a = decoder.push(payload.subarray(0, cut));
    const b = [...decoder.push(payload.subarray(cut)), ...decoder.flush()];
    expect([...a, ...b]).toEqual(['{"t":"中文"}']);
  });

  /**
   * The regression that motivated the decoder: PowerShell's `>` writes
   * UTF-16LE on Windows, so a recorded stream read as UTF-8 becomes one long
   * line of mojibake.
   */
  test('detects UTF-16LE with a BOM (how PowerShell records a run)', () => {
    const text = '{"type":"result","num_turns":12}\n{"type":"system"}\n';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const file = write('utf16.jsonl', bytes);
    expect(readEventFile(file)).toEqual(['{"type":"result","num_turns":12}', '{"type":"system"}']);
  });

  test('reads the same content identically from UTF-8 and UTF-16LE', () => {
    const text = '{"a":"value"}\n';
    const utf8 = write('a.jsonl', Buffer.from(text, 'utf8'));
    const utf16 = write('b.jsonl', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    expect(readEventFile(utf8)).toEqual(readEventFile(utf16));
  });

  test('a final line with no trailing newline is still returned', () => {
    const file = write('no-newline.jsonl', Buffer.from('{"a":1}', 'utf8'));
    expect(readEventFile(file)).toEqual(['{"a":1}']);
  });
});

describe('buildArgs', () => {
  test('the documented Part 1 command', () => {
    expect(buildArgs({ prompt: 'hi', cwd: '/tmp' }))
      .toEqual(['hi', '--output-format', 'stream-json', '--verbose']);
  });

  test('resume is passed through as --resume', () => {
    expect(buildArgs({ prompt: 'more', cwd: '/tmp', resumeSessionId: 'fe891e8a' }))
      .toEqual(['more', '--output-format', 'stream-json', '--verbose', '--resume', 'fe891e8a']);
  });

  test('auto-approval flags', () => {
    expect(buildArgs({ prompt: 'x', cwd: '/tmp', skipPermissions: true }))
      .toContain('--dangerously-skip-permissions');
    expect(buildArgs({ prompt: 'x', cwd: '/tmp', allowedTools: ['Edit', 'Bash(pytest:*)'] }))
      .toEqual(['x', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Edit', 'Bash(pytest:*)']);
  });
});

describe('runTurn replay mode', () => {
  test('streams a recorded UTF-16LE stream as raw events', async () => {
    const text = [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
      '{"type":"result","subtype":"success","num_turns":1}',
    ].join('\n') + '\n';
    const file = write('replay.jsonl', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));

    const messages: string[] = [];
    for await (const message of runTurn({ prompt: '', cwd: tmp, replayFile: file })) {
      messages.push(message.kind === 'raw' ? `raw:${message.event.type}` : message.kind);
    }
    expect(messages).toEqual(['raw:system', 'raw:assistant', 'raw:result', 'exit']);
  });

  test('a non-JSON line is reported, not fatal', async () => {
    const file = write('noisy.jsonl', Buffer.from('{"type":"system"}\nnot json\n', 'utf8'));
    const kinds: string[] = [];
    for await (const message of runTurn({ prompt: '', cwd: tmp, replayFile: file })) kinds.push(message.kind);
    expect(kinds).toEqual(['raw', 'unparsed', 'exit']);
  });

  test('a missing replay file fails with a named error', async () => {
    const kinds: string[] = [];
    for await (const message of runTurn({ prompt: '', cwd: tmp, replayFile: path.join(tmp, 'nope.jsonl') })) {
      kinds.push(message.kind === 'spawn_error' ? message.message : message.kind);
    }
    expect(kinds[0]).toContain('replay file not found');
  });
});

describe('runTurn spawn failures', () => {
  test('a working directory that does not exist fails before spawning', async () => {
    const seen: string[] = [];
    for await (const message of runTurn({ prompt: 'hi', cwd: path.join(tmp, 'missing-dir') })) {
      seen.push(message.kind === 'spawn_error' ? message.message : message.kind);
    }
    expect(seen[0]).toContain('working directory does not exist');
  });

  test('a path that is a file, not a directory, is named as such', async () => {
    const file = write('afile.txt', Buffer.from('x'));
    const seen: string[] = [];
    for await (const message of runTurn({ prompt: 'hi', cwd: file })) {
      seen.push(message.kind === 'spawn_error' ? message.message : message.kind);
    }
    expect(seen[0]).toContain('not a directory');
  });

  test('a missing binary reports a named spawn error rather than throwing', async () => {
    const seen: string[] = [];
    for await (const message of runTurn({ prompt: 'hi', cwd: tmp, claudeBin: 'definitely-not-a-real-binary-xyz' })) {
      seen.push(message.kind === 'spawn_error' ? message.message : message.kind);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('cannot start definitely-not-a-real-binary-xyz');
  });
});
