import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code sessions running on the office's machine outside the office: in someone's own terminal,
// in a project that's a floor. Claude Code keeps a registry of its live sessions, a file per process
// in <config>/sessions/<pid>.json saying which conversation it's on and in which folder, and the
// conversation itself in <config>/projects/<the folder, every non-alphanumeric made a '-'>/<id>.jsonl.
// Both are Claude Code's own and may change: everything here is defensive, and anything it can't
// make sense of is left out rather than guessed at.

/** A Claude Code session that's running right now, as its registry file says. */
export interface LiveSession {
  pid: number;
  sessionId: string;
  /** The folder it was started in, absolute. */
  cwd: string;
  /** When it started (ms). */
  startedAt: number;
  /** The Claude Code version running it, when it says. */
  version?: string;
  /** The short name Claude Code gave it ("feyer-c2"), when it has one. */
  name?: string;
  /** When its process started, as Claude Code wrote it ("Tue Sep 29 19:19:59 2026"), to tell it from a later process given the same pid. */
  procStart?: string;
}

/** How a process is looked at: whether it's there, when it started (ms), and its parent. Swapped out by tests. */
export interface ProcessProbe {
  alive(pid: number): boolean;
  /** Undefined when it can't be told (no `ps`, Windows). */
  startedAt(pid: number): number | undefined;
  /** Undefined when it can't be told, or it has none. */
  parent(pid: number): number | undefined;
}

/** The most registry files read in one go: the folder is per machine, not per project. */
const MAX_SESSIONS = 500;
/** How much of a transcript is read for its title: the first message is near the top. */
const TITLE_BYTES = 64 * 1024;
const TITLE_MAX = 60;

/** Where the office's own Claude keeps its sessions: $CLAUDE_CONFIG_DIR, as the workers inherit it, else ~/.claude. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Whether a process is still there. EPERM is someone else's process: it's there, the office just can't signal it. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** When a process started (ms), as `ps` says; undefined when it can't. */
export function processStartedAt(pid: number): number | undefined {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env: { ...process.env, LC_ALL: 'C' } }).trim();
    // Local time, which is how it's read back.
    const at = Date.parse(out);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/** A process's parent, as `ps` says; undefined when it can't. */
export function processParent(pid: number): number | undefined {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return undefined;
  try {
    const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim());
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

export const realProcesses: ProcessProbe = { alive: pidAlive, startedAt: processStartedAt, parent: processParent };

/** How far up a process's parents are looked through for one of the office's terminals. */
const PARENT_DEPTH = 8;
/** How far apart two start times can be and still be the same process: ps shows whole seconds. */
const START_SLACK_MS = 2000;

/**
 * What `ps` said about a pid and a start time, by probe and then `<pid> <start>`: a process never
 * changes when it started, so asking once a minute is plenty (the office looks every few seconds),
 * and in between only whether the pid is still there is asked.
 */
const verdicts = new WeakMap<ProcessProbe, Map<string, { same: boolean; at: number }>>();
const VERDICT_MS = 60_000;

/**
 * Whether `pid` is still the process that started at `procStart` (as a registry file wrote it). A
 * pid comes round again for something else once its process is gone. When either start time can't
 * be told, it's taken to be the same: being sure it's gone is what lets anything happen to it.
 */
export function sameProcess(pid: number, procStart: string | number | undefined, probe: ProcessProbe = realProcesses): boolean {
  let seen = verdicts.get(probe);
  if (!seen) verdicts.set(probe, (seen = new Map()));
  const key = `${pid} ${procStart ?? ''}`;
  if (!probe.alive(pid)) {
    seen.delete(key);
    return false;
  }
  const known = seen.get(key);
  if (known && Date.now() - known.at < VERDICT_MS) return known.same;
  // Claude Code writes it without a time zone (in UTC, as it turns out): either reading of it will do.
  const then = typeof procStart === 'number' ? [procStart] : procStart ? [Date.parse(`${procStart} UTC`), Date.parse(procStart)].filter(Number.isFinite) : [];
  if (!then.length) return true;
  const now = probe.startedAt(pid);
  const same = now === undefined || then.some((t) => Math.abs(now - t) <= START_SLACK_MS);
  // The verdicts of processes long gone go with the oldest, now and then.
  if (seen.size > 1000) seen.clear();
  seen.set(key, { same, at: Date.now() });
  return same;
}

/** Whether `pid` is one of `roots` or runs under one of them (a few parents up at most). Unknown parents: no. */
export function descendsFrom(pid: number, roots: Set<number>, probe: Pick<ProcessProbe, 'parent'> = realProcesses): boolean {
  let at: number | undefined = pid;
  for (let i = 0; at !== undefined && i <= PARENT_DEPTH; i++) {
    if (roots.has(at)) return true;
    at = probe.parent(at);
  }
  return false;
}

/**
 * Every interactive Claude Code session running on this machine under `configDir`. A registry file
 * outlives a session that crashed, so one whose process is gone (or is some other process by now,
 * with the same pid) is left out; so is a file that isn't one (the <pid>.<hash>.key files beside
 * them) or doesn't parse, and a session that isn't someone's own (`claude -p`, an SDK run). Null when
 * the registry couldn't be read at all, which says nothing about which sessions are running. `only`
 * asks about one conversation.
 */
export function liveClaudeSessions(configDir = claudeConfigDir(), probe: ProcessProbe = realProcesses, only?: string): LiveSession[] | null {
  let files: string[];
  try {
    files = readdirSync(path.join(configDir, 'sessions')).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return null;
  }
  const out: LiveSession[] = [];
  for (const file of files) {
    if (out.length >= MAX_SESSIONS) break;
    try {
      const s = JSON.parse(readFileSync(path.join(configDir, 'sessions', file), 'utf8')) as Record<string, unknown>;
      const { pid, sessionId, cwd, startedAt, version, name, kind } = s;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || `${pid}.json` !== file) continue;
      if (typeof sessionId !== 'string' || !/^[\w-]{1,100}$/.test(sessionId)) continue;
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue;
      if (kind !== undefined && kind !== 'interactive') continue;
      // Just the one conversation asked about: the others' processes needn't be looked at.
      if (only !== undefined && sessionId !== only) continue;
      const procStart = typeof s.procStart === 'string' ? s.procStart.slice(0, 64) : undefined;
      if (!sameProcess(pid, procStart, probe)) continue;
      out.push({
        pid,
        sessionId,
        cwd: path.resolve(cwd),
        startedAt: typeof startedAt === 'number' ? startedAt : 0,
        version: typeof version === 'string' ? version.slice(0, 40) : undefined,
        name: typeof name === 'string' && name.trim() ? name.trim().slice(0, TITLE_MAX) : undefined,
        procStart,
      });
    } catch {
      // half-written, or not one of Claude's
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** Where Claude Code keeps the conversation a session in `cwd` is on. */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/**
 * What a session is about, for its worker's name: the first thing someone typed into it, on one line
 * and cut to about 60 characters. Slash commands, their output and what hooks added don't count.
 * Undefined when there's no transcript yet, or nobody has typed anything near the top of it.
 */
export function sessionTitle(configDir: string, cwd: string, sessionId: string): string | undefined {
  let text: string;
  try {
    const fd = openSync(transcriptPath(configDir, cwd, sessionId), 'r');
    try {
      const buf = Buffer.alloc(TITLE_BYTES);
      const n = readSync(fd, buf, 0, TITLE_BYTES, 0);
      text = buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  for (const line of text.split('\n')) {
    let entry: { type?: unknown; isMeta?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the last line, cut off at the end of what was read
    }
    if (entry?.type !== 'user' || entry.isMeta === true) continue;
    const content = entry.message?.content;
    const said = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text as string).join(' ')
        : '';
    const clean = said.replace(/\s+/g, ' ').trim();
    // <command-name>, <local-command-stdout> and the like: Claude Code's own, not what was typed.
    if (!clean || clean.startsWith('<')) continue;
    return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…` : clean;
  }
  return undefined;
}
