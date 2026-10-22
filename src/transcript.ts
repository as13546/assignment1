import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLines } from './lines.ts';
import type { RawContentBlock, RawEvent } from './types.ts';

/**
 * Claude Code writes every conversation it has ever had to
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. That transcript is the
 * real record of an interaction — prompts, assistant text, thinking, every tool
 * call and every tool result — and it is what the conversation list reads once
 * the user has allowed it.
 *
 * A transcript is not the CLI's `--output-format stream-json`, but its
 * `message.content` blocks are the same shapes, so this module rewrites the
 * envelope and the existing reducer does the rest.
 */

export interface TranscriptInfo {
  id: string;
  path: string;
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  prompt: string;
  startedAt: number | null;
  endedAt: number | null;
  turns: number;
  toolCalls: number;
  tokens: number;
  size: number;
  mtime: number;
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface Entry {
  type?: string;
  subtype?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  origin?: { kind?: string };
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Record<string, number>;
  };
}

const DELEGATING_TOOLS = new Set(['Task', 'Agent']);

export function defaultTranscriptRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** The prompt a human typed, or null for tool results and injected context. */
function humanPrompt(entry: Entry): string | null {
  // Only a `user` record can be a prompt. An assistant record carries the same
  // text blocks but no `origin`, so anything looser here would relabel the
  // agent's own answers as things the human said.
  if (entry.type !== 'user') return null;
  if (entry.isMeta) return null;
  if (entry.origin?.kind && entry.origin.kind !== 'human') return null;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => (b as Block)?.type === 'tool_result')) return null;
  const text = content
    .filter((b) => (b as Block)?.type === 'text' && typeof (b as Block).text === 'string')
    .map((b) => (b as Block).text as string)
    .join('\n')
    .trim();
  return text || null;
}

function blocksOf(entry: Entry): Block[] {
  const content = entry.message?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function findFiles(root: string, depth: number, out: string[]): void {
  if (depth > 3) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) findFiles(full, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

const TIMESTAMP = /"timestamp":"([^"]+)"/;

/** Parse one transcript record, or null when the line is not usable JSON. */
function parseEntry(line: string): Entry | null {
  try {
    return JSON.parse(line) as Entry;
  } catch {
    return null; // a truncated tail line, or a hook's own output
  }
}

/** One pass over a transcript: what the conversation list needs, nothing more.
 *
 * A conversation transcript is mostly large `content` payloads, so the cheap
 * string tests below decide what is worth parsing. Full JSON.parse on every
 * line made listing the conversations take seconds. */
export async function summarizeTranscript(file: string): Promise<TranscriptInfo> {
  const stat = fs.statSync(file);
  const info: TranscriptInfo = {
    id: Buffer.from(file).toString('base64url'),
    path: file,
    sessionId: null,
    cwd: null,
    model: null,
    prompt: '',
    startedAt: null,
    endedAt: null,
    turns: 0,
    toolCalls: 0,
    tokens: 0,
    size: stat.size,
    mtime: stat.mtimeMs,
  };

  for await (const line of readLines(file)) {
    if (!line) continue;

    const at = TIMESTAMP.exec(line);
    if (at) {
      const ms = Date.parse(at[1]);
      if (!Number.isNaN(ms) && (info.startedAt === null || ms < info.startedAt)) {
        info.startedAt = ms;
      }
    }

    // Tool calls are counted by occurrence, not by parsing the block.
    let from = 0;
    for (;;) {
      const hit = line.indexOf('"type":"tool_use"', from);
      if (hit < 0) break;
      info.toolCalls += 1;
      from = hit + 16;
    }

    // A human turn is the only thing worth building a prompt out of.
    if (line.includes('"kind":"human"')) {
      info.turns += 1;
      if (!info.prompt) {
        const entry = parseEntry(line);
        const prompt = entry ? humanPrompt(entry) : null;
        info.prompt = prompt ? prompt.slice(0, 160) : '';
      }
    }

    if (info.model === null && line.includes('"usage"')) {
      const entry = parseEntry(line);
      if (entry?.message?.model) info.model = entry.message.model;
      const usage = entry?.message?.usage;
      if (usage) {
        info.tokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
          + (usage.cache_read_input_tokens ?? 0)
          + (usage.cache_creation_input_tokens ?? 0);
      }
    }

    if (info.sessionId === null && line.includes('"sessionId"')) {
      const entry = parseEntry(line);
      info.sessionId = entry?.sessionId ?? null;
    }
    if (info.cwd === null && line.includes('"cwd"')) {
      const entry = parseEntry(line);
      if (entry?.cwd) info.cwd = entry.cwd;
    }
  }

  // The file's own mtime is the end of the conversation, which saves reading
  // to the tail of a multi-megabyte transcript.
  info.endedAt = stat.mtimeMs;

  // The directory name Claude Code derives from the cwd is a decent fallback
  // when a transcript never recorded one.
  if (!info.cwd) {
    info.cwd = path.basename(path.dirname(file)).replace(/-/g, '/');
  }
  return info;
}

export async function listTranscripts(roots: string[], limit = 40): Promise<TranscriptInfo[]> {
  const files: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    findFiles(root, 0, files);
  }
  // Newest first, and only open the ones a reader could plausibly pick.
  const ranked = files
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  const infos = await Promise.all(ranked.map(({ file }) => summarizeTranscript(file)));
  return infos.filter((info) => info.turns > 0 || info.toolCalls > 0);
}

/**
 * Rewrite a transcript into the event stream the reducer already understands.
 * A sidechain entry belongs to the delegating call that is still the most
 * recent one, which is how the CLI's own stream marks subagent events.
 */
export async function* transcriptEvents(file: string): AsyncGenerator<RawEvent> {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let delegatingToolId: string | null = null;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  let turns = 0;
  let emittedInit = false;
  /** The last prompt seen, cleared as soon as the agent does anything. */
  let lastPrompt: string | null = null;

  for await (const line of readLines(file)) {
    if (!line) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    sessionId ??= entry.sessionId ?? null;
    if (entry.cwd) cwd = entry.cwd;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(at)) {
      firstAt = firstAt === null ? at : Math.min(firstAt, at);
      lastAt = lastAt === null ? at : Math.max(lastAt, at);
    }

    const prompt = humanPrompt(entry);
    if (prompt) {
      // A resumed or re-injected session records the same opening prompt more
      // than once. If nothing was produced in between, it is the same turn.
      if (prompt === lastPrompt) continue;
      lastPrompt = prompt;
      turns += 1;
      delegatingToolId = null;
      yield { type: 'system', subtype: 'user_prompt', content: prompt };
      continue;
    }

    if (entry.type === 'assistant') {
      model ??= entry.message?.model ?? null;
      const blocks = blocksOf(entry);
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.id && DELEGATING_TOOLS.has(block.name ?? '')) {
          delegatingToolId = block.id;
        }
      }
      if (!blocks.length) continue;
      // The agent has acted, so the same words typed again are a new turn.
      lastPrompt = null;
      // `init` waits for the first assistant record so it can name the model;
      // a prompt alone never says which model is answering.
      if (!emittedInit) {
        emittedInit = true;
        yield {
          type: 'system',
          subtype: 'init',
          session_id: sessionId ?? undefined,
          cwd: cwd ?? undefined,
          model: model ?? undefined,
        };
      }
      yield {
        type: 'assistant',
        parent_tool_use_id: entry.isSidechain ? delegatingToolId : null,
        message: {
          id: entry.message?.id,
          role: 'assistant',
          model: entry.message?.model,
          content: blocks as RawContentBlock[],
        },
      };
      continue;
    }

    if (entry.type === 'user') {
      const blocks = blocksOf(entry).filter((b) => b.type === 'tool_result');
      if (!blocks.length) continue;
      yield {
        type: 'user',
        parent_tool_use_id: entry.isSidechain ? delegatingToolId : null,
        message: { role: 'user', content: blocks as RawContentBlock[] },
      };
    }
  }

  if (!emittedInit) {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: sessionId ?? undefined,
      cwd: cwd ?? undefined,
      model: model ?? undefined,
    };
  }

  // A transcript keeps no cost record, but it does keep a clock: report the
  // real wall-clock span and turn count rather than inventing numbers.
  yield {
    type: 'result',
    subtype: 'success',
    session_id: sessionId ?? undefined,
    is_error: false,
    num_turns: turns || undefined,
    duration_ms: firstAt !== null && lastAt !== null ? Math.max(0, lastAt - firstAt) : undefined,
  };
}
