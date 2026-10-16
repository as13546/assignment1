# Progress checkpoint — CS2680 assignment 1 (Part 2, the frontend)

Last updated: 2026-10-16. Working file, not a deliverable — delete before submitting.

## State: the seven features are built and verified against real runs

`bun test` → 78 pass, 0 fail. `bunx tsc --noEmit` → clean.

## Files

| Path | What |
| --- | --- |
| `src/runner.ts` | spawn or replay; byte-level line splitting with UTF-16LE BOM detection |
| `src/translate.ts` | the reducer: noise folding, tool pairing, subagent tree, redaction |
| `src/drive.ts` | one run's lifecycle and final status |
| `src/server.ts` | `Bun.serve`: HTTP, WebSocket, static, optional token |
| `public/md.js` | hand-written Markdown renderer, escapes first, refuses `javascript:` hrefs |
| `public/index.html`, `app.js`, `style.css` | the page |
| `fixtures/` | four real recorded runs (see README) |
| `tests/` | 78 tests, including the spawn path via `tests/helpers/fake-claude.mjs` |
| `scripts/smoke-replay.mjs` | headless end-to-end check over the real WebSocket |

Sibling directories: `H:/init_claude/demo-repo` (the Python `logparse` the agent works
on, with two deliberately failing tests), `H:/init_claude/test_events` (the user's
recorded run).

## Verified live, not just in tests

- Subagent run: 444 events, 1 root `Agent` call with 12 tool calls nested under it,
  `subagent_stats.spawned: 1`. Cost $0.418326, 38.3 s, 2 turns.
- Plain run after the `drive.ts` refactor: status `finished`, Bash call ok, numbers
  from the result event.
- All four fixtures replay through the HTTP + WebSocket path.
- Three headless Chrome screenshots of the rendered page: normal run, subagent run,
  failed run.

## Bugs found and fixed along the way

1. `readStderr()` was called as a function though it was an already-started promise.
   Every live run was marked failed despite succeeding. Now covered by a test whose
   stand-in binary writes 1 MB to stderr, so a reader that drains stderr late hangs.
2. stderr overwrote the agent's own error message. Error precedence is now
   agent result > stderr > exit code.
3. `drive.ts` built notice nodes for unparsed stdout lines but never added them to
   the run state, so a reload lost them.
4. A failed run offered to resume a session id that did not exist.
5. `javascript:` links in agent output became clickable. Caught by a test.
6. The delegating tool is `Agent`, not `Task` as the assignment text says.

## Remaining work

1. **Commit and push.** Both `assignment1/` and `demo-repo/` have `git init` and
   everything staged, but **nothing is committed**. Then create the private GitHub
   repo and invite the instructor and four TFs.
2. **Record the demo video** (2–3 minutes) showing all seven features, including a
   failing run and a run that spawns a subagent. This needs a *live* run — replay
   cannot demonstrate events arriving late or session resume.
3. **Suggested live demo tasks** against `demo-repo`: "find the bug that makes
   `test_parse` fail and fix it" (read → run pytest → edit), "add a `--json` flag to
   the CLI and update the README", "use a subagent to survey this directory".
   `demo-repo` currently has 2 failing tests from one cause: values containing
   spaces inside double quotes are split on spaces.
4. **The writeup (Part 3) is the user's own work.** The assignment penalises an
   AI-written one. Material worth writing about, all observed first-hand:
   the UTF-16LE/PowerShell trap; the stderr deadlock; 200 of 207 events being
   `system/thinking_tokens` noise; the delegating tool being `Agent` not `Task`;
   and how much of a run is the agent reading files you would not have opened.
5. **Delete this file** before submitting.

## Traps to remember

- PowerShell `>` redirection writes **UTF-16LE** and mangles non-ASCII on the way
  out, so a fixture recorded that way has permanently broken emoji.
- The user's `.claude` hook writes an `events.jsonl` into whatever directory the
  agent runs in. Both repos ignore it; `assignment1/events.jsonl` was 1.4 MB.
- A piped stdin makes the CLI wait 3 s before starting a turn; the runner passes
  `stdin: 'ignore'`.

## How to run

```bash
cd H:/init_claude/assignment1
bun test
bun run src/server.ts --cwd H:/init_claude/demo-repo    # http://127.0.0.1:5173
bun run scripts/smoke-replay.mjs subagent.jsonl         # headless check of the data path
```
