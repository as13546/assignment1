export interface RawContentBlock {
  type: string;
  // type === "text"
  text?: string;
  // type === "tool_use"
  id?: string;
  name?: string;
  input?: unknown;
  // type === "tool_result"
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  // type === "thinking"
  thinking?: string;
}

export interface RawMessage {
  id?: string;
  role?: string;
  model?: string;
  content?: RawContentBlock[] | string;
}

export interface RawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  timestamp?: string;
  /** null for the main agent; the spawning tool_use id for subagent events. */
  parent_tool_use_id?: string | null;
  message?: RawMessage;
  cwd?: string;
  model?: string;
  // system/thinking_tokens
  estimated_tokens?: number;
  estimated_tokens_delta?: number;
  // system/informational
  content?: unknown;
  level?: string;
  // result
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  result?: string;
  [key: string]: unknown;
}

export type ToolStatus = 'pending' | 'ok' | 'error';
export type RunStatus = 'running' | 'finished' | 'failed';

export interface ToolResult {
  /** The whole result (redacted), so the page can expand what it folded. */
  text: string;
  /** The folded head shown by default; the fold policy lives in translate.ts. */
  preview: string;
  isError: boolean;
  totalLines: number;
  previewLines: number;
  /** True when `preview` is shorter than `text`. */
  truncated: boolean;
  /** True when even `text` was capped for transport. */
  capped: boolean;
}

interface NodeBase {
  /** Stable id; for tool calls this is the tool_use id so results can attach. */
  id: string;
  /** null => main agent; otherwise the tool_use id of the spawning Task call. */
  parentToolUseId: string | null;
  seq: number;
}

export interface TextNode extends NodeBase {
  kind: 'text';
  text: string;
  /** The assistant message this came from; consecutive chunks from one
   *  message are merged into a single node. */
  messageId: string | null;
}

export interface ThinkingNode extends NodeBase {
  kind: 'thinking';
  text: string;
  messageId: string | null;
}

export interface ToolNode extends NodeBase {
  kind: 'tool';
  name: string;
  input: unknown;
  /** One-line summary for display, already redacted. The page must not
   *  derive its own from `input`, or a secret in a command would show. */
  label: string;
  status: ToolStatus;
  result: ToolResult | null;
}

export interface NoticeNode extends NodeBase {
  kind: 'notice';
  level: 'info' | 'warn';
  text: string;
}

export type Node = TextNode | ThinkingNode | ToolNode | NoticeNode;

export interface RunStats {
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  isError: boolean;
}

export interface RunState {
  nodes: Node[];
  /** Events whose only effect is a counter (noise we fold into one line). */
  thinkingTokens: number;
  hookEvents: number;
  sessionId: string | null;
  model: string | null;
  cwd: string | null;
  status: RunStatus;
  /** Set when the run failed for a reason we can name (bad cwd, exit code). */
  error: string | null;
  stats: RunStats | null;
  /** Human-readable message from the CLI's final result event, if any. */
  resultText: string | null;
}

/** The server forwards only these, so the browser never re-renders everything. */
export type Op =
  | { op: 'node'; node: Node }
  | { op: 'tool_result'; id: string; status: ToolStatus; result: ToolResult }
  | { op: 'thinking'; total: number; hookEvents: number }
  | { op: 'meta'; sessionId: string | null; model: string | null; cwd: string | null }
  | { op: 'run'; status: RunStatus; stats: RunStats | null; error: string | null; resultText: string | null };

export interface TreeNode {
  node: Node;
  children: TreeNode[];
}
