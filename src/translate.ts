import type {
  Node, NoticeNode, Op, PromptNode, RawContentBlock, RawEvent, RunState, RunStats,
  TextNode, ThinkingNode, ToolNode, ToolResult, TreeNode, ToolStatus,
} from './types.ts';

export const FOLD_MAX_LINES = 12;
export const FOLD_MAX_CHARS = 1200;

/** The output is shown verbatim and the agent can read the environment. */
export function redactSecrets(text: string): string {
  return text
    // Anthropic / OpenAI / generic provider keys.
    .replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/g, '$1…[redacted]')
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{6,}/g, '$1…[redacted]')
    // `SOMETHING_TOKEN=abc...`, `SOMETHING_API_KEY: abc...`, in any case.
    .replace(/([A-Za-z0-9_]*(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|AUTH_TOKEN)[A-Za-z0-9_]*\s*[=:]\s*)(\S{6,})/gi,
      (_m, lead) => `${lead}[redacted]`)
    // Bearer tokens.
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, '$1[redacted]');
}

export function toolResultToText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') return b.text;
          if (b.type === 'image') return '[image omitted]';
        }
        return safeJson(block);
      })
      .join('\n');
  }
  return safeJson(content);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export const TRANSPORT_MAX_CHARS = 200_000;

/** Cut a result down to a readable head, but keep the whole text so it can expand. */
export function foldResult(text: string, isError = false): ToolResult {
  const clean = text.replace(/\s+$/, '');
  const lines = clean ? clean.split('\n') : [];
  const totalLines = lines.length;

  const head = lines.slice(0, FOLD_MAX_LINES).join('\n');
  const preview = head.length > FOLD_MAX_CHARS ? head.slice(0, FOLD_MAX_CHARS) : head;
  const previewLines = preview ? preview.split('\n').length : 0;

  const capped = clean.length > TRANSPORT_MAX_CHARS;
  const body = capped ? clean.slice(0, TRANSPORT_MAX_CHARS) : clean;

  return {
    text: body,
    preview,
    isError,
    totalLines,
    previewLines,
    truncated: body !== preview,
    capped,
  };
}

export function createRunState(): RunState {
  return {
    nodes: [],
    thinkingTokens: 0,
    hookEvents: 0,
    sessionId: null,
    model: null,
    cwd: null,
    status: 'running',
    error: null,
    stats: null,
    resultText: null,
  };
}

function nextSeq(state: RunState): number {
  return state.nodes.length;
}

function pushOrMerge(
  state: RunState,
  ops: Op[],
  make: (id: string, seq: number) => TextNode | ThinkingNode,
  field: 'text',
  chunk: string,
  parentToolUseId: string | null,
  messageId: string | null,
): void {
  const last = state.nodes[state.nodes.length - 1];
  if (
    last &&
    last.kind === make('', 0).kind &&
    last.parentToolUseId === parentToolUseId &&
    (last as TextNode | ThinkingNode).messageId === messageId
  ) {
    const merged = (last as TextNode | ThinkingNode)[field] + chunk;
    (last as TextNode | ThinkingNode)[field] = merged;
    ops.push({ op: 'node', node: last });
    return;
  }
  const node = make(`n${state.nodes.length}`, nextSeq(state));
  node[field] = chunk;
  state.nodes.push(node);
  ops.push({ op: 'node', node });
}

function findTool(state: RunState, id: string): ToolNode | undefined {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i];
    if (n.kind === 'tool' && n.id === id) return n;
  }
  return undefined;
}

/** Mutates `state` in place; the server owns one live instance per run. */
export function applyEvent(state: RunState, raw: RawEvent): Op[] {
  const ops: Op[] = [];
  const parentToolUseId = raw.parent_tool_use_id ?? null;

  switch (raw.type) {
    case 'system': {
      switch (raw.subtype) {
        case 'init': {
          state.sessionId = raw.session_id ?? state.sessionId;
          state.cwd = (raw.cwd as string) ?? state.cwd;
          state.model = (raw.model as string) ?? state.model;
          ops.push({ op: 'meta', sessionId: state.sessionId, model: state.model, cwd: state.cwd });
          return ops;
        }
        // The CLI emits one of these per thinking token. Rendering them would
        // bury the trajectory, so they become a single live counter.
        case 'thinking_tokens': {
          state.thinkingTokens = raw.estimated_tokens
            ?? state.thinkingTokens + (raw.estimated_tokens_delta ?? 0);
          ops.push({ op: 'thinking', total: state.thinkingTokens, hookEvents: state.hookEvents });
          return ops;
        }
        // Hook plumbing and startup chatter: counted, not rendered.
        case 'hook_started':
        case 'hook_response':
        case 'hook_progress': {
          state.hookEvents++;
          ops.push({ op: 'thinking', total: state.thinkingTokens, hookEvents: state.hookEvents });
          return ops;
        }
        case 'informational': {
          const text = typeof raw.content === 'string' ? raw.content : safeJson(raw.content);
          const notice: NoticeNode = {
            kind: 'notice',
            id: `n${state.nodes.length}`,
            parentToolUseId: null,
            seq: nextSeq(state),
            level: 'info',
            text: redactSecrets(text),
          };
          state.nodes.push(notice);
          ops.push({ op: 'node', node: notice });
          return ops;
        }
        // Only an imported conversation has prompts inside a run: a live run
        // carries its prompt on the turn itself.
        case 'user_prompt': {
          const text = typeof raw.content === 'string' ? raw.content.trim() : '';
          if (!text) return ops;
          const node: PromptNode = {
            kind: 'prompt',
            id: `n${state.nodes.length}`,
            parentToolUseId: null,
            seq: nextSeq(state),
            text: redactSecrets(text),
          };
          state.nodes.push(node);
          ops.push({ op: 'node', node });
          return ops;
        }
        default:
          return ops;
      }
    }

    case 'assistant': {
      const messageId = raw.message?.id ?? null;
      const blocks = Array.isArray(raw.message?.content) ? raw.message!.content! : [];
      for (const block of blocks as RawContentBlock[]) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          pushOrMerge(
            state, ops,
            (id, seq) => ({ kind: 'text', id, parentToolUseId, seq, text: '', messageId }) as TextNode,
            'text', redactSecrets(block.text), parentToolUseId, messageId,
          );
        } else if (block.type === 'thinking') {
          const chunk = block.thinking ?? (block as unknown as Record<string, string>).text ?? '';
          if (!chunk) continue;
          pushOrMerge(
            state, ops,
            (id, seq) => ({ kind: 'thinking', id, parentToolUseId, seq, text: '', messageId }) as ThinkingNode,
            'text', chunk, parentToolUseId, messageId,
          );
        } else if (block.type === 'tool_use') {
          const node: ToolNode = {
            kind: 'tool',
            id: block.id ?? `tool-${state.nodes.length}`,
            parentToolUseId,
            seq: nextSeq(state),
            name: block.name ?? 'unknown',
            input: block.input ?? {},
            label: redactSecrets(toolSummary(block.name ?? 'unknown', block.input ?? {})),
            status: 'pending',
            result: null,
          };
          state.nodes.push(node);
          ops.push({ op: 'node', node });
        }
      }
      return ops;
    }

    case 'user': {
      const blocks = Array.isArray(raw.message?.content) ? raw.message!.content! : [];
      for (const block of blocks as RawContentBlock[]) {
        if (block.type !== 'tool_result') continue;
        const id = block.tool_use_id;
        if (!id) continue;
        const tool = findTool(state, id);
        if (!tool) continue;
        const body = redactSecrets(toolResultToText(block.content));
        tool.status = block.is_error ? 'error' : 'ok';
        tool.result = foldResult(body, Boolean(block.is_error));
        ops.push({ op: 'tool_result', id, status: tool.status, result: tool.result });
      }
      return ops;
    }

    case 'result': {
      const stats: RunStats = {
        costUsd: typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : null,
        durationMs: typeof raw.duration_ms === 'number'
          ? raw.duration_ms
          : (typeof raw.duration_api_ms === 'number' ? raw.duration_api_ms : null),
        numTurns: typeof raw.num_turns === 'number' ? raw.num_turns : null,
        isError: Boolean(raw.is_error),
      };
      state.stats = stats;
      // A failed run often carries its reason in `errors` and no `result` at
      // all, so both are read before falling back to the subtype.
      const errors = Array.isArray(raw.errors)
        ? (raw.errors as unknown[]).filter((e): e is string => typeof e === 'string')
        : [];
      state.resultText = typeof raw.result === 'string'
        ? redactSecrets(raw.result)
        : (errors.length ? redactSecrets(errors.join('\n')) : null);
      if (raw.session_id) state.sessionId = raw.session_id;

      const failed = Boolean(raw.is_error) || raw.subtype === 'error';
      state.status = failed ? 'failed' : 'finished';
      if (failed && !state.error) {
        state.error = state.resultText
          ?? `the agent ended with an error (${raw.subtype ?? 'unknown'})`;
      }
      // Meta first: the session id must reach the page before the status
      // change, so a follow-up prompt has something to resume.
      ops.push({ op: 'meta', sessionId: state.sessionId, model: state.model, cwd: state.cwd });
      ops.push({
        op: 'run', status: state.status, stats: state.stats,
        error: state.error, resultText: state.resultText,
      });
      return ops;
    }

    default:
      // Unknown event types are ignored rather than rendered. The stream
      // carries more types than the assignment names, and new ones appear
      // between CLI releases.
      return ops;
  }
}

export function failRun(state: RunState, message: string): Op[] {
  state.status = 'failed';
  state.error = message;
  return [{ op: 'run', status: state.status, stats: state.stats, error: state.error, resultText: state.resultText }];
}

export function finishRun(state: RunState): Op[] {
  if (state.status !== 'running') return [];
  state.status = 'finished';
  return [{ op: 'run', status: state.status, stats: state.stats, error: state.error, resultText: state.resultText }];
}

/** A node whose parent is missing stays at the top level rather than vanishing. */
export function buildTree(nodes: Node[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  for (const node of nodes) {
    byId.set(node.id, { node, children: [] });
  }
  for (const node of nodes) {
    const self = byId.get(node.id)!;
    const parent = node.parentToolUseId ? byId.get(node.parentToolUseId) : undefined;
    if (parent) parent.children.push(self);
    else roots.push(self);
  }
  return roots;
}

export function outline(nodes: Node[]): Array<{ id: string; name: string; status: ToolStatus | null; depth: number }> {
  const depthOf = (node: Node): number => {
    let depth = 0;
    let cur = node;
    const seen = new Set<string>();
    while (cur.parentToolUseId && !seen.has(cur.parentToolUseId)) {
      seen.add(cur.parentToolUseId);
      const parent = nodes.find((n) => n.id === cur.parentToolUseId);
      if (!parent) break;
      depth++;
      cur = parent;
    }
    return depth;
  };
  return nodes
    .filter((n): n is ToolNode => n.kind === 'tool')
    .map((n) => ({ id: n.id, name: n.name, status: n.status, depth: depthOf(n) }));
}

/** A one-line label for a call; unknown tools fall back to their scalar inputs. */
export function toolSummary(name: string, rawInput: unknown): string {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  };

  switch (name) {
    case 'Bash':
      return pick('command') ?? '';
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      return pick('file_path', 'notebook_path') ?? '';
    case 'Edit': {
      const file = pick('file_path') ?? '';
      const old = pick('old_string');
      return old ? `${file} — ${firstLine(old)}` : file;
    }
    case 'Glob':
      return pick('pattern') ?? '';
    case 'Grep':
      return [pick('pattern'), pick('path')].filter(Boolean).join('  in  ');
    // The delegating call is `Task` in the docs and `Agent` in current builds.
    case 'Task':
    case 'Agent':
      return [pick('subagent_type'), pick('description') ?? pick('prompt')].filter(Boolean).join(': ');
    case 'WebFetch':
    case 'WebSearch':
      return pick('url', 'query') ?? '';
    default: {
      const flat = Object.entries(input)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .slice(0, 3)
        .map(([k, v]) => `${k}=${String(v)}`);
      return flat.length ? flat.join('  ') : safeJson(input).replace(/\s+/g, ' ').slice(0, 120);
    }
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0].slice(0, 80);
}
