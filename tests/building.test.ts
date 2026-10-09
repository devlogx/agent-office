import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Building, type FloorDef, type FloorLink } from '../src/server/building.js';

function office(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-building-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, '.agent-office');
  mkdirSync(dataDir);
  const floor = (id: string, palette: number): FloorDef => {
    const dir = path.join(root, 'acme', id);
    mkdirSync(dir, { recursive: true });
    return { id, name: id, repo: `acme/${id}`, dir, palette, addedBy: 'Sam', addedAt: 1 };
  };
  const defs = [floor('api', 0), floor('web', 1), floor('docs', 2)];
  writeFileSync(path.join(dataDir, 'floors.json'), JSON.stringify(defs));
  return { root, dataDir, defs };
}

const saved = (dataDir: string) => (JSON.parse(readFileSync(path.join(dataDir, 'floors.json'), 'utf8')) as FloorDef[]).map((d) => d.id);

test('a floor comes off the building and stays off, with its checkout left where it was', (t) => {
  const { root, dataDir, defs } = office(t);
  const building = new Building(dataDir, root);

  const r = building.remove('web');
  assert.equal(typeof r, 'object');
  assert.equal((r as FloorDef).dir, defs[1].dir);
  assert.deepEqual(building.list().map((d) => d.id), ['api', 'docs']);
  assert.deepEqual(saved(dataDir), ['api', 'docs']);
  assert.ok(existsSync(defs[1].dir), 'the checkout stays on disk');

  // After a restart it's still gone.
  assert.deepEqual(new Building(dataDir, root).list().map((d) => d.id), ['api', 'docs']);
});

test("floors that aren't there can't be taken off", (t) => {
  const { root, dataDir } = office(t);
  const building = new Building(dataDir, root);

  assert.equal(building.remove('nope'), 'No such floor');
  assert.deepEqual(saved(dataDir), ['api', 'web', 'docs']);
});

test('the floor the office was started in comes off too, stays off after a restart, and moves back in when its repository is added again', async (t) => {
  const { root, dataDir, defs } = office(t);
  // The office's own checkout, with its GitHub origin (how it's recognised once it's no longer a floor).
  execFileSync('git', ['init', '-q', defs[0].dir]);
  execFileSync('git', ['-C', defs[0].dir, 'remote', 'add', 'origin', 'https://github.com/acme/api.git']);
  const building = new Building(dataDir, root);
  building.ensureLocal(defs[0].dir, 'the office');
  assert.ok(building.isLocal('api'));
  assert.ok(!building.isLocal('web'));

  const r = building.remove('api', 'Sam');
  assert.equal((r as FloorDef).id, 'api');
  assert.ok(!building.isLocal('api'));
  assert.deepEqual(saved(dataDir), ['web', 'docs']);
  assert.ok(existsSync(defs[0].dir), 'the checkout stays on disk');

  // The next start doesn't put it back.
  const again = new Building(dataDir, root);
  assert.equal(again.ensureLocal(defs[0].dir, 'the office'), undefined);
  assert.deepEqual(again.list().map((d) => d.id), ['web', 'docs']);
  assert.deepEqual(saved(dataDir), ['web', 'docs']);

  // Adding acme/api again uses the checkout it always was (no clone, no GitHub needed).
  const started: string[] = [];
  const back = await again.add('https://github.com/acme/api', 'Sam', (d) => started.push(d.dir));
  assert.equal(typeof back, 'object', String(back));
  assert.equal((back as FloorDef).dir, defs[0].dir);
  assert.deepEqual(started, [defs[0].dir]);
  assert.ok(again.isLocal((back as FloorDef).id));
  assert.deepEqual(saved(dataDir), ['web', 'docs', 'api']);
  assert.ok(!existsSync(path.join(dataDir, 'local-floor.json')));

  // ...and it's a floor again at the next start.
  const third = new Building(dataDir, root);
  assert.equal(third.ensureLocal(defs[0].dir, 'the office')?.id, 'api');
  assert.deepEqual(third.list().map((d) => d.id), ['web', 'docs', 'api']);
});

/** A git checkout at `dir`, its origin on GitHub as `repo` (if any). */
function checkout(dir: string, repo?: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  if (repo) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `git@github.com:${repo}.git`]);
}

test('the checkouts in the projects folder are listed two levels down, never inside a checkout, dot-folders or node_modules', (t) => {
  const { root, dataDir, defs } = office(t);
  const projects = path.join(root, 'projects');
  checkout(path.join(projects, 'alpha'), 'acme/alpha');
  checkout(path.join(projects, 'alpha', 'inner'));
  checkout(path.join(projects, 'clients', 'beta'));
  // A worktree of alpha: its .git is a file, and its origin is alpha's.
  const wt = path.join(projects, 'clients', 'gamma');
  mkdirSync(path.join(projects, 'alpha', '.git', 'worktrees', 'gamma'), { recursive: true });
  writeFileSync(path.join(projects, 'alpha', '.git', 'worktrees', 'gamma', 'commondir'), '../..\n');
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(projects, 'alpha', '.git', 'worktrees', 'gamma')}\n`);
  checkout(path.join(projects, 'clients', 'deep', 'delta'));
  checkout(path.join(projects, '.hidden', 'eps'));
  checkout(path.join(projects, 'node_modules', 'zeta'));
  mkdirSync(path.join(projects, 'empty'));
  const building = new Building(dataDir, projects);

  const live = [
    { pid: 1, sessionId: 'a', cwd: path.join(projects, 'alpha'), startedAt: 1 },
    { pid: 2, sessionId: 'b', cwd: path.join(projects, 'alpha', 'src'), startedAt: 2 },
    { pid: 3, sessionId: 'c', cwd: path.join(projects, 'alphabet'), startedAt: 3 },
  ];
  const found = building.localCheckouts(live);
  assert.deepEqual(found.map((c) => path.relative(projects, c.dir)), ['alpha', path.join('clients', 'beta'), path.join('clients', 'gamma')]);
  assert.deepEqual(found.map((c) => [c.name, c.repo, c.floored, c.sessions]), [
    ['alpha', 'acme/alpha', false, 2],
    ['beta', undefined, false, 0],
    ['gamma', 'acme/alpha', false, 0],
  ]);

  // A floor already: it says so.
  const floored = new Building(dataDir, path.dirname(defs[0].dir));
  checkout(defs[0].dir);
  assert.deepEqual(floored.localCheckouts().map((c) => [c.name, c.floored]), [['api', true]]);
});

test('a checkout on the machine becomes a floor where it is, and the ones that can’t are refused', (t) => {
  const { root, dataDir, defs } = office(t);
  const projects = path.join(root, 'projects');
  const alpha = path.join(projects, 'alpha');
  checkout(alpha, 'acme/alpha');
  const building = new Building(dataDir, projects);

  const r = building.addLocal(`${alpha}/`, 'Sam');
  assert.equal(typeof r, 'object', String(r));
  const def = r as FloorDef;
  assert.deepEqual([def.id, def.name, def.repo, def.dir, def.addedBy], ['alpha', 'alpha', 'acme/alpha', alpha, 'Sam']);
  assert.deepEqual(saved(dataDir), ['api', 'web', 'docs', 'alpha']);
  assert.deepEqual(new Building(dataDir, projects).list().map((d) => d.id), ['api', 'web', 'docs', 'alpha']);

  assert.match(building.addLocal(alpha, 'Sam') as string, /is already a floor \(alpha\)/);
  // Another checkout of the same repository.
  const twin = path.join(projects, 'alpha-2');
  checkout(twin, 'acme/alpha');
  assert.match(building.addLocal(twin, 'Sam') as string, /^acme\/alpha already has a floor at /);
  // Not git, not there, not a full path.
  const plain = path.join(projects, 'plain');
  mkdirSync(plain);
  assert.match(building.addLocal(plain, 'Sam') as string, /isn't a git checkout/);
  assert.match(building.addLocal(path.join(projects, 'nope'), 'Sam') as string, /There's no/);
  assert.match(building.addLocal('projects/alpha', 'Sam') as string, /full path/);
  assert.match(building.addLocal('', 'Sam') as string, /Type the folder/);
  // Inside a floor's checkout, or with floors inside it.
  const inner = path.join(alpha, 'packages', 'ui');
  checkout(inner);
  assert.match(building.addLocal(inner, 'Sam') as string, /is inside alpha's checkout/);
  const acme = path.dirname(defs[0].dir);
  checkout(acme);
  assert.match(building.addLocal(acme, 'Sam') as string, /checkout is inside/);
  assert.deepEqual(saved(dataDir), ['api', 'web', 'docs', 'alpha']);
});

test('the office’s own checkout, taken off, moves back in when its folder is added', (t) => {
  const { root, dataDir, defs } = office(t);
  checkout(defs[0].dir, 'acme/api');
  const building = new Building(dataDir, root);
  building.ensureLocal(defs[0].dir, 'the office');
  building.remove('api', 'Sam');
  assert.ok(existsSync(path.join(dataDir, 'local-floor.json')));

  const back = building.addLocal(defs[0].dir, 'Sam');
  assert.equal(typeof back, 'object', String(back));
  assert.ok(building.isLocal((back as FloorDef).id));
  assert.ok(!existsSync(path.join(dataDir, 'local-floor.json')));
});

test('adding a repository that’s already checked out in the projects folder uses that checkout, without asking GitHub', async (t) => {
  const { root, dataDir } = office(t);
  const projects = path.join(root, 'projects');
  // Not where a clone would go (<projects>/acme/beta): under a folder of the user's own naming.
  const mine = path.join(projects, 'Develogix', 'beta');
  checkout(mine, 'acme/Beta');
  const building = new Building(dataDir, projects);

  const started: string[] = [];
  const r = await building.add('https://github.com/acme/beta', 'Sam', (d) => started.push(d.dir));
  assert.equal(typeof r, 'object', String(r));
  assert.deepEqual([(r as FloorDef).dir, (r as FloorDef).repo, (r as FloorDef).name], [mine, 'acme/Beta', 'beta']);
  assert.deepEqual(started, [mine]);
  assert.ok(!existsSync(path.join(projects, 'acme')), 'nothing was cloned');
  assert.equal(await building.add('acme/beta', 'Sam', () => {}), 'acme/beta already has a floor');
});

test("a local checkout that can't be a floor doesn't stop the repository being cloned as usual", async (t) => {
  const { root, dataDir, defs } = office(t);
  // gh that knows nothing: cloning goes as far as asking GitHub, and no further.
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "no such repository" >&2\nexit 1\n');
  chmodSync(path.join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  // A checkout of acme/gamma, but inside the api floor's checkout.
  checkout(path.join(defs[0].dir, 'gamma'), 'acme/gamma');
  const building = new Building(dataDir, defs[0].dir);
  const r = await building.add('acme/gamma', 'Sam', () => {});
  assert.match(r as string, /^Couldn't find acme\/gamma on GitHub/);
});

test("the whole home folder isn't looked through for checkouts, and a look is reused for a few seconds", (t) => {
  const { root, dataDir } = office(t);
  assert.equal(new Building(dataDir, homedir()).localCheckouts(), 'Pick a projects folder, not your whole home folder');
  assert.equal(new Building(dataDir, path.join(homedir(), 'Library')).localCheckouts(), 'Pick a projects folder, not your whole home folder');

  const projects = path.join(root, 'projects');
  checkout(path.join(projects, 'one'));
  const building = new Building(dataDir, projects);
  const names = () => (building.localCheckouts() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(names(), ['one']);
  checkout(path.join(projects, 'two'));
  assert.deepEqual(names(), ['one'], 'the look a moment ago');
  assert.deepEqual((new Building(dataDir, projects).localCheckouts() as { name: string }[]).map((c) => c.name), ['one', 'two']);
});

test('a checkout reached through a symlink is the same checkout', (t) => {
  const { root, dataDir, defs } = office(t);
  checkout(defs[0].dir);
  const link = path.join(root, 'linked');
  symlinkSync(path.dirname(defs[0].dir), link);
  const building = new Building(dataDir, root);
  assert.match(building.addLocal(path.join(link, 'api'), 'Sam') as string, /is already a floor \(api\)/);
  checkout(path.join(defs[1].dir, 'inner'));
  assert.match(building.addLocal(path.join(link, 'web', 'inner'), 'Sam') as string, /is inside web's checkout/);
});

const linksOf = (dataDir: string, id: string) => (JSON.parse(readFileSync(path.join(dataDir, 'floors.json'), 'utf8')) as FloorDef[]).find((d) => d.id === id)?.links;

test('another repository’s checkout joins a floor where it is, is kept in floors.json, and comes off again', async (t) => {
  const { root, dataDir, defs } = office(t);
  const projects = path.join(root, 'projects');
  const app = path.join(projects, 'feyer-app');
  checkout(app, 'acme/feyer-app');
  const building = new Building(dataDir, projects);

  const r = await building.link('api', `${app}/`, 'Sam');
  assert.equal(typeof r, 'object', String(r));
  const link = r as FloorLink;
  assert.deepEqual([link.id, link.name, link.repo, link.dir, link.addedBy], ['feyer-app', 'feyer-app', 'acme/feyer-app', app, 'Sam']);
  assert.deepEqual(linksOf(dataDir, 'api')?.map((l) => l.id), ['feyer-app']);
  assert.equal(linksOf(dataDir, 'web'), undefined, 'the other floors are as they were');
  // A restart has it on the floor still.
  assert.deepEqual(new Building(dataDir, projects).list()[0].links?.map((l) => [l.id, l.dir, l.repo]), [['feyer-app', app, 'acme/feyer-app']]);

  // The elevator says where it is.
  const listed = (building.localCheckouts() as { name: string; floored: boolean; on?: string }[]).find((c) => c.name === 'feyer-app');
  assert.deepEqual([listed?.floored, listed?.on], [false, 'api']);

  const gone = building.unlink('api', 'feyer-app');
  assert.equal(typeof gone, 'object', String(gone));
  assert.equal((gone as FloorLink).dir, app);
  assert.equal(linksOf(dataDir, 'api'), undefined);
  assert.equal(new Building(dataDir, projects).list()[0].links, undefined);
  assert.ok(existsSync(app), 'its folder stays where it is');
  assert.match(building.unlink('api', 'feyer-app') as string, /isn't on the api floor/);
  assert.equal(building.unlink('nope', 'feyer-app'), 'No such floor');
});

test('a checkout that’s in the building already, or can’t be one, isn’t linked to a floor', async (t) => {
  const { root, dataDir, defs } = office(t);
  const projects = path.join(root, 'projects');
  const app = path.join(projects, 'feyer-app');
  checkout(app, 'acme/feyer-app');
  checkout(defs[1].dir, 'acme/web');
  const building = new Building(dataDir, projects);
  assert.equal(typeof (await building.link('api', app, 'Sam')), 'object');

  // The same folder, on this floor or another one, as a link or as a floor.
  assert.match((await building.link('api', app, 'Sam')) as string, /is already on the api floor/);
  assert.match((await building.link('docs', app, 'Sam')) as string, /is already on the api floor/);
  assert.match(building.addLocal(app, 'Sam') as string, /is already on the api floor/);
  // Another checkout of a repository that's in the building already.
  const twin = path.join(projects, 'feyer-app-2');
  checkout(twin, 'acme/feyer-app');
  assert.match((await building.link('docs', twin, 'Sam')) as string, /^acme\/feyer-app is already on the api floor, at /);
  assert.match(building.addLocal(twin, 'Sam') as string, /^acme\/feyer-app is already on the api floor, at /);
  assert.equal(await building.add('acme/feyer-app', 'Sam', () => {}), 'acme/feyer-app is already on the api floor');
  // A floor's own checkout, by folder or by repository.
  assert.match((await building.link('api', defs[1].dir, 'Sam')) as string, /is already a floor \(web\)/);
  assert.match((await building.link('api', 'acme/web', 'Sam')) as string, /already has a floor of its own \(web\)/);
  assert.match((await building.link('docs', 'acme/feyer-app', 'Sam')) as string, /is already on the api floor/);
  // Inside a linked checkout, or around one.
  const inner = path.join(app, 'packages', 'ui');
  checkout(inner);
  assert.match((await building.link('docs', inner, 'Sam')) as string, /is inside feyer-app's checkout/);
  assert.match(building.addLocal(inner, 'Sam') as string, /is inside feyer-app's checkout/);
  checkout(projects);
  assert.match((await building.link('docs', projects, 'Sam')) as string, /feyer-app's checkout is inside/);
  // Not git, not a full path, no such floor.
  const plain = path.join(projects, 'plain');
  mkdirSync(plain);
  assert.match((await building.link('api', plain, 'Sam')) as string, /isn't a git checkout/);
  // (projects/plain would be owner/name: a relative folder starts with ./)
  assert.match((await building.link('api', './projects/plain', 'Sam')) as string, /full path/);
  assert.match((await building.link('api', '', 'Sam')) as string, /Type the folder/);
  assert.equal(await building.link('nope', app, 'Sam'), 'No such floor');
  assert.deepEqual(linksOf(dataDir, 'api')?.map((l) => l.id), ['feyer-app']);
  assert.equal(linksOf(dataDir, 'docs'), undefined);
});

test('a repository linked by owner/name uses its checkout in the projects folder, and is only cloned when there’s none', async (t) => {
  const { root, dataDir } = office(t);
  // gh that knows nothing: cloning goes as far as asking GitHub, and no further.
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "no such repository" >&2\nexit 1\n');
  chmodSync(path.join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const projects = path.join(root, 'projects');
  const mine = path.join(projects, 'Develogix', 'feyer-app');
  checkout(mine, 'acme/Feyer-App');
  const building = new Building(dataDir, projects);

  const r = await building.link('web', 'https://github.com/acme/feyer-app', 'Sam');
  assert.equal(typeof r, 'object', String(r));
  assert.deepEqual([(r as FloorLink).dir, (r as FloorLink).repo], [mine, 'acme/Feyer-App']);
  assert.ok(!existsSync(path.join(projects, 'acme')), 'nothing was cloned');
  assert.match((await building.link('web', 'acme/elsewhere', 'Sam')) as string, /^Couldn't find acme\/elsewhere on GitHub/);
});

test('floors.json with links that make no sense loads without them', (t) => {
  const { root, dataDir, defs } = office(t);
  const raw = JSON.parse(readFileSync(path.join(dataDir, 'floors.json'), 'utf8')) as FloorDef[];
  raw[0].links = [
    { id: 'ok', name: 'ok', dir: path.join(root, 'ok'), addedBy: 'Sam', addedAt: 1 },
    { id: 'ok', name: 'twice', dir: path.join(root, 'twice'), addedBy: 'Sam', addedAt: 1 },
    { id: 'Bad Id', name: 'x', dir: path.join(root, 'x'), addedBy: 'Sam', addedAt: 1 },
    { id: 'relative', name: 'y', dir: 'y', addedBy: 'Sam', addedAt: 1 },
  ];
  (raw[1] as { links?: unknown }).links = 'nonsense';
  writeFileSync(path.join(dataDir, 'floors.json'), JSON.stringify(raw));
  const list = new Building(dataDir, root).list();
  assert.deepEqual(list.map((d) => d.id), defs.map((d) => d.id));
  assert.deepEqual(list[0].links?.map((l) => l.id), ['ok']);
  assert.equal(list[1].links, undefined);
});

test('a floor taken off and added again comes back with its linked repositories, the ones still fit to be', async (t) => {
  const { root, dataDir } = office(t);
  const projects = path.join(root, 'projects');
  const feyer = path.join(projects, 'feyer');
  const app = path.join(projects, 'feyer-app');
  const site = path.join(projects, 'feyer-site');
  checkout(feyer, 'acme/feyer');
  checkout(app, 'acme/feyer-app');
  checkout(site, 'acme/feyer-site');
  const building = new Building(dataDir, projects);
  const floor = building.addLocal(feyer, 'Sam') as FloorDef;
  assert.equal(typeof (await building.link(floor.id, app, 'Sam')), 'object');
  assert.equal(typeof (await building.link(floor.id, site, 'Sam')), 'object');
  // Kept with the floor's own data too.
  const kept = JSON.parse(readFileSync(path.join(feyer, '.agent-office', 'links.json'), 'utf8')) as FloorLink[];
  assert.deepEqual(kept.map((l) => l.id), ['feyer-app', 'feyer-site']);

  building.remove(floor.id, 'Sam');
  // Meanwhile feyer-site became a floor of its own: it can't come back as a link.
  assert.equal(typeof building.addLocal(site, 'Sam'), 'object');
  const back = building.addLocal(feyer, 'Sam') as FloorDef;
  assert.equal(typeof back, 'object', String(back));
  assert.deepEqual(back.links?.map((l) => [l.id, l.dir, l.repo]), [['feyer-app', app, 'acme/feyer-app']]);
  assert.deepEqual(linksOf(dataDir, back.id)?.map((l) => l.id), ['feyer-app']);

  // Unlinking writes it there too.
  building.unlink(back.id, 'feyer-app');
  assert.deepEqual(JSON.parse(readFileSync(path.join(feyer, '.agent-office', 'links.json'), 'utf8')), []);
});

test('a repository being cloned to link to a floor is no one else’s to add or link meanwhile', async (t) => {
  const { root, dataDir } = office(t);
  // gh that knows acme/slow, and takes a moment to clone it.
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"acme/slow"}';;
  "repo clone") sleep 1; git init -q "$4"; git -C "$4" remote add origin https://github.com/acme/slow.git;;
  *) exit 1;;
esac
`,
  );
  chmodSync(path.join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const projects = path.join(root, 'projects');
  const building = new Building(dataDir, projects);
  const linking = building.link('api', 'acme/slow', 'Sam');
  const dest = path.join(projects, 'acme', 'slow');
  const end = Date.now() + 5000;
  while (!(building as any).linking.size && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await building.add('acme/slow', 'Sam', () => {}), 'acme/slow is already being cloned');
  assert.match((await building.link('web', 'acme/slow', 'Sam')) as string, /already being cloned/);
  assert.match(building.addLocal(dest, 'Sam') as string, /is still being cloned/);
  const r = await linking;
  assert.equal(typeof r, 'object', String(r));
  assert.equal((r as FloorLink).dir, dest);
});
