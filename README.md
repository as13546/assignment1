# Assignment 1 — a page that watches a coding agent

A web page that drives Claude Code and shows you what it is doing while it does
it. You type a request, the server spawns the agent in a working directory you
choose, and the page renders the agent's trajectory event by event.

## Running it

Needs [Bun](https://bun.sh) and a `claude` CLI that is already logged in. No
`npm install` step: the server uses Bun's built-in HTTP and WebSocket support,
and the page has no dependencies.

```bash
bun install                     # only @types/bun, for the typechecker
bun run src/server.ts --cwd /path/to/a/repo
```

Then open <http://127.0.0.1:5173>. The `--cwd` argument is the directory the
agent runs in and the default shown in the page's working-directory field; it
defaults to wherever you started the server.

```bash
bun test                        # 78 tests
bunx tsc --noEmit               # typecheck
```

### Options

| Flag | Meaning |
| --- | --- |
| `--cwd <dir>` | default working directory for the agent |
| `--port <n>` | port, default 5173 |
| `--host <addr>` | bind address, default 127.0.0.1 |
| `--token <secret>` | require this token on every request (see *Exposure*) |
| `--claude <path>` | the CLI to spawn, default `claude` |
| `--replay-delay <ms>` | delay between replayed events, default 30 |
| `--no-skip-permissions` | do **not** pass `--dangerously-skip-permissions` |

## How it works

```
claude -p "<prompt>" --output-format stream-json --verbose
        │
        ├─ src/runner.ts     spawns it, splits stdout into events
        ├─ src/translate.ts  turns events into render-ready nodes + ops
        ├─ src/drive.ts      decides the run's final status
        ├─ src/server.ts     Bun.serve: HTTP + WebSocket
        └─ public/           the page
```

| File | Responsibility |
| --- | --- |
| `src/runner.ts` | the only place that touches a subprocess or a fixture |
| `src/translate.ts` | the reducer — the only place that knows what an event means |
| `src/drive.ts` | one run's lifecycle: messages in, ops out, status at the end |
| `src/server.ts` | HTTP, WebSocket, static files, auth |
| `public/md.js` | a small Markdown renderer that escapes before it emits |
| `public/app.js` | draws nodes, applies incremental updates |

The server reduces each raw event and forwards only the resulting `Op`s, so the
page never re-renders the whole trajectory. It also keeps one live run state per
turn, so reloading the page mid-run rebuilds the view instead of losing it.

## The seven required features

| Feature | Where |
| --- | --- |
| Submit a prompt | composer in `index.html`; `POST /api/turns` |
| Trajectory live | `translate.applyEvent` emits a `node` op per event; `app.placeNode` appends it |
| Tool results | `foldResult` keeps a 12-line / 1200-char preview plus the full text, so folding is reversible |
| Status, per call and per run | `tool_use.id` ↔ `tool_result.tool_use_id` pairing; `pending` / `ok` / `error`, and `running` / `finished` / `failed` |
| Continue the conversation | the result event's `session_id` is carried to the next turn as `--resume` |
| The run's numbers | `total_cost_usd`, `duration_ms`, `num_turns` from the result event |
| The trajectory as a tree | `parent_tool_use_id` nests a subagent's events under its call; the outline rail sits beside the dialogue and hides below 1024px |

Beyond the required set: a stop button, a redaction pass over all displayed text,
a "chatter counter" that folds counting-only events, click-to-jump outline
entries, auto-collapse for long subagent runs, and deep links
(`/?replay=<fixture>`) that render a recorded stream on load.

## Two things the stream does that shaped the design

**Most events carry no information.** In one recorded run, 200 of 207 events were
`system/thinking_tokens`. Rendering them would bury the trajectory, so they become
a single counter. `system/hook_started` and `system/hook_response` are treated the
same way, and unknown event types are ignored rather than drawn.

**The delegating tool is called `Agent`, not `Task`.** The documentation for
feature 7 names `Task`; current builds emit `Agent`. Both are handled.

## Recorded streams (replay)

`fixtures/` holds real runs, so the rendering can be developed and checked
without spending a run. Point `--replay` at one, or use the dev panel at the
bottom of the page.

| Fixture | What it shows |
| --- | --- |
| `basic.jsonl` | a short run with one Bash call and its result |
| `subagent.jsonl` | an `Agent` call with 12 tool calls nested under it |
| `failure.jsonl` | a run that failed, with the CLI's error message |
| `powershell-utf16.jsonl` | a run saved by PowerShell, i.e. **UTF-16LE** |

Replay is a development affordance and is restricted to files inside
`fixtures/`. It is not a substitute for a live run: it cannot show events
arriving late, and its session ids are not resumable.

## Exposure

The page is a remote control for a process that reads files and runs commands,
so it binds to `127.0.0.1` by default. If you reach it from another machine, pass
`--token $(openssl rand -hex 16)` and keep the token out of the repository; every
request without it gets a 401. Point the agent at a scratch directory rather than
your home directory — the page shows everything it reads.

By default the server passes `--dangerously-skip-permissions`, which is the right
choice only for a scratch directory. For anything else, start it with
`--no-skip-permissions`.
