import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { descendsFrom, liveClaudeSessions, pidAlive, realProcesses, sameProcess, sessionTitle, transcriptPath, type ProcessProbe } from '../src/server/sessions.js';

function configDir(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-sessions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'sessions'));
  return dir;
}

/** A pid nothing has: a child's, once it has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.ok(child.pid);
  return child.pid;
}

const entry = (pid: number, sessionId: string, cwd: string, extra: Record<string, unknown> = {}) => ({ pid, sessionId, cwd, startedAt: 1790709600377, version: '2.1.284', kind: 'interactive', entrypoint: 'cli', name: 'feyer-c2', ...extra });

test("Claude's session registry gives the sessions still running, and nothing it can't make sense of", (t) => {
  const dir = configDir(t);
  const at = (file: string, body: unknown) => writeFileSync(path.join(dir, 'sessions', file), typeof body === 'string' ? body : JSON.stringify(body));
  const me = process.pid;
  const gone = deadPid();
  at(`${me}.json`, entry(me, '95b74a8e-8105-4d27-bf22-bb310e39460d', '/Users/x/Projects/feyer'));
  at(`${me}.7320337b289ef44fff90ac0e25ef22f70c3c0664875b9764305dce0e699717d4.key`, 'not json');
  at(`${gone}.json`, entry(gone, 'dead-session', '/Users/x/Projects/feyer'));
  at('1.json', '{"pid":1,"sessionId":'); // half-written
  at('2.json', entry(3, 'wrong-file', '/Users/x/Projects/feyer')); // not its own file
  at('4.json', entry(4, 'relative', 'Projects/feyer'));
  at('5.json', entry(5, 'printed', '/Users/x/Projects/feyer', { kind: 'print' }));
  at('6.json', entry(6, '../../etc', '/Users/x/Projects/feyer'));

  assert.equal(pidAlive(me), true);
  assert.equal(pidAlive(gone), false);
  assert.equal(pidAlive(0), false);
  const live = liveClaudeSessions(dir);
  assert.deepEqual(live, [{ pid: me, sessionId: '95b74a8e-8105-4d27-bf22-bb310e39460d', cwd: '/Users/x/Projects/feyer', startedAt: 1790709600377, version: '2.1.284', name: 'feyer-c2', procStart: undefined }]);

  // Liveness is asked of the process: with every pid alive, only the malformed ones stay out.
  const everyone: ProcessProbe = { alive: () => true, startedAt: () => undefined, parent: () => undefined };
  assert.deepEqual(liveClaudeSessions(dir, everyone)!.map((s) => s.sessionId).sort(), ['95b74a8e-8105-4d27-bf22-bb310e39460d', 'dead-session']);
  assert.deepEqual(liveClaudeSessions(dir, everyone, 'dead-session')!.map((s) => s.pid), [gone]);
  // A registry that can't be read says nothing, which isn't the same as nothing running.
  assert.equal(liveClaudeSessions(path.join(dir, 'nowhere')), null);
  rmSync(path.join(dir, 'sessions'), { recursive: true });
  mkdirSync(path.join(dir, 'sessions'));
  assert.deepEqual(liveClaudeSessions(dir), []);
});

test("a session's title is the first thing typed into it, not Claude Code's own messages", (t) => {
  const dir = configDir(t);
  const cwd = '/Users/x/Projects/Develogix/feyer';
  const file = transcriptPath(dir, cwd, 'abc');
  assert.equal(file, path.join(dir, 'projects', '-Users-x-Projects-Develogix-feyer', 'abc.jsonl'));
  assert.equal(sessionTitle(dir, cwd, 'abc'), undefined, 'no transcript yet');

  mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    { type: 'mode', mode: 'normal', sessionId: 'abc' },
    { type: 'attachment', attachment: { type: 'hook_success', content: 'x'.repeat(2000) } },
    { type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '  Fix the\nlogin   page so it remembers who you are, and add a test for the remember-me box please' }] } },
    { type: 'user', message: { role: 'user', content: 'a later message' } },
  ];
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const title = sessionTitle(dir, cwd, 'abc')!;
  assert.ok(title.startsWith('Fix the login page so it remembers who you are'), title);
  assert.ok(title.length <= 60 && title.endsWith('…'), title);

  // Nobody has typed anything near the top of it.
  writeFileSync(file, `${JSON.stringify({ type: 'attachment', content: 'y'.repeat(100_000) })}\n${JSON.stringify(lines[4])}\n`);
  assert.equal(sessionTitle(dir, cwd, 'abc'), undefined);
});

test("a pid that's come round again for another process isn't the session's, and a process's parents are followed up", () => {
  // Claude Code writes when its process started without a time zone, in UTC.
  const started = Date.parse('Tue Sep 29 19:19:59 2026 UTC');
  const probe = (at: number | undefined): ProcessProbe => ({ alive: (pid) => pid === 7, startedAt: () => at, parent: () => undefined });
  assert.equal(sameProcess(7, 'Tue Sep 29 19:19:59 2026', probe(started + 1000)), true);
  assert.equal(sameProcess(7, 'Tue Sep 29 19:19:59 2026', probe(started + 3600_000)), false, 'started an hour later: another process');
  assert.equal(sameProcess(7, 'Tue Sep 29 19:19:59 2026', probe(undefined)), true, "can't tell (no ps): taken as the same");
  assert.equal(sameProcess(7, undefined, probe(started)), true);
  assert.equal(sameProcess(8, undefined, probe(started)), false, 'gone');
  // The real ps agrees about this process.
  const me = realProcesses.startedAt(process.pid);
  if (me !== undefined) {
    assert.ok(Math.abs(me - (Date.now() - process.uptime() * 1000)) < 5000);
    assert.equal(sameProcess(process.pid, new Date(me).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.*) GMT$/, '$1 $3 $2 $5 $4'), realProcesses), true);
    assert.equal(realProcesses.parent(process.pid), process.ppid);
  }

  const parents = new Map([[30, 20], [20, 10], [10, 1]]);
  const tree: Pick<ProcessProbe, 'parent'> = { parent: (pid) => parents.get(pid) };
  assert.equal(descendsFrom(30, new Set([10]), tree), true);
  assert.equal(descendsFrom(30, new Set([30]), tree), true);
  assert.equal(descendsFrom(30, new Set([99]), tree), false);
  assert.equal(descendsFrom(30, new Set([10]), { parent: () => undefined }), false, "parents that can't be told: outside");
});

test("when a process started is asked of ps once, and again only once it's gone", () => {
  let asked = 0;
  const alive = new Set([9]);
  const probe: ProcessProbe = { alive: (pid) => alive.has(pid), startedAt: () => (asked++, Date.parse('Tue Sep 29 19:19:59 2026 UTC')), parent: () => undefined };
  for (let i = 0; i < 5; i++) assert.equal(sameProcess(9, 'Tue Sep 29 19:19:59 2026', probe), true);
  assert.equal(asked, 1);
  alive.delete(9);
  assert.equal(sameProcess(9, 'Tue Sep 29 19:19:59 2026', probe), false);
  alive.add(9);
  assert.equal(sameProcess(9, 'Tue Sep 29 19:19:59 2026', probe), true);
  assert.equal(asked, 2, 'a pid seen gone is asked about afresh');
});
