import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Changes } from '../src/server/changes.js';
import { excludeFromGit } from '../src/server/config.js';
import { landedWorkers } from '../src/server/leave-on-merge.js';
import { Ledger } from '../src/server/usage.js';
import { WorkerManager, relatedBlock, repoSources, withRelated, workspaceNames, type LinkedCheckout, type RepoSource, type WorkerEvents } from '../src/server/workers.js';
import type { LiveSession, ProcessProbe } from '../src/server/sessions.js';
import { Worktrees } from '../src/server/worktrees.js';
import type { ChangesState, GhPull, WorkerInfo } from '../src/shared/protocol.js';
import { MEETING_SEATS } from '../src/shared/layout.js';

// A worker across repositories (WorkerInfo.repos): hired on one floor with other floors' projects,
// it works in a workspace holding a worktree of each, all on one branch, and opens a PR in each.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A checkout of github.com/acme/<name> whose pushes land in a local bare repository instead. */
function project(root: string, name: string): string {
  const bare = path.join(root, 'remotes', `${name}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const dir = path.join(root, 'projects', name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`);
  git(dir, 'config', `url.${bare}.pushInsteadOf`, `https://github.com/acme/${name}.git`);
  git(dir, 'push', '-q', 'origin', 'main');
  excludeFromGit(dir);
  return dir;
}

/** Records where it was started and whether git finds a repository there, then waits. */
const fakeAgent = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
let top = null;
try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ cwd: process.cwd(), ceiling: process.env.GIT_CEILING_DIRECTORIES, top }) + '\\n');
setInterval(() => {}, 1000);
`;

/** Pull requests kept in $GH_STATE: list, create, view (the body) and edit (the body). */
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const file = process.env.GH_STATE;
const st = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { prs: [] };
const a = process.argv.slice(2);
const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const repo = () => execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim().replace(/^https:\\/\\/github\\.com\\//, '').replace(/\\.git$/, '');
const done = (out, code = 0) => { fs.writeFileSync(file, JSON.stringify(st)); process.stdout.write(out); process.exit(code); };
if (a[0] === 'pr' && a[1] === 'list') done(JSON.stringify(st.prs.filter((p) => p.repo === repo() && p.head === opt('--head') && p.state === 'OPEN').slice(0, 1).map((p) => ({ number: p.number, url: p.url }))));
if (a[0] === 'pr' && a[1] === 'create') {
  const r = repo();
  const number = st.prs.filter((p) => p.repo === r).length + 1;
  const url = 'https://github.com/' + r + '/pull/' + number;
  st.prs.push({ repo: r, number, url, head: opt('--head'), base: opt('--base'), title: opt('--title'), body: opt('--body'), state: 'OPEN' });
  done(url + '\\n');
}
const pr = st.prs.find((p) => p.url === a[2]);
if (a[0] === 'pr' && a[1] === 'view' && pr) done(pr.body + '\\n');
if (a[0] === 'pr' && a[1] === 'edit' && pr) { pr.body = opt('--body'); done(''); }
done('', 1);
`;

interface Fixture {
  root: string;
  a: string;
  b: string;
  c: string;
  log: string;
  agent: string;
  ghState: string;
  starts(): { cwd: string; ceiling?: string; top: string | null }[];
  prs(): { repo: string; number: number; url: string; head: string; base?: string; title: string; body: string }[];
}

function fixture(t: { after(fn: () => void): void }): Fixture {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-office-repos-')));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const agent = path.join(bin, 'fake-agent');
  writeFileSync(agent, fakeAgent, { mode: 0o755 });
  writeFileSync(path.join(bin, 'gh'), fakeGh, { mode: 0o755 });
  // The task namer asks `claude -p`: not the real one.
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const log = path.join(root, 'starts.jsonl');
  writeFileSync(log, '');
  const ghState = path.join(root, 'gh.json');
  const saved = { PATH: process.env.PATH, FAKE_AGENT_LOG: process.env.FAKE_AGENT_LOG, GH_STATE: process.env.GH_STATE };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
  process.env.FAKE_AGENT_LOG = log;
  process.env.GH_STATE = ghState;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    a: project(root, 'web'),
    b: project(root, 'api'),
    c: project(root, 'admin'),
    log,
    agent,
    ghState,
    starts: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    prs: () => (existsSync(ghState) ? JSON.parse(readFileSync(ghState, 'utf8')).prs : []),
  };
}

const events: WorkerEvents = { update() {}, remove() {}, data() {}, screen() {}, toast() {} };

function manager(f: Fixture, t: { after(fn: () => void): void }): WorkerManager {
  const data = path.join(f.a, '.agent-office');
  mkdirSync(data, { recursive: true });
  const workers = new WorkerManager(f.a, data, f.agent, [], { url: 'http://127.0.0.1:1', token: '' }, events, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
  t.after(() => workers.shutdown());
  return workers;
}

const source = (floor: string, dir: string): RepoSource => ({ floor, name: path.basename(dir), repo: `acme/${path.basename(dir)}`, dir });

async function waitFor<T>(read: () => T, ok: (v: T) => boolean, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  let v = read();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    v = read();
  }
  assert.ok(ok(v), 'timed out');
  return v;
}

test('a worker across repositories gets a workspace with a worktree of each on one branch, and starts in it', async (t) => {
  const f = fixture(t);
  const workers = manager(f, t);
  const w = workers.spawn('desk-1', 'Cody', undefined, true, 'agent', undefined, undefined, undefined, undefined, undefined, [source('floor-api', f.b), source('floor-admin', f.c)]);
  assert.equal(typeof w, 'object', String(w));
  if (typeof w === 'string') return;
  const slug = w.worktree!.branch.replace(/^office\//, '');
  const ws = path.join(f.a, '.agent-office', 'worktrees', slug);
  assert.equal(w.worktree!.path, path.join('.agent-office', 'worktrees', slug, 'web'));
  assert.deepEqual(w.repos!.map((r) => [r.floor, r.name, r.path, r.branch, r.from]), [
    ['floor-api', 'api', path.join('.agent-office', 'worktrees', slug, 'api'), w.worktree!.branch, 'main'],
    ['floor-admin', 'admin', path.join('.agent-office', 'worktrees', slug, 'admin'), w.worktree!.branch, 'main'],
  ]);
  // Each is a worktree of its own repository, on the worker's branch.
  for (const [name, dir] of [['web', f.a], ['api', f.b], ['admin', f.c]]) {
    assert.equal(git(path.join(ws, name), 'rev-parse', '--abbrev-ref', 'HEAD'), w.worktree!.branch);
    assert.equal(realpathSync(path.resolve(path.join(ws, name), git(path.join(ws, name), 'rev-parse', '--git-common-dir'))), realpathSync(path.join(dir, '.git')));
  }
  // The brief says which folder is which, for Claude (CLAUDE.md) and the others (AGENTS.md).
  const brief = readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8');
  assert.equal(readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), brief);
  for (const line of ['`web/`: acme/web, cut from main', '`api/`: acme/api, cut from main', '`admin/`: acme/admin', w.worktree!.branch, 'acme/web#12']) assert.ok(brief.includes(line), line);
  assert.ok(!brief.includes('{{'), brief);

  // It starts in the workspace, where git finds no repository (not the web floor's own checkout).
  const [start] = await waitFor(() => f.starts(), (s) => s.length === 1);
  assert.equal(realpathSync(start.cwd), ws);
  assert.equal(start.top, null);
  assert.equal(start.ceiling, path.dirname(ws));

  // It comes back with them after a restart.
  workers.shutdown();
  const again = manager(f, t);
  assert.deepEqual(again.get(w.id)?.repos?.map((r) => r.name), ['api', 'admin']);
});

test('hiring across repositories needs its own worktree and different repositories, and leaves nothing behind when it fails', async (t) => {
  const f = fixture(t);
  const workers = manager(f, t);
  const hire = (repos: RepoSource[], worktree = true) => workers.spawn('desk-1', 'Cody', undefined, worktree, 'agent', undefined, undefined, undefined, undefined, undefined, repos);
  assert.match(String(hire([source('floor-api', f.b)], false)), /own worktree/);
  // Another checkout of the web repository is still the web repository.
  const twin = path.join(f.root, 'web-twin');
  git(f.a, 'worktree', 'add', '-q', twin, '-b', 'twin');
  assert.match(String(hire([source('floor-twin', twin)])), /same repository/);
  assert.match(String(hire([source('floor-api', f.b), source('floor-api-2', f.b)])), /same repository/);
  const plain = path.join(f.root, 'projects', 'notes');
  mkdirSync(plain);
  assert.match(String(hire([source('floor-notes', plain)])), /isn't a git checkout/);

  // api can't have the branch (one of that name is there already): web's new worktree and branch are taken out again.
  const before = git(f.a, 'branch', '--list', 'office/*');
  git(f.b, 'branch', 'office/sprocket-0000');
  const failed = (workers as any).makeWorkspace('sprocket-0000', [source('floor-api', f.b)]);
  assert.match(String(failed), /^api: Could not create a git worktree/);
  await waitFor(() => git(f.a, 'branch', '--list', 'office/sprocket-0000'), (out) => out === '');
  assert.equal(git(f.a, 'branch', '--list', 'office/*'), before);
  await waitFor(() => existsSync(path.join(f.a, '.agent-office', 'worktrees', 'sprocket-0000')), (there) => !there);
  assert.equal(git(f.b, 'branch', '--list', 'office/sprocket-0000'), 'office/sprocket-0000', "api's own branch stays");
});

test('sending a worker across repositories home checks every worktree, and deletes them all and its workspace', async (t) => {
  const f = fixture(t);
  const workers = manager(f, t);
  const hire = () => workers.spawn('desk-1', 'Cody', undefined, true, 'agent', undefined, undefined, undefined, undefined, undefined, [source('floor-api', f.b)]) as WorkerInfo;
  const w = hire();
  const ws = path.join(f.a, '.agent-office', 'worktrees', w.worktree!.branch.slice('office/'.length));
  writeFileSync(path.join(ws, 'api', 'server.js'), 'wip\n');
  const state = await workers.inspectWorktree(w.id);
  assert.deepEqual(state?.repos?.map((r) => [r.name, r.state.dirty]), [['web', 0], ['api', 1]]);
  assert.equal(state?.dirty, 1);
  // Nobody said what to do, and api holds work: everything stays.
  const kept = await workers.kill(w.id);
  assert.match(kept.note ?? '', /Kept .*worktrees and branch office\/\S+ in web, api — api has 1 uncommitted change/);
  assert.ok(existsSync(path.join(ws, 'api', 'server.js')));

  const w2 = hire();
  const ws2 = path.join(f.a, '.agent-office', 'worktrees', w2.worktree!.branch.slice('office/'.length));
  const done = await workers.kill(w2.id, 'all');
  assert.match(done.note ?? '', /Deleted .*worktrees and branch office\/\S+ in web, api/);
  assert.equal(existsSync(ws2), false);
  assert.equal(git(f.a, 'branch', '--list', w2.worktree!.branch), '');
  assert.equal(git(f.b, 'branch', '--list', w2.worktree!.branch), '');
});

test('O opens a pull request in each repository with commits, and each one lists them all', async (t) => {
  const f = fixture(t);
  const workers = manager(f, t);
  const w = workers.spawn('desk-1', 'Cody', 'Work on GitHub issue #12: "Sign in with passkeys".', true, 'agent', undefined, undefined, undefined, undefined, undefined, [source('floor-api', f.b), source('floor-admin', f.c)]) as WorkerInfo;
  const ws = path.join(f.a, '.agent-office', 'worktrees', w.worktree!.branch.slice('office/'.length));
  await waitFor(() => workers.get(w.id)?.status, (s) => s !== 'starting');
  // Work in web and api; nothing in admin.
  for (const name of ['web', 'api']) {
    writeFileSync(path.join(ws, name, 'passkeys.js'), `// ${name}\n`);
    git(path.join(ws, name), 'add', '-A');
    git(path.join(ws, name), 'commit', '-q', '-m', `Passkeys in ${name}`);
  }
  (workers as any).workers.get(w.id).info.status = 'done';
  const r = await workers.openPr(w.id, 'Cody');
  assert.equal(typeof r, 'object', String(r));
  if (typeof r === 'string') return;
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.prs.map((p) => [p.repo, p.number, p.existed]), [['web', 1, false], ['api', 1, false]]);
  const prs = f.prs();
  const web = prs.find((p) => p.repo === 'acme/web')!;
  const api = prs.find((p) => p.repo === 'acme/api')!;
  assert.equal(prs.length, 2);
  assert.equal(web.base, 'main');
  assert.equal(web.title, 'Sign in with passkeys');
  // The issue is web's: its PR closes it, api's only points at it.
  assert.match(web.body, /\nCloses #12\n/);
  assert.match(api.body, /\nPart of acme\/web#12\n/);
  assert.doesNotMatch(api.body, /Closes/);
  for (const p of [web, api]) {
    assert.match(p.body, /One change across 2 repositories/);
    assert.ok(p.body.includes('**web**: acme/web#1') && p.body.includes('**api**: acme/api#1'), p.body);
    assert.ok(p.body.includes(`${p.repo}#1 (this one)`));
  }
  // Pushed to each repository's origin.
  for (const name of ['web', 'api']) assert.ok(git(path.join(f.root, 'remotes', `${name}.git`), 'rev-parse', w.worktree!.branch));
  assert.deepEqual(workers.get(w.id)?.pr, { number: 1, url: 'https://github.com/acme/web/pull/1' });
  assert.deepEqual(workers.get(w.id)?.repos?.map((x) => x.pr?.url), ['https://github.com/acme/api/pull/1', undefined]);

  // Later, admin gets work too: O again opens its PR and brings every list up to date.
  writeFileSync(path.join(ws, 'admin', 'passkeys.js'), '// admin\n');
  git(path.join(ws, 'admin'), 'add', '-A');
  git(path.join(ws, 'admin'), 'commit', '-q', '-m', 'Passkeys in admin');
  const again = await workers.openPr(w.id, 'Cody');
  if (typeof again === 'string') return assert.fail(again);
  assert.deepEqual(again.prs.map((p) => [p.repo, p.existed]), [['web', true], ['api', true], ['admin', false]]);
  for (const p of f.prs()) {
    assert.match(p.body, /One change across 3 repositories/);
    assert.equal(p.body.split('agent-office:related').length, 3, 'one list, replaced rather than added again');
  }
});

test('the list of related pull requests goes in once and is replaced after', () => {
  const block = relatedBlock([{ repo: 'web', url: 'https://github.com/acme/web/pull/3' }, { repo: 'api', url: 'https://github.com/acme/api/pull/9' }], 'https://github.com/acme/api/pull/9', 'office/pip-1');
  assert.match(block, /- \*\*web\*\*: acme\/web#3\n- \*\*api\*\*: acme\/api#9 \(this one\)/);
  const once = withRelated('## Task\n\nDo it\n', block);
  assert.equal(once, `## Task\n\nDo it\n\n${block}`);
  const newer = relatedBlock([{ repo: 'web', url: 'https://github.com/acme/web/pull/3' }], 'x', 'office/pip-1');
  assert.equal(withRelated(`${once}\n\nsigned`, newer), `## Task\n\nDo it\n\n${newer}\n\nsigned`);
  assert.equal(withRelated('', block), block);
});

test("each checkout's folder in a workspace is named after it, once", () => {
  assert.deepEqual(workspaceNames(['/p/acme/web', '/p/other/web', '/p/acme/api', '/x/.hidden', '/y/AGENTS.md', '/z/my repo']), ['web', 'web-2', 'api', 'hidden', 'AGENTS.md-repo', 'my-repo']);
});

test('the Changes window follows each repository of a worker across repositories against its own branch', async (t) => {
  const f = fixture(t);
  const wt = new Worktrees(f.b).create('pip-1', 'api', f.a);
  if (typeof wt === 'string') return assert.fail(wt);
  const cwd = path.join(f.a, wt.path);
  writeFileSync(path.join(cwd, 'new.js'), 'x\n');
  const states: ChangesState[] = [];
  // The web floor's office was opened on a branch api doesn't have: api's diff is against its own main.
  const changes = new Changes(f.a, 'trunk', (id, repo) => (id === 'w1' && repo === 'floor-api' ? { name: 'Pip', cwd, rel: wt.path, worktreeBase: wt.base, baseBranch: 'main', openPull: () => ({ number: 4, url: 'u' }) } : undefined), () => undefined, {
    state: (s) => states.push(s),
    toast() {},
    refreshGitHub() {},
  });
  t.after(() => changes.stop());
  changes.watch('w1', 'c1', 'floor-api');
  const [s] = await waitFor(() => states, (x) => x.length > 0);
  assert.equal(s.repo, 'floor-api');
  assert.equal(s.branch, 'office/pip-1');
  assert.equal(s.base, 'main');
  assert.equal(s.prBase, 'main');
  assert.deepEqual(s.pr, { number: 4, url: 'u' });
  assert.deepEqual(s.files.map((x) => [x.path, x.status]), [['new.js', '?']]);
  assert.equal(await changes.commit('w1', 'Add new.js', 'Cody', undefined, 'floor-api'), undefined);
  assert.equal(git(cwd, 'log', '-1', '--format=%s'), 'Add new.js');
  // Its own floor's checkout is a different target.
  assert.equal(await changes.diff('w1', 'new.js'), 'No such worker');
});

test('prune leaves a workspace with worktrees in it alone, and lists the other repository’s branch as checked out elsewhere', async (t) => {
  const f = fixture(t);
  const web = new Worktrees(f.a);
  const api = new Worktrees(f.b);
  assert.equal(typeof web.create('pip-1', 'web'), 'object');
  assert.equal(typeof api.create('pip-1', 'api', f.a), 'object');
  const listed = await web.list();
  assert.deepEqual(listed.worktrees.map((w) => [w.path, w.branch]), [[path.join('.agent-office', 'worktrees', 'pip-1', 'web'), 'office/pip-1']]);
  assert.deepEqual(listed.strays, []);
  const theirs = await api.list();
  assert.deepEqual(theirs.worktrees, []);
  assert.deepEqual([...theirs.elsewhere], [['office/pip-1', path.join(f.a, '.agent-office', 'worktrees', 'pip-1', 'api')]]);
});

const pull = (number: number, state: string, headRefName: string, headRefOid?: string): GhPull => ({
  number, title: `PR ${number}`, state, isDraft: false, url: '', author: '', labels: [], reviewDecision: '',
  headRefName, headRefOid, baseRefName: 'main', createdAt: '', updatedAt: '', additions: 0, deletions: 0,
  checks: 'none', body: '', closes: [],
});

test('a worker across repositories goes home once its pull requests have merged and none is open, on any floor', () => {
  const w: WorkerInfo = {
    id: 'pip', kind: 'agent', deskId: 'desk-1', name: 'Pip', color: '#fff', status: 'done', acked: true, createdBy: 't', createdAt: 0, cols: 80, rows: 24, viewers: [],
    worktree: { path: '.agent-office/worktrees/pip-1/web', branch: 'office/pip-1', base: 'a' },
    repos: [{ floor: 'api', name: 'api', dir: '/api', path: '.agent-office/worktrees/pip-1/api', branch: 'office/pip-1', base: 'b', pr: { number: 9, url: '' } }],
  };
  const web = [pull(3, 'MERGED', 'office/pip-1', 'h3')];
  const floors = (api: GhPull[] | undefined) => (id: string) => (id === 'api' ? api : undefined);
  // api's PR still open, or not on api's list (yet): it stays.
  assert.deepEqual(landedWorkers([w], web, [], floors([pull(9, 'OPEN', 'office/pip-1')])), []);
  assert.deepEqual(landedWorkers([w], web, [], floors([])), []);
  assert.deepEqual(landedWorkers([w], web, [], floors(undefined)), []);
  // Both merged: it goes, with each merged head.
  assert.deepEqual(landedWorkers([w], web, [], floors([pull(9, 'MERGED', 'office/pip-1', 'h9')])), [{ worker: w, pr: 3, head: 'h3', heads: { api: 'h9' }, prs: ['web #3', 'api #9'] }]);
  // Only api had work: its PR merging is enough.
  const apiOnly = { ...w, repos: [{ ...w.repos![0] }] };
  assert.deepEqual(landedWorkers([apiOnly], [], [], floors([pull(9, 'MERGED', 'office/pip-1', 'h9')])).map((l) => l.prs), [['api #9']]);
  // web's own PR open: it stays.
  assert.deepEqual(landedWorkers([w], [pull(3, 'OPEN', 'office/pip-1')], [], floors([pull(9, 'MERGED', 'office/pip-1')])), []);
});

// A floor with more than one repository (see FloorLink): web's floor has api's checkout linked to it,
// so workers are hired in api there, and Claude sessions in api's checkout sit at web's desks.

const apiLink = (f: Fixture): LinkedCheckout => ({ id: 'api', name: 'api', repo: 'acme/api', dir: f.b });

function linkedManager(f: Fixture, t: { after(fn: () => void): void }, links: LinkedCheckout[] = [apiLink(f)], probe?: ProcessProbe): WorkerManager {
  const data = path.join(f.a, '.agent-office');
  mkdirSync(data, { recursive: true });
  const workers = new WorkerManager(f.a, data, f.agent, [], { url: 'http://127.0.0.1:1', token: '' }, events, new Ledger(data, { pauseHiring: false }, () => {}, () => {}), undefined, undefined, undefined, probe, links);
  t.after(() => workers.shutdown());
  return workers;
}

test('a worker hired in a linked checkout has its worktree cut from that repository, kept with the floor’s, and its PR there', async (t) => {
  const f = fixture(t);
  const workers = linkedManager(f, t);
  const w = workers.spawn('desk-1', 'Cody', 'Work on GitHub issue #7: "Rate limits".', true, 'agent', undefined, undefined, undefined, undefined, undefined, [], 'api');
  assert.equal(typeof w, 'object', String(w));
  if (typeof w === 'string') return;
  assert.equal(w.checkout, 'api');
  const slug = w.worktree!.branch.replace(/^office\//, '');
  const wt = path.join(f.a, '.agent-office', 'worktrees', slug);
  assert.equal(w.worktree!.path, path.join('.agent-office', 'worktrees', slug));
  // A worktree of api's repository, on the worker's branch, in web's .agent-office; nothing in api's checkout.
  assert.equal(realpathSync(path.resolve(wt, git(wt, 'rev-parse', '--git-common-dir'))), realpathSync(path.join(f.b, '.git')));
  assert.equal(git(f.b, 'branch', '--list', '--format=%(refname:short)', w.worktree!.branch), w.worktree!.branch);
  assert.equal(git(f.a, 'branch', '--list', '--format=%(refname:short)', w.worktree!.branch), '');
  assert.ok(!existsSync(path.join(f.b, '.agent-office')), 'nothing is written into the linked checkout');
  const [start] = await waitFor(() => f.starts(), (s) => s.length === 1);
  assert.equal(realpathSync(start.cwd), realpathSync(wt));

  // O pushes to api's origin and opens the pull request there.
  writeFileSync(path.join(wt, 'limits.js'), '// limits\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'Rate limits');
  (workers as any).workers.get(w.id).info.status = 'done';
  const r = await workers.openPr(w.id, 'Cody');
  assert.equal(typeof r, 'object', String(r));
  assert.deepEqual(f.prs().map((p) => [p.repo, p.head, p.base]), [['acme/api', w.worktree!.branch, 'main']]);
  assert.match(f.prs()[0].body, /\nCloses #7\n/);
  assert.deepEqual(workers.get(w.id)?.pr, { number: 1, url: 'https://github.com/acme/api/pull/1' });
  assert.equal((await workers.inspectWorktree(w.id))?.exists, true);

  // Sending it home looks in api's repository: its commit is on api's origin now, so worktree and branch go.
  const home = await workers.kill(w.id);
  assert.equal(home.note, `Deleted ${w.name}'s worktree and branch ${w.worktree!.branch}`);
  assert.ok(!existsSync(wt));
  assert.equal(git(f.b, 'branch', '--list', '--format=%(refname:short)', w.worktree!.branch), '');
});

test('a meeting called in a linked checkout seats its workers there, in a worktree of that repository kept with the floor’s', async (t) => {
  const f = fixture(t);
  const workers = linkedManager(f, t);
  assert.equal((workers.checkoutHome(undefined) as { dir: string }).dir, f.a);
  assert.equal(workers.checkoutHome('web'), "web isn't on this floor any more");
  const home = workers.checkoutHome('api');
  assert.equal(typeof home, 'object', String(home));
  if (typeof home === 'string') return;
  assert.equal(home.dir, f.b);
  assert.equal(home.link?.id, 'api');
  assert.deepEqual(home.at, { dir: realpathSync(f.b), repo: 'acme/api' });
  // The meeting's worktree, as the meeting room makes it: cut from api, kept in web's .agent-office.
  const made = home.trees.create('meeting-x-0000', undefined, f.a);
  assert.equal(typeof made, 'object', String(made));
  if (typeof made === 'string') return;
  const { note: _note, ...worktree } = made;
  assert.equal(worktree.path, path.join('.agent-office', 'worktrees', 'meeting-x-0000'));
  const wt = path.join(f.a, worktree.path);
  assert.equal(realpathSync(path.resolve(wt, git(wt, 'rev-parse', '--git-common-dir'))), realpathSync(path.join(f.b, '.git')));
  assert.equal(home.ref(worktree).path, path.relative(f.b, wt));

  // Seated at the table in api: it runs in the meeting's worktree and says it works in api.
  const w = workers.spawn(MEETING_SEATS[0].id, 'Ada (meeting)', 'Talk it through.', false, 'agent', undefined, undefined, undefined, { id: 'm1', worktree }, undefined, [], 'api');
  assert.equal(typeof w, 'object', String(w));
  if (typeof w === 'string') return;
  assert.equal(w.checkout, 'api');
  assert.equal(w.meeting, 'm1');
  const [start] = await waitFor(() => f.starts(), (s) => s.length === 1);
  assert.equal(realpathSync(start.cwd), realpathSync(wt));
  // A board agent still works in the floor's own checkout.
  assert.match(String(workers.spawn('station-issues', 'Ada', 'Triage.', false, 'agent', undefined, undefined, undefined, undefined, undefined, [], 'api')), /floor's own checkout/);
  // Going home, a worker at the meeting table leaves the worktree to the meeting, which tidies it away in api's repository.
  assert.deepEqual(await workers.kill(w.id), {});
  assert.ok(existsSync(wt));
  assert.equal(await home.trees.remove(home.ref(worktree), 'all'), undefined);
  assert.ok(!existsSync(wt));
  assert.equal(git(f.b, 'branch', '--list', '--format=%(refname:short)', worktree.branch), '');

  // Linked again under another id, the same repository is found by what it is; gone, it isn't.
  workers.setLinks([{ ...apiLink(f), id: 'api-2' }]);
  assert.equal((workers.checkoutHome('api', home.at) as { link?: LinkedCheckout }).link?.id, 'api-2');
  workers.setLinks([]);
  assert.equal(workers.checkoutHome('api-2', home.at), "api-2 isn't on this floor any more");
});

test('a worker in a linked checkout without a worktree runs there, and comes back only while the floor still has it', async (t) => {
  const f = fixture(t);
  const workers = linkedManager(f, t);
  const w = workers.spawn('desk-1', 'Cody', undefined, false, 'agent', undefined, undefined, undefined, undefined, undefined, [], 'api') as WorkerInfo;
  assert.equal(w.checkout, 'api');
  const [start] = await waitFor(() => f.starts(), (s) => s.length === 1);
  assert.equal(realpathSync(start.cwd), realpathSync(f.b));
  assert.match(String(workers.spawn('desk-2', 'Cody', undefined, false, 'agent', undefined, undefined, undefined, undefined, undefined, [], 'nope')), /isn't on this floor/);
  assert.match(String(workers.spawn('station-queue', 'Cody', 'queue it', false, 'agent', undefined, undefined, undefined, undefined, undefined, [], 'api')), /floor's own checkout/);
  assert.deepEqual(workers.onCheckout('api'), [w.name]);

  // workers.json keeps which checkout it's in.
  workers.shutdown();
  const saved = JSON.parse(readFileSync(path.join(f.a, '.agent-office', 'workers.json'), 'utf8')) as { id: string; checkout?: string }[];
  assert.equal(saved.find((s) => s.id === w.id)?.checkout, 'api');
  const again = linkedManager(f, t);
  assert.equal(again.get(w.id)?.checkout, 'api');
  again.shutdown();
  // A floor that no longer has that checkout keeps it, but never in its own checkout instead (see stranded).
  const without = linkedManager(f, t, []);
  assert.match(String(without.stranded(w.id)), /works in api, which isn't on this floor any more/);
  without.shutdown();
  // An older workers.json, with no checkout at all, is the floor's own as before.
  writeFileSync(path.join(f.a, '.agent-office', 'workers.json'), JSON.stringify(saved.map(({ checkout: _, ...s }) => s)));
  const older = linkedManager(f, t);
  assert.equal(older.get(w.id)?.checkout, undefined);
});

test('a Claude session in a terminal in a linked checkout sits at the floor’s desks, working in that checkout', async (t) => {
  const f = fixture(t);
  const alive = new Set([51001, 51002, 51003]);
  const probe: ProcessProbe = { alive: (pid) => alive.has(pid), startedAt: () => undefined, parent: () => undefined };
  const workers = linkedManager(f, t, [apiLink(f)], probe);
  const live = (pid: number, cwd: string): LiveSession => ({ pid, sessionId: `s-${pid}`, cwd, startedAt: 1790709600377 });
  const own = workers.spawn('desk-1', 'Cody', undefined, true, 'agent', undefined, undefined, undefined, undefined, undefined, [], 'api') as WorkerInfo;
  workers.syncTerminals([
    live(51001, path.join(f.b, 'src')),
    live(51002, f.a),
    // In the office's own worktree of api, kept in web's .agent-office: the office's worker, not a terminal's.
    live(51003, path.join(f.a, own.worktree!.path)),
  ], () => undefined);
  const seated = workers.list().filter((w) => w.external);
  assert.deepEqual(seated.map((w) => [w.external!.pid, w.checkout]).sort(), [[51001, 'api'], [51002, undefined]]);

  // It comes back after a restart with the folder it ran in, which is one of the floor's.
  workers.shutdown();
  const again = linkedManager(f, t, [apiLink(f)], probe);
  const back = again.list().find((w) => w.external?.pid === 51001);
  assert.equal(back?.checkout, 'api');
  assert.equal((again as any).workers.get(back!.id).terminal.cwd, path.join(f.b, 'src'));
});

test('a worker hired in a linked checkout can work in the floor’s own repository too, in one workspace', async (t) => {
  const f = fixture(t);
  const workers = linkedManager(f, t);
  // The floor's own checkout, by its floor (no checkout), as "🗂️ Also work in" sends it.
  const w = workers.spawn('desk-1', 'Cody', undefined, true, 'agent', undefined, undefined, undefined, undefined, undefined, [{ floor: 'web', name: 'web', repo: 'acme/web', dir: f.a }], 'api') as WorkerInfo;
  assert.equal(typeof w, 'object', String(w));
  const slug = w.worktree!.branch.replace(/^office\//, '');
  const ws = path.join(f.a, '.agent-office', 'worktrees', slug);
  assert.equal(w.worktree!.path, path.join('.agent-office', 'worktrees', slug, 'api'));
  assert.deepEqual(w.repos!.map((r) => [r.floor, r.checkout, r.name, r.dir]), [['web', undefined, 'web', f.a]]);
  for (const [name, dir] of [['api', f.b], ['web', f.a]]) {
    assert.equal(realpathSync(path.resolve(path.join(ws, name), git(path.join(ws, name), 'rev-parse', '--git-common-dir'))), realpathSync(path.join(dir, '.git')));
  }
  assert.ok(readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8').includes('`api/`: acme/api'));
  // The same repository twice is refused, as across floors.
  assert.match(String(workers.spawn('desk-2', 'Cody', undefined, true, 'agent', undefined, undefined, undefined, undefined, undefined, [{ floor: 'web', checkout: 'api', name: 'api', dir: f.b }], 'api')), /same repository/);
  // Sending it home clears both worktrees and the workspace.
  const home = await workers.kill(w.id);
  assert.match(String(home.note), /^Deleted .*'s worktrees and branch/);
  assert.ok(!existsSync(ws));
});

test('a worker whose linked repository is off the floor stays at its desk, terminal and worktree kept, until it’s back', async (t) => {
  const f = fixture(t);
  const first = linkedManager(f, t);
  await first.start();
  const w = first.spawn('desk-1', 'Cody', undefined, true, 'agent', undefined, undefined, undefined, undefined, undefined, [], 'api') as WorkerInfo;
  await waitFor(() => f.starts(), (s) => s.length === 1);
  // The office restarts; its terminal keeps running in the host.
  first.shutdown(true);

  // Back without api on the floor (taken off and added again by an older office, say).
  const off = linkedManager(f, t, []);
  await off.start();
  const why = `${w.name} works in api, which isn't on this floor any more — add it back to carry on`;
  assert.equal(off.stranded(w.id), why);
  assert.equal(off.get(w.id)?.activity, why);
  assert.equal(off.resume(w.id), why);
  assert.deepEqual(await off.kill(w.id), { error: why });
  assert.ok(off.get(w.id), 'still at its desk');
  assert.equal((await off.inspectWorktree(w.id))?.error, why);
  assert.deepEqual(await off.openPr(w.id, 'Cody'), why);
  // Nothing of api's or the floor's own was touched, and workers.json still has it, terminal and all.
  assert.equal(git(f.b, 'branch', '--list', '--format=%(refname:short)', w.worktree!.branch), w.worktree!.branch);
  assert.ok(existsSync(path.join(f.a, w.worktree!.path)));
  const saved = (JSON.parse(readFileSync(path.join(f.a, '.agent-office', 'workers.json'), 'utf8')) as { id: string; checkout?: string; checkoutName?: string; pty?: { id: string } }[]).find((x) => x.id === w.id);
  assert.deepEqual([saved?.checkout, saved?.checkoutName, !!saved?.pty?.id], ['api', 'api', true]);
  assert.equal(f.starts().length, 1, 'nothing was started again');

  // api is back: so is the worker, on the terminal that kept running.
  off.setLinks([apiLink(f)]);
  await waitFor(() => off.get(w.id)?.status, (s) => s !== 'offline');
  assert.equal(off.stranded(w.id), undefined);
  assert.equal(f.starts().length, 1, 'picked its terminal back up rather than starting another');
});

test('repoSources looks each repository up as the building has it now', () => {
  const dirs: Record<string, { name: string; repo?: string; dir: string }> = { feyer: { name: 'feyer', dir: '/p/feyer' }, 'feyer:feyer-app': { name: 'feyer-app', repo: 'acme/feyer-app', dir: '/p/feyer-app' } };
  const find = (at: { floor: string; checkout?: string }) => dirs[at.checkout ? `${at.floor}:${at.checkout}` : at.floor];
  assert.deepEqual(repoSources(['feyer:feyer-app'], 'feyer', find), [{ floor: 'feyer', checkout: 'feyer-app', name: 'feyer-app', repo: 'acme/feyer-app', dir: '/p/feyer-app' }]);
  assert.match(String(repoSources(['feyer'], 'feyer', find)), /own project/);
  // Gone since the hire dialog listed it.
  delete dirs['feyer:feyer-app'];
  assert.match(String(repoSources(['feyer:feyer-app'], 'feyer', find)), /no longer in the building/);
});

test('a worker’s PR closes an issue in another of the floor’s repositories by naming it', async (t) => {
  const f = fixture(t);
  const workers = linkedManager(f, t);
  const w = workers.spawn('desk-1', 'Cody', 'Work on GitHub issue acme/web#9: "Shared login".', true, 'agent', undefined, undefined, undefined, undefined, undefined, [], 'api') as WorkerInfo;
  const wt = path.join(f.a, w.worktree!.path);
  await waitFor(() => workers.get(w.id)?.status, (s) => s !== 'starting');
  writeFileSync(path.join(wt, 'login.js'), '// login\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'Shared login');
  (workers as any).workers.get(w.id).info.status = 'done';
  assert.equal(typeof (await workers.openPr(w.id, 'Cody')), 'object');
  const [pr] = f.prs();
  assert.equal(pr.repo, 'acme/api');
  assert.equal(pr.title, 'Shared login');
  assert.match(pr.body, /\nCloses acme\/web#9\n/);

  // Its own repository's issue, named the same way, needs no name.
  const own = workers.spawn('desk-2', 'Cody', 'Work on GitHub issue acme/api#4: "Rate limits".', true, 'agent', undefined, undefined, undefined, undefined, undefined, [], 'api') as WorkerInfo;
  const owt = path.join(f.a, own.worktree!.path);
  await waitFor(() => workers.get(own.id)?.status, (s) => s !== 'starting');
  writeFileSync(path.join(owt, 'limits.js'), '// limits\n');
  git(owt, 'add', '-A');
  git(owt, 'commit', '-q', '-m', 'Rate limits');
  (workers as any).workers.get(own.id).info.status = 'done';
  assert.equal(typeof (await workers.openPr(own.id, 'Cody')), 'object');
  assert.match(f.prs()[1].body, /\nCloses #4\n/);
});

test('a worker whose repository went only comes back for that same repository, under whatever name it’s linked again', async (t) => {
  const f = fixture(t);
  const first = linkedManager(f, t);
  const w = first.spawn('desk-1', 'Cody', undefined, true, 'agent', undefined, undefined, undefined, undefined, undefined, [], 'api') as WorkerInfo;
  await waitFor(() => f.starts(), (s) => s.length === 1);
  first.shutdown();
  const saved = (JSON.parse(readFileSync(path.join(f.a, '.agent-office', 'workers.json'), 'utf8')) as { id: string; checkoutAt?: { dir: string; repo?: string } }[]).find((x) => x.id === w.id);
  assert.deepEqual(saved?.checkoutAt, { dir: realpathSync(f.b), repo: 'acme/api' });

  const off = linkedManager(f, t, []);
  // Another repository linked under the same id isn't its.
  off.setLinks([{ id: 'api', name: 'admin', repo: 'acme/admin', dir: f.c }]);
  assert.ok(off.stranded(w.id));
  assert.deepEqual(off.onCheckout('api'), [], "that id's new repository has nobody working in it");
  // Its own repository, linked as api-2: it works in that one now.
  off.setLinks([{ id: 'api', name: 'admin', repo: 'acme/admin', dir: f.c }, { id: 'api-2', name: 'api', repo: 'acme/api', dir: f.b }]);
  assert.equal(off.stranded(w.id), undefined);
  assert.equal(off.get(w.id)?.checkout, 'api-2');
  await waitFor(() => f.starts(), (s) => s.length === 2);
});

test('an admin can forget a worker whose repository went: its worktree and branch stay for prune, its terminal ends', async (t) => {
  const f = fixture(t);
  const first = linkedManager(f, t);
  await first.start();
  const w = first.spawn('desk-1', 'Cody', undefined, true, 'agent', undefined, undefined, undefined, undefined, undefined, [], 'api') as WorkerInfo;
  await waitFor(() => f.starts(), (s) => s.length === 1);
  first.shutdown(true);
  const savedPty = () => (JSON.parse(readFileSync(path.join(f.a, '.agent-office', 'workers.json'), 'utf8')) as { id: string; pty?: { id: string; pid?: number } }[]).find((x) => x.id === w.id)?.pty;
  const pid = savedPty()?.pid;
  assert.ok(pid, 'the terminal’s process is kept with it');

  const off = linkedManager(f, t, [], { alive: (p) => p === pid, startedAt: () => undefined, parent: () => undefined });
  await off.start();
  // Its terminal's Claude, still running, is the office's own: it isn't seated again as someone's terminal.
  off.syncTerminals([{ pid: pid!, sessionId: 'its-own', cwd: f.a, startedAt: 1 }], () => undefined);
  assert.deepEqual(off.list().filter((x) => x.external), []);

  assert.match(String(off.forget('nope')), /No such worker/);
  const r = off.forget(w.id);
  assert.equal(typeof r, 'object', String(r));
  const wt = path.join(f.a, w.worktree!.path);
  assert.match((r as { note: string }).note, new RegExp(`^Forgot ${w.name}: its worktree ${wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} and branch ${w.worktree!.branch} are still there — run agent-office prune`));
  assert.equal(off.get(w.id), undefined);
  assert.ok(existsSync(wt), 'its worktree is left');
  assert.equal(git(f.b, 'branch', '--list', '--format=%(refname:short)', w.worktree!.branch), w.worktree!.branch, 'and its branch');
  assert.equal(savedPty(), undefined);
  assert.ok(!(JSON.parse(readFileSync(path.join(f.a, '.agent-office', 'workers.json'), 'utf8')) as { id: string }[]).some((x) => x.id === w.id));
  // Its terminal goes.
  await waitFor(() => { try { process.kill(pid!, 0); return true; } catch { return false; } }, (alive) => !alive);
});

test('only a worker whose repository went can be forgotten', async (t) => {
  const f = fixture(t);
  const workers = linkedManager(f, t);
  const w = workers.spawn('desk-1', 'Cody', undefined, false, 'agent', undefined, undefined, undefined, undefined, undefined, [], 'api') as WorkerInfo;
  assert.match(String(workers.forget(w.id)), /send it home as usual/);
  assert.ok(workers.get(w.id));
});
