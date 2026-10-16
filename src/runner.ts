import fs from 'node:fs';
import path from 'node:path';
import type { RawEvent } from './types.ts';

export interface TurnRequest {
  prompt: string;
  cwd: string;
  /** Continuation of an earlier run: passed to the CLI as --resume. */
  resumeSessionId?: string | null;
  /** Replay a recorded .jsonl instead of spawning the agent (dev only). */
  replayFile?: string | null;
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

/** Default: five minutes is generous for a demo-sized task. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Splits a byte stream into lines, taking the encoding from the BOM: PowerShell
 * `claude ... > events.jsonl` writes UTF-16LE. Splitting on bytes means a
 * multi-byte character is never cut in half.
 */
export class LineDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private enc: 'utf8' | 'utf16le' = 'utf8';
  private decided = false;

  push(chunk: Buffer): string[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    if (!this.decided) {
      if (this.buf.length >= 2 && this.buf[0] === 0xff && this.buf[1] === 0xfe) {
        this.enc = 'utf16le';
        this.buf = this.buf.subarray(2);
        this.decided = true;
      } else if (this.buf.length >= 3 && this.buf[0] === 0xef && this.buf[1] === 0xbb && this.buf[2] === 0xbf) {
        this.buf = this.buf.subarray(3);
        this.decided = true;
      } else if (this.buf.length >= 1) {
        this.decided = true;
      }
    }

    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      if (this.enc === 'utf8') {
        if (this.buf[i] !== 0x0a) continue;
        lines.push(this.decode(this.buf.subarray(start, i)));
        start = i + 1;
      } else {
        if (this.buf[i] !== 0x0a || this.buf[i + 1] !== 0x00) continue;
        lines.push(this.decode(this.buf.subarray(start, i)));
        start = i + 2;
        i++;
      }
    }
    this.buf = this.buf.subarray(start);
    return lines.map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  }

  /** Anything left after the stream closed (a file with no trailing newline). */
  flush(): string[] {
    const rest = this.decode(this.buf).replace(/\r?\n?$/, '');
    this.buf = Buffer.alloc(0);
    return rest ? [rest] : [];
  }

  private decode(bytes: Buffer): string {
    // Buffer.toString('utf16le') needs an even byte count; a trailing newline
    // byte-pair is already stripped, but be defensive about odd leftovers.
    if (this.enc === 'utf16le') {
      const even = bytes.length % 2 === 0 ? bytes : bytes.subarray(0, bytes.length - 1);
      return even.toString('utf16le');
    }
    return bytes.toString('utf8');
  }

  get encoding(): 'utf8' | 'utf16le' {
    return this.enc;
  }
}

export function readEventFile(file: string): string[] {
  const bytes = fs.readFileSync(file);
  const decoder = new LineDecoder();
  return [...decoder.push(bytes), ...decoder.flush()];
}

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
  if (req.replayFile) {
    yield* replayTurn(req, abort);
    return;
  }
  yield* spawnTurn(req, abort);
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
