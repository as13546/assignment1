import fs from 'node:fs';
import path from 'node:path';
import { buildArgs, type TurnRequest } from './runner.ts';
import { driveRun } from './drive.ts';
import { createRunState } from './translate.ts';
import { defaultTranscriptRoot, listTranscripts, type TranscriptInfo } from './transcript.ts';
import type { RunState } from './types.ts';

const PUBLIC_DIR = path.resolve(import.meta.dir, '..', 'public');
const FIXTURES_DIR = path.resolve(import.meta.dir, '..', 'fixtures');

interface Run {
  id: string;
  prompt: string;
  cwd: string;
  argv: string[];
  resumedFrom: string | null;
  replayed: string | null;
  startedAt: number;
  state: RunState;
  abort: AbortController;
  done: boolean;
}

interface Config {
  port: number;
  hostname: string;
  token: string | null;
  defaultCwd: string;
  claudeBin: string;
  skipPermissionsDefault: boolean;
  replayDelayMs: number;
  sessionScanRoots: string[];
}

function parseArgs(argv: string[]): Config {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const defaultCwd = path.resolve(get('--cwd') ?? process.cwd());
  const roots = (get('--session-dirs') ?? process.env.SESSION_DIRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
  if (!roots.length) {
    // Claude Code keeps every conversation under the user's home directory.
    roots.push(defaultTranscriptRoot());
  }
  return {
    port: Number(get('--port') ?? process.env.PORT ?? 5173),
    hostname: get('--host') ?? '127.0.0.1',
    token: get('--token') ?? process.env.DEMO_TOKEN ?? null,
    defaultCwd,
    claudeBin: get('--claude') ?? process.env.CLAUDE_BIN ?? 'claude',
    skipPermissionsDefault: !argv.includes('--no-skip-permissions'),
    replayDelayMs: Number(get('--replay-delay') ?? 30),
    sessionScanRoots: [...new Set(roots)],
  };
}

const config = parseArgs(process.argv.slice(2));
const runs = new Map<string, Run>();

const clients = new Set<Bun.ServerWebSocket<unknown>>();

let sessionsGranted = false;

// Summarising a transcript means reading it, so the result is cached briefly:
// switching tabs must not re-read every conversation on disk.
let sessionCache: { at: number; sessions: TranscriptInfo[] } | null = null;
const SESSION_CACHE_MS = 15_000;

async function scanSessions(): Promise<TranscriptInfo[]> {
  if (sessionCache && Date.now() - sessionCache.at < SESSION_CACHE_MS) {
    return sessionCache.sessions;
  }
  const sessions = await listTranscripts(config.sessionScanRoots);
  sessionCache = { at: Date.now(), sessions };
  return sessions;
}

/**
 * Reading another conversation is the most sensitive thing this page can do,
 * so it happens only after the user presses Allow, and only inside the roots
 * the server was pointed at.
 */
function isUnderRoots(file: string): boolean {
  const resolved = path.resolve(file);
  return config.sessionScanRoots.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

function resolveSession(id: string): string | null {
  const file = Buffer.from(id, 'base64url').toString('utf8');
  if (!isUnderRoots(file)) return null;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

function send(ws: Bun.ServerWebSocket<unknown>, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    clients.delete(ws);
  }
}

function broadcast(payload: unknown): void {
  for (const ws of [...clients]) send(ws, payload);
}

/** A run in the shape the browser needs to rebuild its view from scratch. */
function runSnapshot(run: Run) {
  return {
    runId: run.id,
    prompt: run.prompt,
    cwd: run.cwd,
    argv: run.argv,
    resumedFrom: run.resumedFrom,
    replayed: run.replayed,
    startedAt: run.startedAt,
    done: run.done,
    state: run.state,
  };
}

/**
 * The page is a remote control for a process that reads files and runs
 * commands, so when it is reachable beyond localhost there is a token in
 * front of every request (the assignment asks for exactly this).
 */
function authorized(req: Request, url: URL): boolean {
  if (!config.token) return true;
  const query = url.searchParams.get('token');
  if (query && timingSafeEqual(query, config.token)) return true;
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.replace(/^Bearer\s+/i, '');
  if (bearer && timingSafeEqual(bearer, config.token)) return true;
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function serveStatic(urlPath: string): Response {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, rel);
  // Refuse anything that escapes public/.
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    return new Response('forbidden', { status: 403 });
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return new Response('not found', { status: 404 });
  }
  return new Response(Bun.file(resolved), {
    headers: { 'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream' },
  });
}

function listFixtures(): string[] {
  try {
    return fs.readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Replay is a development affordance, so it must not become an arbitrary file
 * reader: only files inside fixtures/ are allowed.
 */
function resolveFixture(name: string): string | null {
  const resolved = path.resolve(FIXTURES_DIR, name);
  if (!resolved.startsWith(FIXTURES_DIR + path.sep)) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

function startRun(body: Record<string, unknown>): { runId: string } | { error: string } {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const replayFile = typeof body.replayFile === 'string' && body.replayFile ? body.replayFile : null;

  if (!prompt && !replayFile) return { error: 'a prompt is required' };

  let replayPath: string | null = null;
  if (replayFile) {
    replayPath = resolveFixture(replayFile);
    if (!replayPath) return { error: `unknown fixture: ${replayFile}` };
  }
  const sessionFile = typeof body.sessionFile === 'string' && body.sessionFile
    ? resolveSession(body.sessionFile)
    : null;
  if (typeof body.sessionFile === 'string' && body.sessionFile && !sessionFile) {
    return { error: 'unknown session' };
  }

  const cwd = typeof body.cwd === 'string' && body.cwd.trim()
    ? path.resolve(body.cwd.trim())
    : config.defaultCwd;

  const resumeSessionId = typeof body.resumeSessionId === 'string' && body.resumeSessionId
    ? body.resumeSessionId
    : null;

  const req: TurnRequest = {
    prompt,
    cwd,
    resumeSessionId,
    replayFile: replayPath,
    transcriptFile: sessionFile,
    replayDelayMs: config.replayDelayMs,
    skipPermissions: body.skipPermissions === undefined
      ? config.skipPermissionsDefault
      : Boolean(body.skipPermissions),
    allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools.map(String) : undefined,
    claudeBin: config.claudeBin,
    timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
  };

  const id = crypto.randomUUID();
  const run: Run = {
    id,
    prompt,
    cwd: req.cwd,
    argv: replayPath
      ? ['replay', path.relative(FIXTURES_DIR, replayPath)]
      : sessionFile
      ? ['conversation', path.basename(sessionFile)]
      : [config.claudeBin, ...buildArgs(req).map((arg, i) => (i === 0 ? '<prompt>' : arg))],
    resumedFrom: resumeSessionId,
    replayed: replayPath
      ? path.relative(FIXTURES_DIR, replayPath)
      : sessionFile
      ? path.basename(sessionFile)
      : null,
    startedAt: Date.now(),
    state: createRunState(),
    abort: new AbortController(),
    done: false,
  };
  runs.set(id, run);

  broadcast({ kind: 'run_started', run: runSnapshot(run) });
  void driveRun(run, req, {
    emit: (ops) => {
      if (ops.length) broadcast({ kind: 'ops', runId: run.id, ops });
    },
    end: () => {
      run.done = true;
      broadcast({ kind: 'run_end', runId: run.id });
    },
  });
  return { runId: id };
}

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,

  async fetch(req, srv) {
    const url = new URL(req.url);

    if (!authorized(req, url)) {
      return new Response('unauthorized: missing or bad token', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      });
    }

    if (url.pathname === '/ws') {
      if (srv.upgrade(req)) return undefined;
      return new Response('expected a websocket upgrade', { status: 400 });
    }

    if (url.pathname === '/api/config') {
      return Response.json({
        defaultCwd: config.defaultCwd,
        claudeBin: config.claudeBin,
        skipPermissions: config.skipPermissionsDefault,
        fixtures: listFixtures(),
        sessionsGranted,
        sessions: sessionsGranted ? await scanSessions() : [],
        runs: [...runs.values()].map(runSnapshot),
      });
    }

    if (url.pathname === '/api/sessions/grant' && req.method === 'POST') {
      sessionsGranted = true;
      return Response.json({ granted: true });
    }

    if (url.pathname === '/api/sessions/revoke' && req.method === 'POST') {
      sessionsGranted = false;
      return Response.json({ granted: false });
    }

    if (url.pathname === '/api/sessions') {
      if (!sessionsGranted) {
        return Response.json({ granted: false, sessions: [] }, { status: 403 });
      }
      return Response.json({ granted: true, sessions: await scanSessions() });
    }

    if (url.pathname === '/api/turns' && req.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 });
      }
      const result = startRun(body);
      if ('error' in result) return Response.json(result, { status: 400 });
      return Response.json(result, { status: 202 });
    }

    if (url.pathname.startsWith('/api/turns/') && url.pathname.endsWith('/stop') && req.method === 'POST') {
      const id = url.pathname.slice('/api/turns/'.length, -'/stop'.length);
      const run = runs.get(id);
      if (!run) return Response.json({ error: 'unknown run' }, { status: 404 });
      run.abort.abort();
      return Response.json({ stopped: true });
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    return serveStatic(url.pathname);
  },

  websocket: {
    open(ws) {
      clients.add(ws as Bun.ServerWebSocket<unknown>);
      // Rebuild the view for a page that loaded (or reloaded) mid-run.
      send(ws as Bun.ServerWebSocket<unknown>, {
        kind: 'snapshot',
        runs: [...runs.values()].map(runSnapshot),
      });
    },
    message() {
      // The page only listens; prompts arrive over POST /api/turns.
    },
    close(ws) {
      clients.delete(ws as Bun.ServerWebSocket<unknown>);
    },
  },
});

const url = `http://${config.hostname}:${server.port}`;
console.log(`assignment1 frontend  ${url}${config.token ? `?token=${config.token}` : ''}`);
console.log(`  working directory default : ${config.defaultCwd}`);
console.log(`  claude binary             : ${config.claudeBin}`);
console.log(`  auto-approve (skip perms) : ${config.skipPermissionsDefault ? 'yes' : 'no'}`);
console.log(`  fixtures                  : ${listFixtures().join(', ') || '(none)'}`);
