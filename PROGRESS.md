# Progress checkpoint — CS2680 assignment 1 (Part 2, the frontend)

> **This file is for the machine, not for a reader.** It is a working checkpoint:
> what state the build is in, what is verified, what is broken, what is still
> outstanding. It is written to be picked up later — by the next session, by
> `git log`, or by an agent — and it assumes you already know the project. The
> human-facing document is **`README.md`**; keep the two in sync when either changes.

Last updated: 2026-10-22. Kept deliberately, at the user's request.

## State

`bun test` → **84 pass**, 0 fail, 158 expect() calls, 5 files.
`bunx tsc --noEmit` → clean.

Ten commits on `master`, **all pushed** to `github.com/as13546/assignment1`
(`90aa740` is the newest). Nothing outstanding in the working tree except the
untracked `.claude/` (local hook state, unrelated to the project).

**The frontend was cut back to a read-only viewer on 2026-10-22.** The backend
still drives Claude Code end to end; the page no longer exposes the controls for
it. Read "Assignment feature status" below before demoing — this is the single
most important thing in this file.

## Files

| Path | What |
| --- | --- |
| `src/runner.ts` | the only place that spawns a process; dispatches the three data sources (live / fixture / conversation) |
| `src/lines.ts` | BOM-aware line splitting (the UTF-16LE PowerShell trap), `countLines`, streaming `readLines` |
| `src/transcript.ts` | reads this machine's Claude Code conversations and rewrites them into the event stream the reducer understands |
| `src/translate.ts` | the reducer — the only place that knows what an event means |
| `src/drive.ts` | one run's lifecycle: messages in, ops out, final status |
| `src/server.ts` | `Bun.serve`: HTTP, WebSocket, static, optional token, the conversation permission switch |
| `src/types.ts` | node / op / raw event types |
| `public/index.html`, `app.js`, `style.css` | the page (two columns) |
| `public/md.js` | hand-written Markdown renderer; escapes first, refuses `javascript:` hrefs |
| `public/workflow.js` | **deleted** 2026-10-22 along with the Workflow view |
| `fixtures/` | four real recorded runs (see README) |
| `tests/` | 84 tests; `tests/helpers/fake-claude.mjs` exercises the real spawn path, `tests/transcript.test.ts` the conversation reader |
| `scripts/smoke-replay.mjs` | headless check over the real WebSocket |
| `scripts/check-workbench.py` | end-to-end check: permission gate, conversation list, rendering a conversation |
| `scripts/capture-*.py` | Playwright screenshot helpers |

Sibling directories: `H:/init_claude/demo-repo` (the Python `logparse` the agent
works on, with two deliberately failing tests), `H:/init_claude/test_events`.

## Assignment feature status — read this

Backend support for all seven features is intact and tested. What changed on
2026-10-22 is the **UI**, and three features lost their primary surface:

| Feature | Backend | Page |
| --- | --- | --- |
| 1 submit a prompt | `POST /api/turns` works | **composer removed** — only reachable via the API |
| 2 live trajectory | works | works |
| 3 tool results | works | works |
| 4 status per call and per run | works | works |
| 5 continue the conversation | `--resume` works | **no UI** — `resumeSessionId` has no caller left |
| 6 run numbers | works | works |
| 7 trajectory tree | nesting works | tree works; **the outline beside the dialogue was removed** |

Two options, and this is a judgement call for the user, not for me:

- **Restore a minimal composer** (prompt box + Run) and an outline column. Costs
  the clean look, but puts features 1, 5 and 7 back where a grader can see them.
- **Keep the viewer.** Defensible as "beyond the required features" work, but the
  demo video then cannot show features 1, 5 or 7 happening live.

Feature 6 also needs a caveat in any screenshot: imported conversations show real
duration and turn count but **no dollar cost**, because a transcript records no
pricing. Only live runs have `total_cost_usd`.

## Verified

### Live runs

- Subagent run: 444 events, 1 root `Agent` call with 12 tool calls nested under it.
  Cost $0.418326, 38.3 s, 2 turns.
- Plain run after the `drive.ts` refactor: `finished`, Bash call ok, numbers from
  the result event.
- All four fixtures replay through the HTTP + WebSocket path.

### This machine's real conversations

- 30 conversations listed from `~/.claude/projects` after consent, newest first,
  each with turns / calls / tokens / cwd / first prompt.
- Opening one: 30 tool calls rendered on the stage.
- Consent gates it for real: nothing is read before `grant`, and after `revoke`
  `GET /api/sessions` answers 403.

### Stale

`.shots/` holds screenshots from **before** the simplification
(`workflow-*.png`, `conversation-flow.png`, `wb-*.png`). They show UI that no
longer exists. Re-capture before using any of them in the writeup or the demo.

## Change log

### UI simplification (2026-10-22, commit `90aa740`)

The page was cut back to a two-column Codex-style layout. Removed: brand
title/subtitle, the outline rail, the Conversation/Workflow tab switcher, the
status bar, and the entire bottom composer (prompt, Run, Stop, resume note).
Kept: the logo, Chatter toggle, theme switch, Clear, connection indicator, the
conversation list, and the trajectory view.

### Workbench build (2026-10-18 → 10-22, commits `4595336`, `8db7859`, `307d855`)

- Three-column layout: Conversations | Outline | stage, with a
  `Conversation` / `Workflow` switch and a persistent status bar.
- `public/workflow.js` drew one run as a vertical lifecycle diagram.
- The bottom dev replay panel was deleted; `/?replay=<fixture>` and
  `scripts/smoke-replay.mjs` still cover replay.
- The conversation list was built: consent gate, transcripts as the source of
  truth, rows showing time / turns / calls / tokens / cwd / first prompt.

### Traps hit while building the conversation list

1. **The `.claude` hook's `events.jsonl` is a lossy custom format**, not the CLI's
   stream — only `init` / `tool_result`, no assistant text, no result event. The
   first version listed those files and every conversation replayed as an empty
   stage. The real records are the transcripts under
   `~/.claude/projects/<project>/<session-id>.jsonl`.
2. **Transcripts are not `stream-json`.** `src/transcript.ts` rewrites the
   envelope: `message.content` blocks are already the shapes the reducer wants,
   but human turns must be re-emitted as `system/user_prompt`, which is why a new
   `prompt` node kind exists.
3. **Cost is not in a transcript.** See the caveat above.

## Bugs found and fixed

1. `readStderr()` was called as a function though it was an already-started
   promise; every live run was marked failed despite succeeding.
2. stderr overwrote the agent's own error message. Precedence is now
   agent result > stderr > exit code.
3. `drive.ts` built notice nodes for unparsed stdout but never added them to the
   run state, so a reload lost them.
4. A failed run offered to resume a session id that did not exist.
5. `javascript:` links in agent output became clickable. Caught by a test.
6. The delegating tool is `Agent`, not `Task` as the assignment text says.
7. The agent's own replies were rendered as prompts. `humanPrompt()` only checked
   `origin.kind`, and assistant records have no `origin`; it now requires
   `entry.type === 'user'`. Covered by `tests/transcript.test.ts`.
8. The workflow diagram rebuilt itself on every event, so all cards restarted
   their fade-in and the diagram looked permanently grey. Gone with the view.
9. `Stop sharing` was rendered inside the element that only exists when permission
   has *not* been granted, so the button could never be seen.
10. Listing conversations took 7.7 s: every line of 80 MB was `JSON.parse`d. Cheap
    string tests decide what is worth parsing, and mtime replaces reading to the
    tail — 3.8 s now, with a "Reading conversations…" state and a 15 s cache.
11. A prompt recorded twice in a row rendered twice. Identical consecutive
    prompts now collapse, unless the agent acted in between.
12. `init` was emitted before any assistant record had named the model, so
    imported runs showed no model. It now waits for the first assistant record.

## Remaining work

1. **Decide the feature-1/5/7 question above** — restore the composer and outline,
   or accept the viewer. This drives everything else in the demo.
2. **Re-capture screenshots.** Everything in `.shots/` predates the
   simplification.
3. **Record the demo video** (2–3 minutes). It needs a *live* run: replay cannot
   show events arriving late, and an imported transcript cannot show a real
   session resume.
4. **Suggested live demo tasks** against `demo-repo`: "find the bug that makes
   `test_parse` fail and fix it", "add a `--json` flag to the CLI and update the
   README", "use a subagent to survey this directory". `demo-repo` has 2 failing
   tests from one cause: values containing spaces inside double quotes are split
   on spaces.
5. **The writeup (Part 3) is the user's own work** — the assignment penalises an
   AI-written one. First-hand material: the UTF-16LE/PowerShell trap; the stderr
   deadlock; 200 of 207 events being `system/thinking_tokens` noise; the
   delegating tool being `Agent` not `Task`; the hook's `events.jsonl` being a
   lossy format; and a transcript having no cost record.
6. **`demo-repo` has one local commit and no remote.** The assignment wants it
   usable as the agent's target.
7. **Collaborators.** The private repo needs the instructor and four TFs invited.
   There is no `gh` on this machine, so this was never verified.

## Traps to remember

- PowerShell `>` redirection writes **UTF-16LE** and mangles non-ASCII on the way
  out, so a fixture recorded that way has permanently broken emoji.
- A piped stdin makes the CLI wait 3 s before starting a turn; the runner passes
  `stdin: 'ignore'`.
- The `.claude` hook writes an `events.jsonl` into whatever directory the agent
  runs in. **Do not build anything on those files** — see trap 1 above.
- Grepping for a URL fragment like `replay=` will mislead you: the deep link is
  written as `params.get('replay')`. It is present.

## How to run

```bash
cd H:/init_claude/assignment1
bun test
bun run src/server.ts --cwd H:/init_claude/demo-repo    # http://127.0.0.1:5173
bun run scripts/smoke-replay.mjs subagent.jsonl         # headless check of the data path
```

```powershell
# Workbench checks (need the server already running):
python scripts/check-workbench.py http://127.0.0.1:5173
python scripts/capture-conversation.py http://127.0.0.1:5173
```

Point the conversation list elsewhere with `--session-dirs "H:/a,H:/b"`
(default `~/.claude/projects`).
