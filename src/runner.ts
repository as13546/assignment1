import fs from 'node:fs';
import path from 'node:path';
import { LineDecoder, countLines, readEventFile } from './lines.ts';
import { transcriptEvents } from './transcript.ts';
import type { RawEvent } from './types.ts';

export interface TurnRequest {
  prompt: string;
  cwd: string;
  /** Continuation of an earlier run: passed to the CLI as --resume. */
  resumeSessionId?: string | null;
  /** Replay a recorded .jsonl instead of spawning the agent (dev only). */
  replayFile?: string | null;
  /** Replay a Claude Code conversation transcript from this computer. */
  transcriptFile?: string | null;
  /** Delay between replayed events, so the UI still streams visibly. */
  replayDelayMs?: number;
  /** Auto-approve everything. Only ever set for a scratch directory. */
  skipPermissions?: boolean;
  /** Auto-approve just these tools, e.g. ["Edit", "Bash(pytest:*)"]. */
  allowedTools?: string[];
  claudeBin?: string;
  /** Args placed before the prompt, e.g. a script path for a wrapper binary. */
  binPrefix?: string[];
  /** Kill the run after this long. */
  timeoutMs?: number;
}

export type RunnerMessage =
  | { kind: 'raw'; event: RawEvent }
  | { kind: 'unparsed'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'exit'; code: number | null; timedOut: boolean }
  | { kind: 'spawn_error'; message: string };

export { LineDecoder, readEventFile };

/** Default: five minutes is generous for a demo-sized task. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function parseLine(line: string): RawEvent | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? (value as RawEvent) : null;
  } catch {
    return null;
  }
}

/** The argv for one turn, exported so the README can show exactly what runs. */
export function buildArgs(req: TurnRequest): string[] {
  const args = [req.prompt, '--output-format', 'stream-json', '--verbose'];
  if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
  if (req.skipPermissions) args.push('--dangerously-skip-permissions');
  if (req.allowedTools?.length) args.push('--allowedTools', ...req.allowedTools);
  return args;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Yields raw events as they arrive, then exactly one terminal message
 * (`exit` or `spawn_error`) — callers never have to catch.
 */
export async function* runTurn(
  req: TurnRequest,
  abort?: AbortSignal,
): AsyncGenerator<RunnerMessage> {
  if (req.transcriptFile) {
    yield* transcriptTurn(req, abort);
    return;
  }
  if (req.replayFile) {
    yield* replayTurn(req, abort);
    return;
  }
  yield* spawnTurn(req, abort);
}

/**
 * Replay a conversation the user has already had with Claude Code. Its events
 * are normalised as they are read, so the page streams them exactly like a
 * live run instead of appearing all at once at the end.
 */
async function* transcriptTurn(
  req: TurnRequest,
  abort?: AbortSignal,
): AsyncGenerator<RunnerMessage> {
  const file = path.resolve(req.transcriptFile!);
  if (!fs.existsSync(file)) {
    yield { kind: 'spawn_error', message: `conversation not found: ${file}` };
    return;
  }
  const delay = req.replayDelayMs ?? 0;
  // A real conversation can hold thousands of records, and a fixed per-event
  // delay would turn opening one into a multi-minute wait. Spread the budget
  // across the records instead, and skip the pause entirely at delay 0.
  const records = Math.max(1, countLines(file));
  const perEvent = delay > 0 ? Math.min(delay, Math.max(0, Math.floor(20_000 / records))) : 0;
  let due = Date.now();
  try {
    for await (const event of transcriptEvents(file)) {
      if (abort?.aborted) break;
      yield { kind: 'raw', event };
      // Pace the stream so a long conversation is watchable rather than a
      // single frame, but never fall behind the clock.
      if (perEvent > 0) {
        due += perEvent;
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
      }
    }
  } catch (error) {
    yield { kind: 'stderr', text: `cannot read conversation: ${(error as Error).message}` };
  }
  yield { kind: 'exit', code: 0, timedOut: false };
}

async function* replayTurn(req: TurnRequest, abort?: AbortSignal): AsyncGenerator<RunnerMessage> {
  const file = path.resolve(req.replayFile!);
  if (!fs.existsSync(file)) {
    yield { kind: 'spawn_error', message: `replay file not found: ${file}` };
    return;
  }

  let lines: string[];
  try {
    lines = readEventFile(file);
  } catch (error) {
    yield { kind: 'spawn_error', message: `cannot read replay file: ${(error as Error).message}` };
    return;
  }

  const delay = req.replayDelayMs ?? 0;
  for (const line of lines) {
    if (abort?.aborted) {
      yield { kind: 'exit', code: null, timedOut: false };
      return;
    }
    const event = parseLine(line);
    if (event) yield { kind: 'raw', event };
    else yield { kind: 'unparsed', text: line.slice(0, 500) };
    // Counting-only events can pass by quickly; visible ones get a beat so the
    // replay exercises the same incremental rendering a live run does.
    if (delay > 0) {
      const isNoise = event?.type === 'system' &&
        (event.subtype === 'thinking_tokens' || event.subtype === 'hook_started' ||
         event.subtype === 'hook_response');
      await sleep(isNoise ? Math.min(delay, 2) : delay);
    }
  }
  yield { kind: 'exit', code: 0, timedOut: false };
}

async function* spawnTurn(req: TurnRequest, abort?: AbortSignal): AsyncGenerator<RunnerMessage> {
  const cwd = path.resolve(req.cwd || process.cwd());

  // Check the directory ourselves so a bad path produces the error the
  // assignment's feature 4 asks for, rather than an opaque spawn failure.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    yield { kind: 'spawn_error', message: `working directory does not exist: ${cwd}` };
    return;
  }
  if (!stat.isDirectory()) {
    yield { kind: 'spawn_error', message: `not a directory: ${cwd}` };
    return;
  }

  const bin = req.claudeBin || process.env.CLAUDE_BIN || 'claude';
  const args = [...(req.binPrefix ?? []), ...buildArgs(req)];

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd,
      // "ignore", not "pipe": a piped stdin makes the CLI wait 3s for data
      // that never comes before it starts the turn.
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
  } catch (error) {
    yield { kind: 'spawn_error', message: `cannot start ${bin}: ${(error as Error).message}` };
    return;
  }

  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already gone */ }
  }, timeoutMs);
  const onAbort = () => {
    try { proc.kill(); } catch { /* already gone */ }
  };
  abort?.addEventListener('abort', onAbort, { once: true });

  let killed = false;

  try {
    const decoder = new LineDecoder();
    const stderrChunks: string[] = [];

    const readStdout = async function* (this: void) {
      const stream = proc.stdout as ReadableStream<Uint8Array>;
      for await (const chunk of stream) {
        for (const line of decoder.push(Buffer.from(chunk))) yield line;
      }
      for (const line of decoder.flush()) yield line;
    };

    const stderrDone = (async () => {
      const stream = proc.stderr as ReadableStream<Uint8Array>;
      const dec = new TextDecoder();
      for await (const chunk of stream) stderrChunks.push(dec.decode(chunk));
    })();

    for await (const line of readStdout()) {
      const event = parseLine(line);
      if (event) yield { kind: 'raw', event };
      else yield { kind: 'unparsed', text: line.slice(0, 500) };
    }

    await stderrDone;
    killed = true;
    const code = await proc.exited;

    const stderr = stderrChunks.join('');
    // The CLI writes banners and warnings to stderr that are not errors; only
    // forward it when the turn actually failed, where it explains why.
    if (stderr.trim() && (code !== 0 || timedOut)) {
      yield { kind: 'stderr', text: stderr.trim().slice(0, 4000) };
    }
    yield { kind: 'exit', code, timedOut };
  } finally {
    clearTimeout(timer);
    abort?.removeEventListener('abort', onAbort);
    if (!killed) {
      try { proc.kill(); } catch { /* already gone */ }
    }
  }
}
