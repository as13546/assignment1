/**
 * The spawn path, end to end, against a stand-in binary.
 *
 * Replay mode is cheap to test but skips everything that actually goes wrong
 * in production: reading a real pipe line by line, draining stderr, and
 * turning an exit code into a run status.
 */

import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { driveRun } from '../src/drive.ts';
import { createRunState } from '../src/translate.ts';
import type { Op, RunState } from '../src/types.ts';

const FAKE = path.resolve(import.meta.dir, 'helpers', 'fake-claude.mjs');

async function runThroughServer(prompt: string): Promise<{ state: RunState; ops: Op[]; exitCode: number | null }> {
  const state = createRunState();
  const ops: Op[] = [];
  let exitCode: number | null = null;

  await driveRun(
    { state, abort: new AbortController() },
    { prompt, cwd: import.meta.dir, claudeBin: process.execPath, binPrefix: [FAKE], timeoutMs: 30_000 },
    {
      emit: (batch) => ops.push(...batch),
      end: (code) => { exitCode = code; },
    },
  );
  return { state, ops, exitCode };
}

describe('a successful run', () => {
  test('streams a trajectory and finishes', async () => {
    const { state, exitCode } = await runThroughServer('do the thing');

    expect(exitCode).toBe(0);
    expect(state.status).toBe('finished');
    expect(state.sessionId).toBe('fake-session-1');
    expect(state.thinkingTokens).toBe(5);

    const kinds = state.nodes.map((node) => node.kind);
    // Two text nodes and one tool call; the thinking_tokens never become nodes.
    expect(kinds).toEqual(['text', 'tool', 'text']);
  });

  test('the run numbers come from the result event', async () => {
    const { state } = await runThroughServer('do the thing');
    expect(state.stats).toEqual({ costUsd: 0.58, durationMs: 42000, numTurns: 12, isError: false });
  });

  test('a tool result attaches to its call', async () => {
    const { state } = await runThroughServer('do the thing');
    const tool = state.nodes.find((node) => node.kind === 'tool');
    expect(tool && 'status' in tool ? tool.status : null).toBe('ok');
    expect(tool && 'result' in tool ? tool.result?.text : null).toBe('FAILED tests/test_parse.py');
  });

  /*
   * The regression this file exists for: the stand-in writes 1 MB to stderr,
   * so a reader that drains stderr after stdout hangs here instead of
   * finishing. A live run surfaced it as
   * "readStderr is not a function".
   */
  test('1 MB of stderr does not deadlock or fail the run', async () => {
    const { state, exitCode } = await runThroughServer('do the thing');
    expect(exitCode).toBe(0);
    expect(state.status).toBe('finished');
    expect(state.error).toBeNull();
  });
});

describe('a failing run', () => {
  test('a non-zero exit with an error result is reported as failed', async () => {
    const { state, exitCode } = await runThroughServer('FAIL please');
    expect(exitCode).toBe(1);
    expect(state.status).toBe('failed');
    // The agent's own reason wins over 1 MB of stderr noise.
    expect(state.error).toBe('the agent gave up');
  });
});

describe('a run that ends without a result event', () => {
  test('exit code 0 is enough to finish it', async () => {
    const { state, exitCode } = await runThroughServer('NOEXIT');
    expect(exitCode).toBe(0);
    expect(state.status).toBe('finished');
    expect(state.stats).toBeNull();
  });
});

describe('noise on stdout', () => {
  test('a non-JSON line becomes a notice and the run still finishes', async () => {
    const { state } = await runThroughServer('NOISE here');
    const notices = state.nodes.filter((node) => node.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].text ?? '').toContain('this line is not json');
    expect(state.status).toBe('finished');
  });
});
