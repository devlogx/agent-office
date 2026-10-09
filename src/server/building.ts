import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, type Dirent, mkdirSync, realpathSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FLOOR_PALETTES, MAX_FLOORS, normalizeRepo, sameRepo } from '../shared/floors.js';
import type { LocalCheckout, ProjectsDirState, RepoChoice } from '../shared/protocol.js';
import { gh } from './github.js';
import type { LiveSession } from './sessions.js';

/** A floor as floors.json keeps it. */
export interface FloorDef {
  id: string;
  name: string;
  /** owner/name on GitHub. */
  repo?: string;
  dir: string;
  palette: number;
  addedBy: string;
  addedAt: number;
  /** Other repositories' checkouts on this floor besides its own (see link); none on most floors. */
  links?: FloorLink[];
}

/**
 * Another repository's checkout on a floor (feyer-app on feyer's floor, say), as floors.json keeps it:
 * its workers can be hired there, Claude sessions in a terminal there sit at the floor's desks, and
 * its issues and pull requests are on the floor's boards. The floor's own data stays in the floor's
 * checkout: nothing is written into this one.
 */
export interface FloorLink {
  /** Unique on its floor. */
  id: string;
  /** Its folder's name. */
  name: string;
  /** owner/name on GitHub, when its origin is there. */
  repo?: string;
  dir: string;
  addedBy: string;
  addedAt: number;
}

/** A floor's own checkout or one linked to it, for telling whether a folder or repository is in the building already. */
interface Placed {
  floor: FloorDef;
  /** Set for a linked checkout; none for the floor's own. */
  link?: FloorLink;
  name: string;
  dir: string;
  repo?: string;
}

/** A projects folder picked in ⚙️ Settings (or with --projects), as projects-folder.json keeps it. */
interface PickedDir {
  dir: string;
  by: string;
  at: number;
}

/** The checkout the office was started in, once it's been taken off the building (local-floor.json). */
interface LocalOff {
  dir: string;
  by: string;
  at: number;
}

/** How long the list of repositories `gh` can see is reused before it's asked again. */
const REPOS_TTL_MS = 5 * 60_000;
const MAX_REPOS = 1000;
const CLONE_TIMEOUT_MS = 30 * 60_000;
/** The most checkouts the elevator lists from the projects folder. */
const MAX_CHECKOUTS = 500;
/** Folders never looked in for checkouts: what's in them is never a project of its own. */
const NOT_PROJECTS = new Set(['node_modules']);
/** How long a look through the projects folder for checkouts is reused: the elevator asks every time it opens. */
const CHECKOUTS_TTL_MS = 10_000;
/** The most other repositories one floor can have linked to it. */
export const MAX_LINKS = 8;
/** Where a floor keeps its linked checkouts in its own .agent-office too (see saveLinks). */
const LINKS_FILE = 'links.json';

/**
 * The floors of the building, saved in <office>/.agent-office/floors.json: which projects there are,
 * where their checkouts live, and how each floor is painted. New floors are cloned with the office
 * machine's `gh` login into <projects>/<owner>/<repo>; the projects folder can be picked in ⚙️ Settings
 * (kept in projects-folder.json).
 */
export class Building {
  private defs: FloorDef[] = [];
  private file: string;
  private pickedFile: string;
  private picked?: PickedDir;
  /** Floors being cloned, by lower-cased repo. Not saved until the clone is there. */
  private cloning = new Map<string, FloorDef>();
  private repoCache?: { at: number; repos: Promise<RepoChoice[]> };
  /** The checkout the office was started in (see ensureLocal), and the repository it's a checkout of. */
  private local?: { dir: string; repo?: string };
  /** The floor that checkout is, while it is one. */
  private localId?: string;
  private localFile: string;
  /** That checkout was taken off the building: a restart doesn't put it back. */
  private localOff?: LocalOff;
  /** The last look through the projects folder for checkouts (see localCheckouts). */
  private checkoutCache?: { at: number; root: string; found: { dir: string; real: string; repo?: string }[] };
  /** Repositories being cloned to link to a floor (see link), by lower-cased repo, with where each is going. */
  private linking = new Map<string, string>();

  constructor(
    /** The office's own data folder; `gh` runs there, since the projects folder may not exist yet. */
    private dataDir: string,
    /** Where new floors are cloned unless another folder was picked. */
    private defaultProjectsDir: string,
  ) {
    this.file = path.join(dataDir, 'floors.json');
    this.pickedFile = path.join(dataDir, 'projects-folder.json');
    this.localFile = path.join(dataDir, 'local-floor.json');
    this.load();
    this.loadPicked();
    this.loadLocalOff();
  }

  /** Where new floors are cloned. Floors already there stay where they are when it moves. */
  get projectsDir(): string {
    return this.picked?.dir ?? this.defaultProjectsDir;
  }

  projectsDirState(): ProjectsDirState {
    return { dir: tildify(this.projectsDir), custom: !!this.picked, by: this.picked?.by, at: this.picked?.at };
  }

  /** Clones new floors into `raw` from now on ('~' is the home folder; '' goes back to the default). Returns why it can't, if it can't. */
  setProjectsDir(raw: string, by: string): string | undefined {
    const text = raw.trim();
    let dir = this.defaultProjectsDir;
    if (text) {
      const typed = untildify(text);
      if (!path.isAbsolute(typed)) return 'Use a full path, like ~/Workspace';
      dir = path.resolve(typed);
    }
    if (dir !== this.defaultProjectsDir) {
      const why = unwritable(dir);
      if (why) return why;
      // Cloning into a project would nest checkouts inside its git tree.
      const inside = this.placed().find((p) => within(dir, path.resolve(p.dir)));
      if (inside) return `${tildify(dir)} is inside ${inside.name}'s checkout — pick a folder outside every project`;
    }
    this.picked = dir === this.defaultProjectsDir ? undefined : { dir, by, at: Date.now() };
    try {
      writeFileSync(this.pickedFile, JSON.stringify(this.picked ?? {}, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`agent-office: couldn't save the projects folder: ${(err as Error).message}`);
    }
    return undefined;
  }

  list(): FloorDef[] {
    return this.defs;
  }

  /** Floors on their way: shown in the elevator, but nobody can ride there yet. */
  pending(): FloorDef[] {
    return [...this.cloning.values()];
  }

  /**
   * Makes the checkout the office was started in a floor, if it isn't one yet: `agent-office <dir>`
   * has always meant that project. Once someone takes it off the building it stays off (the office
   * still keeps its own data in it), until its repository is added again from the elevator.
   */
  ensureLocal(dir: string, by: string): FloorDef | undefined {
    const abs = path.resolve(dir);
    const known = this.defs.find((d) => path.resolve(d.dir) === abs);
    this.local = { dir: abs, repo: known?.repo ?? originRepo(abs) };
    if (known) {
      this.localId = known.id;
      if (this.localOff) this.setLocalOff(undefined);
      return known;
    }
    if (this.localOff && path.resolve(this.localOff.dir) === abs) return undefined;
    // Named after its folder, as the office always called it.
    const def = this.newDef(path.basename(abs), this.local.repo, abs, by);
    this.defs.unshift(def);
    this.localId = def.id;
    this.restoreLinks(def);
    this.save();
    return def;
  }

  /** The office keeps its own data in this floor's checkout. */
  isLocal(id: string): boolean {
    return id === this.localId;
  }

  /**
   * Takes a floor off the building. Its checkout stays where it is, with its workers, queue and
   * pictures in its .agent-office folder: adding the repository again moves back in, as long as the
   * checkout is still where the projects folder clones it (or it's the one the office was started
   * in). Returns the floor, or why it can't.
   */
  remove(id: string, by = '?'): FloorDef | string {
    const def = this.defs.find((d) => d.id === id);
    if (!def) return [...this.cloning.values()].some((d) => d.id === id) ? "That floor is still being cloned — take it off once it's there" : 'No such floor';
    this.defs = this.defs.filter((d) => d !== def);
    if (this.isLocal(id)) {
      this.localId = undefined;
      this.setLocalOff({ dir: def.dir, by, at: Date.now() });
    }
    this.save();
    return def;
  }

  /**
   * Clones a repository into the projects folder and adds it as a floor. `started` hears about the
   * floor as soon as the clone begins; resolves to the finished floor, or to why there's none. A
   * checkout that's already where the clone would go is used as it is.
   */
  async add(input: string, by: string, started: (def: FloorDef) => void): Promise<FloorDef | string> {
    const wanted = normalizeRepo(input);
    if (!wanted) return 'Pick a repository, or type it as owner/name';
    if (this.defs.some((d) => sameRepo(d.repo, wanted))) return `${wanted} already has a floor`;
    const linked = this.placed().find((p) => p.link && sameRepo(p.repo, wanted));
    if (linked) return `${wanted} is already on the ${linked.floor.name} floor`;
    if (this.cloning.has(wanted.toLowerCase()) || this.linking.has(wanted.toLowerCase())) return `${wanted} is already being cloned`;
    if (this.defs.length + this.cloning.size >= MAX_FLOORS) return `The building is full (${MAX_FLOORS} floors)`;
    // The office's own checkout, taken off before: it moves back in where it is, not into a second clone.
    const home = this.local;
    if (this.localOff && home && sameRepo(home.repo, wanted) && existsSync(home.dir)) {
      const def = this.newDef(path.basename(home.dir), home.repo, home.dir, by);
      started(def);
      this.defs.push(def);
      this.localId = def.id;
      this.setLocalOff(undefined);
      this.restoreLinks(def);
      this.save();
      return def;
    }
    // Already checked out in the projects folder (by hand, say, with no <owner>/ above it): that's
    // the floor, where it is, rather than a second clone next to it.
    // One that can't be a floor (inside another project, say) is no reason not to clone it as usual.
    const there = this.checkedOut(wanted);
    const local = there ? this.addLocal(there, by) : undefined;
    if (local && typeof local !== 'string') {
      started(local);
      return local;
    }
    // Asking GitHub first says whether this login can see it at all, and gets the name's real case.
    let repo: string;
    try {
      const view = JSON.parse(await gh(['repo', 'view', wanted, '--json', 'nameWithOwner'], this.dataDir, 30_000)) as { nameWithOwner?: string };
      repo = normalizeRepo(view.nameWithOwner) ?? wanted;
    } catch (err) {
      return `Couldn't find ${wanted} on GitHub: ${(err as Error).message}`;
    }
    const key = repo.toLowerCase();
    if (this.defs.some((d) => sameRepo(d.repo, repo))) return `${repo} already has a floor`;
    if (this.cloning.has(key) || this.linking.has(key)) return `${repo} is already being cloned`;
    const [owner, name] = repo.split('/');
    const dest = path.join(this.projectsDir, owner, name);
    if (this.defs.some((d) => path.resolve(d.dir) === dest)) return `${dest} is already a floor`;
    if (this.cloningInto(dest)) return `${tildify(dest)} is already being cloned into`;
    const def = this.newDef(name, repo, dest, by);
    this.cloning.set(key, def);
    started(def);
    try {
      const err = await cloneInto(repo, dest);
      if (err) return err;
    } finally {
      this.cloning.delete(key);
    }
    this.defs.push(def);
    this.restoreLinks(def);
    this.save();
    return def;
  }

  /**
   * The git checkouts already in the projects folder, for the elevator to make floors of where they
   * are: <projects>/<name>, and one level further down, <projects>/<group>/<name>, the way clones
   * land as <owner>/<repo>. A checkout's own folders (and dot-folders, node_modules) aren't looked
   * in. `live` are the Claude Code sessions running on the machine, counted for the checkout they're in.
   */
  localCheckouts(live: LiveSession[] = []): LocalCheckout[] | string {
    const root = path.resolve(this.projectsDir);
    // Every folder of a home folder (or its Library) is no list of projects, and slow to go through.
    const home = path.resolve(os.homedir());
    if (root === home || within(root, path.join(home, 'Library'))) return 'Pick a projects folder, not your whole home folder';
    let cached = this.checkoutCache;
    if (!cached || cached.root !== root || Date.now() - cached.at > CHECKOUTS_TTL_MS) {
      const found: string[] = [];
      const look = (dir: string, depth: number) => {
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (found.length >= MAX_CHECKOUTS) return;
          if (!e.isDirectory() || e.name.startsWith('.') || NOT_PROJECTS.has(e.name)) continue;
          const sub = path.join(dir, e.name);
          if (existsSync(path.join(sub, '.git'))) found.push(sub);
          else if (depth < 2) look(sub, depth + 1);
        }
      };
      look(root, 1);
      cached = { at: Date.now(), root, found: found.map((dir) => ({ dir, real: real(dir), repo: configOrigin(dir) })) };
      this.checkoutCache = cached;
    }
    // Each floor's checkouts, its own and the ones linked to it: a floor's own row counts the Claude
    // sessions in all of them, as the floor seats them all.
    const placed = new Map(this.placed().map((p) => [real(p.dir), p]));
    const inAny = (cwd: string, dirs: string[]) => dirs.some((d) => within(cwd, d) || within(cwd, real(d)));
    return cached.found.map(({ dir, real: at, repo }) => {
      const p = placed.get(at);
      const dirs = p && !p.link ? [dir, ...(p.floor.links ?? []).map((l) => l.dir)] : [dir];
      return {
        dir,
        shown: tildify(dir),
        name: path.basename(dir),
        repo,
        floored: !!p && !p.link,
        on: p?.floor.id,
        sessions: live.filter((s) => inAny(s.cwd, dirs)).length,
      };
    });
  }

  /**
   * A checkout of `repo` already in the projects folder where it would be looked for: <projects>/<name>,
   * <projects>/<owner>/<name>, or <projects>/<anything>/<name>, its origin saying it's that repository.
   */
  private checkedOut(repo: string): string | undefined {
    const [owner, name] = repo.split('/');
    const root = this.projectsDir;
    const candidates = [path.join(root, name), path.join(root, owner, name)];
    try {
      for (const e of readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && !NOT_PROJECTS.has(e.name)) candidates.push(path.join(root, e.name, name));
      }
    } catch {
      // no projects folder yet
    }
    return [...new Set(candidates)].find((dir) => existsSync(path.join(dir, '.git')) && sameRepo(configOrigin(dir), repo));
  }

  /**
   * Makes a checkout already on the office's machine a floor, where it is: nothing is cloned, and
   * `gh` isn't asked. `raw` is its folder ('~' is the home folder). It has to be a git checkout (the
   * workers' worktrees are cut from it), and can't be inside another floor's checkout or have one
   * inside it. Returns the floor, or why it can't.
   */
  addLocal(raw: string, by: string): FloorDef | string {
    const vetted = this.vet(raw);
    if (typeof vetted === 'string') return vetted;
    const { dir, repo } = vetted;
    if (this.defs.length + this.cloning.size >= MAX_FLOORS) return `The building is full (${MAX_FLOORS} floors)`;
    const def = this.newDef(path.basename(dir), repo, dir, by);
    this.defs.push(def);
    // The office's own checkout, taken off before: it's back, as add() would have it.
    if (this.localOff && path.resolve(this.localOff.dir) === dir) {
      this.localId = def.id;
      this.setLocalOff(undefined);
    }
    this.restoreLinks(def);
    this.save();
    return def;
  }

  /**
   * Whether the folder `raw` ('~' is the home folder) can join the building, as a floor or linked to
   * one: a git checkout (the workers' worktrees are cut from it) that isn't a floor or linked to one
   * already, isn't inside one of their checkouts or around one, and whose repository isn't in the
   * building yet. Returns it, with its origin's repository, or why it can't.
   */
  private vet(raw: string): { dir: string; repo?: string } | string {
    const text = raw.trim();
    if (!text) return 'Type the folder of a checkout, like ~/Projects/my-app';
    const typed = untildify(text);
    if (!path.isAbsolute(typed)) return 'Use a full path, like ~/Projects/my-app';
    const dir = path.resolve(typed);
    // Half there: a clone for a floor, or to link to one, is still going on in it.
    if (this.cloningInto(dir)) return `${tildify(dir)} is still being cloned`;
    try {
      if (!statSync(dir).isDirectory()) return `${tildify(dir)} isn't a folder`;
    } catch {
      return `There's no ${tildify(dir)} on the office's machine`;
    }
    if (!existsSync(path.join(dir, '.git'))) return `${tildify(dir)} isn't a git checkout — the workers' worktrees need one`;
    const all = this.placed();
    // Through symlinks on both sides: ~/code may be ~/Projects by another name.
    const at = real(dir);
    const same = all.find((p) => real(p.dir) === at);
    if (same) return same.link ? `${tildify(dir)} is already on the ${same.floor.name} floor` : `${tildify(dir)} is already a floor (${same.floor.name})`;
    const repo = originRepo(dir);
    if (repo && (this.cloning.has(repo.toLowerCase()) || this.linking.has(repo.toLowerCase()))) return `${repo} is being cloned right now — add it once that's done`;
    const twin = repo && all.find((p) => sameRepo(p.repo, repo));
    if (twin) return twin.link ? `${repo} is already on the ${twin.floor.name} floor, at ${tildify(twin.dir)}` : `${repo} already has a floor at ${tildify(twin.dir)}`;
    const outer = all.find((p) => within(at, real(p.dir)));
    if (outer) return `${tildify(dir)} is inside ${outer.name}'s checkout — pick a folder outside every project`;
    const inner = all.find((p) => within(real(p.dir), at));
    if (inner) return `${inner.name}'s checkout is inside ${tildify(dir)} — pick a project, not the folder they're in`;
    return { dir, repo };
  }

  /** Whether a clone (for a floor, or to link to one) is going on in `dir` right now. */
  private cloningInto(dir: string): boolean {
    const at = path.resolve(dir);
    return [...this.cloning.values()].some((d) => path.resolve(d.dir) === at) || [...this.linking.values()].some((d) => path.resolve(d) === at);
  }

  /** Every floor's checkout and every checkout linked to one, floors still being cloned included. */
  private placed(): Placed[] {
    return [...this.defs, ...this.cloning.values()].flatMap((floor) => [
      { floor, name: floor.name, dir: floor.dir, repo: floor.repo },
      ...(floor.links ?? []).map((link) => ({ floor, link, name: link.name, dir: link.dir, repo: link.repo })),
    ]);
  }

  /**
   * Adds another repository's checkout to a floor (see FloorLink). `raw` is a folder on the office's
   * machine ('~' is the home folder), vetted as addLocal vets a floor's, or owner/name: a checkout of
   * it already in the projects folder is used where it is, else it's cloned into
   * <projects>/<owner>/<name> as add() would. Resolves to the link, or to why there's none.
   */
  async link(floorId: string, raw: string, by: string): Promise<FloorLink | string> {
    const def = this.defs.find((d) => d.id === floorId);
    if (!def) return [...this.cloning.values()].some((d) => d.id === floorId) ? "That floor is still being cloned — add to it once it's there" : 'No such floor';
    const text = raw.trim();
    if (!text) return 'Type the folder of a checkout, like ~/Projects/my-app, or a repository as owner/name';
    if ((def.links?.length ?? 0) >= MAX_LINKS) return `A floor can have at most ${MAX_LINKS} other repositories`;
    const wanted = /^[~/.]/.test(text) ? undefined : normalizeRepo(text);
    let found: { dir: string; repo?: string } | string;
    if (!wanted) found = this.vet(text);
    else {
      const there = this.placed().find((p) => sameRepo(p.repo, wanted));
      if (there) return there.link ? `${wanted} is already on the ${there.floor.name} floor` : `${wanted} already has a floor of its own (${there.floor.name})`;
      const local = this.checkedOut(wanted);
      const vetted = local ? this.vet(local) : undefined;
      found = vetted && typeof vetted !== 'string' ? vetted : await this.cloneToLink(wanted);
    }
    if (typeof found === 'string') return found;
    // Cloning took a while: the floor may have gone, or filled up, meanwhile.
    const now = this.defs.find((d) => d.id === floorId);
    if (!now) return 'That floor was taken off the building meanwhile';
    if ((now.links?.length ?? 0) >= MAX_LINKS) return `A floor can have at most ${MAX_LINKS} other repositories`;
    const name = path.basename(found.dir);
    const taken = new Set((now.links ?? []).map((l) => l.id));
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'repo';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const link: FloorLink = { id, name, repo: found.repo, dir: found.dir, addedBy: by, addedAt: Date.now() };
    now.links = [...(now.links ?? []), link];
    this.save();
    this.saveLinks(now);
    return link;
  }

  /** Clones `wanted` into the projects folder for link(), as add() clones a floor's; resolves to the checkout, vetted, or to why there's none. */
  private async cloneToLink(wanted: string): Promise<{ dir: string; repo?: string } | string> {
    let repo: string;
    try {
      const view = JSON.parse(await gh(['repo', 'view', wanted, '--json', 'nameWithOwner'], this.dataDir, 30_000)) as { nameWithOwner?: string };
      repo = normalizeRepo(view.nameWithOwner) ?? wanted;
    } catch (err) {
      return `Couldn't find ${wanted} on GitHub: ${(err as Error).message}`;
    }
    const key = repo.toLowerCase();
    if (this.linking.has(key) || this.cloning.has(key)) return `${repo} is already being cloned`;
    const [owner, name] = repo.split('/');
    const dest = path.join(this.projectsDir, owner, name);
    if (this.cloningInto(dest)) return `${tildify(dest)} is already being cloned into`;
    this.linking.set(key, dest);
    try {
      const err = await cloneInto(repo, dest);
      if (err) return err;
    } finally {
      this.linking.delete(key);
    }
    return this.vet(dest);
  }

  /** Takes a linked checkout off its floor; its folder stays where it is. Returns it, or why it can't. */
  unlink(floorId: string, linkId: string): FloorLink | string {
    const def = this.defs.find((d) => d.id === floorId);
    if (!def) return 'No such floor';
    const link = def.links?.find((l) => l.id === linkId);
    if (!link) return `That repository isn't on the ${def.name} floor any more`;
    const left = def.links!.filter((l) => l !== link);
    if (left.length) def.links = left;
    else delete def.links;
    this.save();
    this.saveLinks(def);
    return link;
  }

  /**
   * Keeps a floor's linked checkouts with the floor's own data too, in its checkout's
   * .agent-office/links.json, where its workers are: taking the floor off the building and adding it
   * again brings them back (see restoreLinks), and with them the workers who work in them.
   */
  private saveLinks(def: FloorDef) {
    try {
      const dir = path.join(def.dir, '.agent-office');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, LINKS_FILE), JSON.stringify(def.links ?? [], null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`agent-office: couldn't save the ${def.name} floor's other repositories: ${(err as Error).message}`);
    }
  }

  /**
   * A floor coming (back) onto the building gets the linked checkouts it had (see saveLinks), each
   * vetted again as when it was linked: one that's gone, or is in the building some other way by
   * now, is left out, saying so in the log.
   */
  private restoreLinks(def: FloorDef) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path.join(def.dir, '.agent-office', LINKS_FILE), 'utf8'));
    } catch {
      return; // never had any
    }
    for (const l of validLinks(raw) ?? []) {
      const vetted = this.vet(l.dir);
      if (typeof vetted === 'string') {
        console.warn(`agent-office: ${l.dir} isn't back on the ${def.name} floor: ${vetted}`);
        continue;
      }
      def.links = [...(def.links ?? []), { ...l, dir: vetted.dir, repo: vetted.repo }];
    }
  }

  /** Repositories the office's `gh` login can clone, most recently pushed first. */
  async repos(refresh = false): Promise<RepoChoice[]> {
    const cached = this.repoCache;
    if (cached && !refresh && Date.now() - cached.at < REPOS_TTL_MS) return cached.repos;
    const repos = listRepos(this.dataDir);
    this.repoCache = { at: Date.now(), repos };
    // A failure is worth asking again next time, not keeping for five minutes.
    repos.catch(() => {
      if (this.repoCache?.repos === repos) this.repoCache = undefined;
    });
    return repos;
  }

  private newDef(name: string, repo: string | undefined, dir: string, by: string): FloorDef {
    const taken = new Set([...this.defs, ...this.cloning.values()].map((d) => d.id));
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'floor';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    // The first look nobody has, so floors side by side never match; then round again.
    const used = new Set([...this.defs, ...this.cloning.values()].map((d) => d.palette));
    const free = FLOOR_PALETTES.findIndex((_, i) => !used.has(i));
    const palette = free >= 0 ? free : (this.defs.length + this.cloning.size) % FLOOR_PALETTES.length;
    return { id, name, repo, dir, palette, addedBy: by, addedAt: Date.now() };
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FloorDef>[];
      const ids = new Set<string>();
      for (const s of Array.isArray(saved) ? saved : []) {
        if (typeof s.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(s.id) || ids.has(s.id) || typeof s.dir !== 'string' || !path.isAbsolute(s.dir)) continue;
        ids.add(s.id);
        this.defs.push({
          id: s.id,
          name: typeof s.name === 'string' && s.name ? s.name.slice(0, 100) : path.basename(s.dir),
          repo: normalizeRepo(s.repo),
          dir: s.dir,
          palette: Number.isInteger(s.palette) && (s.palette as number) >= 0 ? (s.palette as number) : 0,
          addedBy: typeof s.addedBy === 'string' ? s.addedBy : '?',
          addedAt: typeof s.addedAt === 'number' ? s.addedAt : Date.now(),
          links: validLinks(s.links),
        });
      }
    } catch (err) {
      console.error(`agent-office: ${this.file} couldn't be read, so the building starts empty: ${(err as Error).message}`);
    }
  }

  private loadPicked() {
    try {
      const saved = JSON.parse(readFileSync(this.pickedFile, 'utf8')) as Partial<PickedDir>;
      if (typeof saved.dir === 'string' && path.isAbsolute(saved.dir)) {
        this.picked = { dir: saved.dir, by: typeof saved.by === 'string' ? saved.by : '?', at: typeof saved.at === 'number' ? saved.at : Date.now() };
      }
    } catch {
      // never picked: the default
    }
  }

  private loadLocalOff() {
    try {
      const saved = JSON.parse(readFileSync(this.localFile, 'utf8')) as Partial<LocalOff>;
      if (typeof saved.dir === 'string' && path.isAbsolute(saved.dir)) {
        this.localOff = { dir: saved.dir, by: typeof saved.by === 'string' ? saved.by : '?', at: typeof saved.at === 'number' ? saved.at : Date.now() };
      }
    } catch {
      // never taken off
    }
  }

  private setLocalOff(off: LocalOff | undefined) {
    this.localOff = off;
    try {
      if (off) writeFileSync(this.localFile, JSON.stringify(off, null, 2), { mode: 0o600 });
      else rmSync(this.localFile, { force: true });
    } catch (err) {
      console.error(`agent-office: couldn't save ${this.localFile}: ${(err as Error).message}`);
    }
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.defs, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`agent-office: couldn't save the floors: ${(err as Error).message}`);
    }
  }
}

/** The checkouts linked to a floor, as floors.json kept them: none (undefined) when there aren't any. */
function validLinks(raw: unknown): FloorLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = new Set<string>();
  const links: FloorLink[] = [];
  for (const l of raw as Partial<FloorLink>[]) {
    if (typeof l?.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(l.id) || ids.has(l.id) || typeof l.dir !== 'string' || !path.isAbsolute(l.dir)) continue;
    ids.add(l.id);
    links.push({
      id: l.id,
      name: typeof l.name === 'string' && l.name ? l.name.slice(0, 100) : path.basename(l.dir),
      repo: normalizeRepo(l.repo),
      dir: l.dir,
      addedBy: typeof l.addedBy === 'string' ? l.addedBy : '?',
      addedAt: typeof l.addedAt === 'number' ? l.addedAt : Date.now(),
    });
  }
  return links.length ? links.slice(0, MAX_LINKS) : undefined;
}

/** A path under the home folder as ~/…, for showing people. */
export function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** `p` with its symlinks resolved, or as it is when it isn't there. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function untildify(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** `dir` is `parent` or somewhere under it. */
function within(dir: string, parent: string): boolean {
  const rel = path.relative(parent, dir);
  return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Why the office couldn't make checkouts under `dir`, if it couldn't. It's made on the first clone, so it needn't exist yet. */
function unwritable(dir: string): string | undefined {
  let at = dir;
  while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  try {
    if (!statSync(at).isDirectory()) return `${tildify(at)} isn't a folder`;
    accessSync(at, constants.W_OK);
  } catch {
    return `The office can't write in ${tildify(at)}`;
  }
  return undefined;
}

/** The GitHub repository a checkout's origin points at. */
export function originRepo(dir: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    return /github\.com[/:]/i.test(url) ? normalizeRepo(url) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The GitHub repository a checkout's origin points at, read from its git config rather than asked of
 * git: the elevator lists hundreds of checkouts at once. A worktree's .git file leads to the config
 * of the repository it's a worktree of. Undefined for anything it can't make out.
 */
function configOrigin(dir: string): string | undefined {
  try {
    let git = path.join(dir, '.git');
    if (statSync(git).isFile()) {
      const to = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, 'utf8'))?.[1]?.trim();
      if (!to) return undefined;
      git = path.resolve(dir, to);
      const common = path.join(git, 'commondir');
      if (existsSync(common)) git = path.resolve(git, readFileSync(common, 'utf8').trim());
    }
    let inOrigin = false;
    let url: string | undefined;
    for (const line of readFileSync(path.join(git, 'config'), 'utf8').split('\n')) {
      const head = /^\s*\[(.*)\]\s*$/.exec(line);
      if (head) inOrigin = /^remote\s+"origin"$/.test(head[1].trim());
      else if (inOrigin) url ??= /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1];
    }
    return url && /github\.com[/:]/i.test(url) ? normalizeRepo(url) : undefined;
  } catch {
    return undefined;
  }
}

/** Clones `repo` to `dest`, or checks that what's already there is that repository. Resolves to an error, if any. */
async function cloneInto(repo: string, dest: string): Promise<string | undefined> {
  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory()) return `${dest} is already there and isn't a folder`;
    if (readdirSync(dest).length) {
      // Cloned before (a floor that was taken off the list, or by hand): move back in.
      return sameRepo(originRepo(dest), repo) ? undefined : `${dest} already exists and isn't a checkout of ${repo} — move it out of the way first`;
    }
  }
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
  } catch (err) {
    return `Couldn't make ${path.dirname(dest)}: ${(err as Error).message}`;
  }
  return new Promise((resolve) => {
    execFile('gh', ['repo', 'clone', repo, dest], { cwd: path.dirname(dest), timeout: CLONE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
      if (!err) return resolve(undefined);
      const why = String(stderr || err.message).trim().split('\n').filter(Boolean).slice(-2).join(' ');
      resolve(`Couldn't clone ${repo}: ${why || 'gh failed'}`);
    });
  });
}

async function listRepos(cwd: string): Promise<RepoChoice[]> {
  const out = await gh(
    [
      'api',
      '--paginate',
      'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
      '--jq',
      '.[] | {name: .full_name, description: (.description // ""), private: .private, pushedAt: .pushed_at}',
    ],
    cwd,
    90_000,
  );
  const repos: RepoChoice[] = [];
  const seen = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { name?: unknown; description?: unknown; private?: unknown; pushedAt?: unknown };
      const name = normalizeRepo(r.name);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      repos.push({
        name,
        description: typeof r.description === 'string' && r.description ? r.description.slice(0, 200) : undefined,
        private: r.private === true,
        pushedAt: typeof r.pushedAt === 'string' ? r.pushedAt : undefined,
      });
    } catch {
      // not a line of ours
    }
    if (repos.length >= MAX_REPOS) break;
  }
  return repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
}
