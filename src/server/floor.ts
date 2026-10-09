import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ChangesState, FloorInfo, FloorLinkInfo, GhIssue, GhPull, GhState, PeerInfo, ProjectInfo, ServerMsg, WorkerInfo } from '../shared/protocol.js';
import { isBusy } from '../shared/status.js';
import { DESK_BY_ID } from '../shared/layout.js';
import type { FloorDef, FloorLink } from './building.js';
import { repoKey, splitRepoKey } from '../shared/floors.js';
import { excludeFromGit } from './config.js';
import { agentProviders, configuredProvider } from './agents.js';
import { WorkerManager, type HookEnv, type RunAs } from './workers.js';
import { GitHub, MergeWatch } from './github.js';
import type { GhAs } from './signins.js';
import { TaskQueue } from './queue.js';
import { Changes } from './changes.js';
import { Decor } from './decor.js';
import { Docs } from './docs.js';
import { Dog } from './dog.js';
import { Court } from './court.js';
import { Jukebox } from './jukebox.js';
import { Whiteboard } from './whiteboard.js';
import { MeetingRoom } from './meetings.js';
import { landedWorkers } from './leave-on-merge.js';
import type { Ledger } from './usage.js';
import type { Capacity } from './machine.js';
import { officePrompt, type PromptSource } from './prompts.js';

type ToastLevel = 'info' | 'warn' | 'error';

/** What a floor needs from the building around it. */
export interface FloorContext {
  agentCmd: string;
  agentArgs: string[];
  hook: HookEnv;
  /** Spend, across every floor. */
  ledger: Ledger;
  /** The office's worker limit, across every floor. */
  capacity: Capacity;
  /** The office's prompts and the worker everyone starts on, as set in ⚙️ Settings. */
  prompts: PromptSource;
  /** Workers hired by an account run on its own sign-ins (see signins.ts). */
  runAs?: RunAs;
  /** How to run gh as an account: its own sign-in, the office's (undefined), or why it can't. */
  ghAs(owner: string | undefined): GhAs | undefined | string;
  /** To everyone on this floor. */
  emit(floor: Floor, msg: ServerMsg, droppable?: boolean): void;
  toast(floor: Floor, text: string, level?: ToastLevel): void;
  /** A worker's terminal output, for whoever has that terminal open. */
  termData(workerId: string, data: string, viewers: string[]): void;
  /** What a worker changed, for whoever has its Changes window open. */
  changes(state: ChangesState, clients: string[]): void;
  /** A worker on this floor changed, or left (then just its id). */
  workerChanged(floor: Floor, w: WorkerInfo | string): void;
  /** How many people are on this floor right now. */
  people(floor: Floor): number;
  /** Who's on this floor, and where they stand. */
  peers(floor: Floor): PeerInfo[];
  /** ⚙️ Settings: a worker whose pull request merged goes home by itself. */
  leaveOnMerge(): boolean;
  /** Another floor of the building: a worker across repositories works in its project too (see WorkerInfo.repos). */
  floor(id: string): Floor | undefined;
  /** This floor's pull requests came back: a worker on another floor with a repository here may have landed. */
  pullsChanged(floor: Floor): void;
  /** Whether a worker on another floor works in this floor's project too. */
  lent(floor: Floor): boolean;
}

/** The open pull request among `pulls` (one repository's) whose head is `branch`. */
function openPull(pulls: GhPull[], branch: string): { number: number; url: string } | undefined {
  const pr = pulls.find((p) => p.state === 'OPEN' && p.headRefName === branch);
  return pr ? { number: pr.number, url: pr.url } : undefined;
}

/**
 * One of a floor's repositories with its issues and PRs: the floor's own checkout (no `checkout`), or
 * one linked to it (see FloorLink). Pull request numbers are only unique within one.
 */
interface Board {
  checkout?: string;
  name: string;
  repo?: string;
  dir: string;
  github: GitHub;
  /** Pull requests merging, to ring the gong for. */
  merges: MergeWatch;
}

/**
 * A floor's repositories' lists of issues or pull requests as one, for its boards, the floor's own
 * first. With more than one repository each item says which it's in (`repo`, its `label`, and
 * `checkout` for a linked one's), and an error says whose it is; with just the floor's own, it's that
 * repository's list as GitHub sent it. It was fetched as long ago as the oldest of them.
 */
export function gatherBoards<T extends GhIssue | GhPull>(lists: { checkout?: string; label: string; state: GhState<T> }[]): GhState<T> {
  if (lists.length === 1) return lists[0].state;
  const errors = lists.filter((l) => l.state.error).map((l) => `${l.label}: ${l.state.error}`);
  return {
    items: lists.flatMap(({ checkout, label, state }) => state.items.map((it) => ({ ...it, repo: label, checkout }))),
    fetchedAt: Math.min(...lists.map((l) => l.state.fetchedAt)),
    loading: lists.some((l) => l.state.loading),
    error: errors.length ? errors.join(' · ') : undefined,
  };
}

/** What changed on a floor's boards, for boardsChanged. */
type BoardChange = { issues?: boolean; pulls?: boolean; settled?: boolean };

/**
 * Calls `flush` once things have been quiet for `wait` ms, with everything `add` was given since: a
 * flag is set when any of those calls set it. `flush` reads whatever it needs as it is by then.
 */
export function batched<T extends Record<string, boolean | undefined>>(flush: (due: T) => void, wait = 0): { add(what: T): void; stop(): void } {
  let due: Record<string, boolean | undefined> | undefined;
  let timer: NodeJS.Timeout | undefined;
  return {
    add(what) {
      due ??= {};
      for (const [k, v] of Object.entries(what)) due[k] ||= v;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const now = due as T;
        due = undefined;
        timer = undefined;
        flush(now);
      }, wait);
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
      due = undefined;
    },
  };
}

/** The branch a checkout is on, or undefined (detached, or not a git checkout). */
function branchOf(dir: string): string | undefined {
  try {
    const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    return b && b !== 'HEAD' ? b : undefined;
  } catch {
    return undefined;
  }
}

/** How long after a PR list or a worker's change the office looks for workers whose PR merged. */
const LANDED_DELAY_MS = 1500;
/** Boards on a floor nobody is on, with nothing running, are asked GitHub about this seldom. */
const IDLE_REFRESH_MS = 10 * 60_000;
const REFRESH_MS = 90_000;
/** How long the boards wait for the floor's other repositories' lists before everyone hears (see boardsChanged). */
const BOARDS_WAIT_MS = 250;

/** What `git` says about a checkout: its name, branch and origin for the top bar. */
export function projectInfo(dir: string, name: string, agentCmd: string, agentArgs: string[]): ProjectInfo {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return undefined;
    }
  };
  return {
    name,
    dir,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    remote: git(['remote', 'get-url', 'origin']),
    agentCmd: [agentCmd, ...agentArgs].join(' '),
    defaultProvider: configuredProvider(agentCmd),
    agentProviders: agentProviders(configuredProvider(agentCmd)),
  };
}

/**
 * One floor of the building: a project's checkout with its own desks and workers, issues and PR
 * boards, task queue, pictures and jukebox, all kept in that checkout's .agent-office folder. Other
 * repositories' checkouts can be linked to it (see FloorLink): workers are hired in those too, and
 * their issues and pull requests are on the boards with the floor's own. A meeting works in whichever
 * of them it's called in (see Meeting.checkout); the task queue and the board agents work in the
 * floor's own checkout.
 */
export class Floor {
  readonly id: string;
  readonly dir: string;
  readonly project: ProjectInfo;
  readonly workers: WorkerManager;
  /** The floor's own repository's issues and pull requests (see boards for every repository's). */
  readonly github: GitHub;
  readonly queue: TaskQueue;
  readonly changes: Changes;
  readonly decor: Decor;
  readonly jukebox: Jukebox;
  /** The whiteboard everyone on the floor draws on together. */
  readonly whiteboard: Whiteboard;
  /** The meeting room, where workers work through a question together (see meetings.ts). */
  readonly meetings: MeetingRoom;
  /** The bookshelf: the project's Markdown files (see docs.ts). */
  readonly docs: Docs;
  /** Settles once the workers whose terminals outlived the last office are picked back up, and the rest woken. */
  readonly ready: Promise<void>;
  readonly dog: Dog;
  /** The basketball by the hoop: who has it, or how it was last thrown. */
  readonly court = new Court();
  private timer: NodeJS.Timeout;
  /** Each of the floor's repositories, its own first (see setLinks). */
  private boards: Board[] = [];
  /** The linked checkouts as the elevator shows them. */
  private linkInfo: FloorLinkInfo[] = [];
  /** Boards that changed since everyone last heard (see boardsChanged). */
  private boardFlush = batched<BoardChange>((due) => this.flushBoards(due), BOARDS_WAIT_MS);
  /** A look for workers whose pull request merged, due shortly (see sendLandedHome). */
  private landedTimer?: NodeJS.Timeout;
  /** Workers across repositories whose worktrees are being checked before they go home. */
  private landing = new Set<string>();

  constructor(
    readonly def: FloorDef,
    private ctx: FloorContext,
  ) {
    this.id = def.id;
    this.dir = def.dir;
    const dataDir = path.join(def.dir, '.agent-office');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    excludeFromGit(def.dir);
    this.project = projectInfo(def.dir, def.name, ctx.agentCmd, ctx.agentArgs);
    this.docs = new Docs(def.dir);

    // Before the workers, so it hears about the ones who wake up needing input.
    this.dog = new Dog(def.id, dataDir, {
      workers: () => this.workers?.list() ?? [],
      people: () => ctx.peers(this),
      send: (dog) => ctx.emit(this, { t: 'dog', dog }),
    });

    this.workers = new WorkerManager(
      def.dir,
      dataDir,
      ctx.agentCmd,
      ctx.agentArgs,
      ctx.hook,
      {
        update: (worker) => {
          ctx.emit(this, { t: 'worker.update', worker });
          // Still being built: the first updates come from waking the workers already at their desks.
          this.queue?.onWorker(worker);
          this.meetings?.onWorker(worker);
          this.dog.onWorker(worker);
          ctx.workerChanged(this, worker);
          // Its turn ended, or whoever had its terminal open closed it: it may be free to go now.
          this.sendLandedHome();
        },
        remove: (workerId) => {
          this.changes?.forget(workerId);
          ctx.emit(this, { t: 'worker.remove', workerId });
          this.queue?.onWorkerGone(workerId);
          this.meetings?.onWorkerGone(workerId);
          this.dog.onWorkerGone(workerId);
          ctx.workerChanged(this, workerId);
        },
        data: (workerId, data, viewers) => ctx.termData(workerId, data, viewers),
        screen: (workerId, frame) => ctx.emit(this, { t: 'screen', workerId, ...frame }, true),
        toast: (text, level) => ctx.toast(this, text, level),
      },
      ctx.ledger,
      ctx.capacity,
      ctx.prompts,
      ctx.runAs,
      undefined,
      def.links ?? [],
    );

    const own = this.board({ id: '', name: def.name, repo: def.repo, dir: def.dir });
    this.github = own.github;
    this.boards = [own];
    for (const l of def.links ?? []) this.boards.push(this.board(l));
    this.linkInfo = this.describeLinks(def.links ?? []);
    // The 📋 task queue seats workers by itself: it watches the workers and links PRs from GitHub.
    this.queue = new TaskQueue(dataDir, this.workers, !!this.project.branch, {
      update: (state) => {
        ctx.emit(this, { t: 'queue', state });
        // A task's pull request may just have been linked (or merged).
        this.sendLandedHome();
      },
      toast: (text, level) => ctx.toast(this, text, level),
      claimIssue: (issue, owner) => {
        const as = ctx.ghAs(owner);
        return typeof as === 'string' ? Promise.resolve(as) : this.github.claim(issue, as);
      },
      refreshGitHub: () => void this.github.refresh(),
      hiringPaused: () => ctx.ledger.hiringPaused,
      room: () => ctx.capacity.room(),
      emptied: () => {
        ctx.toast(this, '📋 The queue is empty: every task is done 🎉');
        ctx.emit(this, { t: 'gong', why: 'queue' });
      },
      worktreeNote: () => officePrompt(ctx.prompts, 'queue.worktree'),
    });

    // Meetings seat their own workers round the meeting room's table and run them round by round.
    const workers = this.workers;
    this.meetings = new MeetingRoom(
      def.dir,
      dataDir,
      {
        defaultProvider: this.workers.defaultProvider,
        get officeDefault() {
          return workers.officeDefault;
        },
        list: () => this.workers.list(),
        seat: (deskId, by, prompt, provider, model, effort, { checkout, ...meeting }, owner) => this.workers.spawn(deskId, by, prompt, false, 'agent', provider, model, effort, meeting, owner, [], checkout),
        prompt: (id, text, by) => this.workers.prompt(id, text, by),
        write: (id, data, by) => this.workers.write(id, data, by),
        kill: (id) => this.workers.kill(id),
      },
      {
        // As a worker's (see WorkerManager.checkoutHome), with worktrees only in a checkout on a branch.
        home: (checkout, at) => {
          const h = this.workers.checkoutHome(checkout, at);
          if (typeof h === 'string') return h;
          const git = h.link ? !!this.linkInfo.find((l) => l.id === h.link!.id)?.branch : !!this.project.branch;
          return { checkout: h.link?.id, name: h.link?.name ?? def.name, dir: h.dir, at: h.at, trees: git ? h.trees : undefined, ref: h.ref };
        },
      },
      {
        update: (state) => ctx.emit(this, { t: 'meeting', state }),
        toast: (text, level) => ctx.toast(this, text, level),
        hiringPaused: () => ctx.ledger.hiringPaused,
        postReview: (pr, file, owner, checkout) => {
          const as = ctx.ghAs(owner);
          if (typeof as === 'string') return Promise.reject(new Error(as));
          // On the pull request of the repository the meeting worked in: numbers are only unique within one.
          const gh = this.boardOf(checkout);
          return gh ? gh.review(pr, file, as) : Promise.reject(new Error(`${checkout} isn't on this floor any more`));
        },
        prompt: (id) => ctx.prompts.text(id),
      },
    );

    // What each worker changed, for the Changes window at its desk (see changes.ts).
    this.changes = new Changes(
      def.dir,
      this.project.branch,
      (workerId, repo) => {
        const w = this.workers.get(workerId);
        if (!w) return undefined;
        if (!repo) {
          const own = { name: w.name, cwd: w.worktree ? path.join(def.dir, w.worktree.path) : def.dir, rel: w.worktree?.path ?? '', worktreeBase: w.worktree?.base };
          // In a linked checkout: diffed against, and PRs opened against, that repository's branch.
          const b = w.checkout ? this.boards.find((x) => x.checkout === w.checkout) : undefined;
          if (!b) return own;
          return {
            ...own,
            cwd: w.worktree ? own.cwd : b.dir,
            baseBranch: w.worktree?.from ?? branchOf(b.dir) ?? null,
            openPull: (branch) => openPull(this.pullsOf(b.checkout), branch),
            refreshGitHub: () => void b.github.refresh(),
          };
        }
        // One of the other repositories it works in: diffed against, and PRs opened against, that repository's branch.
        const r = w.repos?.find((x) => repoKey(x) === repo);
        if (!r) return undefined;
        const other = ctx.floor(r.floor);
        return {
          name: w.name,
          cwd: path.join(def.dir, r.path),
          rel: r.path,
          worktreeBase: r.base,
          baseBranch: r.from ?? null,
          openPull: (branch) => (other ? openPull(other.pullsOf(r.checkout), branch) : undefined),
          refreshGitHub: () => void other?.boardOf(r.checkout)?.refresh(),
        };
      },
      (branch) => openPull(this.pullsOf(undefined), branch),
      {
        state: (state, ids) => ctx.changes(state, ids),
        toast: (text, level) => ctx.toast(this, text, level),
        refreshGitHub: () => void this.github.refresh(),
      },
    );

    this.decor = new Decor(dataDir);
    this.jukebox = new Jukebox(dataDir);
    this.whiteboard = new Whiteboard(dataDir);
    this.ready = this.workers.start();

    void this.refresh();
    // A floor with people on it, or work under way, keeps its boards fresh; the others check in now and then.
    this.timer = setInterval(() => {
      if (this.active() || Date.now() - this.github.issues.fetchedAt > IDLE_REFRESH_MS) void this.refresh();
    }, REFRESH_MS);
  }

  /** A repository's issues and PRs, the floor's own when `link` has no id. */
  private board(link: Pick<FloorLink, 'id' | 'name' | 'repo' | 'dir'>): Board {
    const b: Board = { checkout: link.id || undefined, name: link.name, repo: link.repo, dir: link.dir, github: undefined!, merges: new MergeWatch() };
    b.github = new GitHub(
      link.dir,
      () => this.boardsChanged({ issues: true }),
      (state) => {
        // The queue seats its workers in the floor's own checkout.
        if (!b.checkout) this.queue?.onPulls(state.items);
        if (state.loading || state.error) return this.boardsChanged({ pulls: true });
        for (const p of b.merges.look(state.items)) {
          this.ctx.toast(this, `🎉 PR #${p.number} merged${b.checkout ? ` in ${b.repo ?? b.name}` : ''}: ${p.title}`);
          this.merged(p.number, undefined, b.checkout);
        }
        this.boardsChanged({ pulls: true, settled: true });
      },
    );
    return b;
  }

  /**
   * One of the boards changed: everyone on the floor hears about every repository's lists at once,
   * once they've been quiet for a moment (BOARDS_WAIT_MS), once for all the boards that changed in the meantime (each repository's refresh
   * lands on its own). With `settled`, a list of pull requests came in: the workers' branches and
   * merged PRs are looked at again then too, once.
   */
  private boardsChanged(what: BoardChange) {
    this.boardFlush.add(what);
  }

  private flushBoards(due: BoardChange) {
    if (due.issues) this.ctx.emit(this, { t: 'gh.issues', state: this.issues() });
    if (due.pulls) this.ctx.emit(this, { t: 'gh.pulls', state: this.pulls() });
    if (!due.settled) return;
    // A worker may have opened one from a branch it made itself, mid-turn or from a shell.
    void this.workers.syncBranches();
    this.sendLandedHome();
    this.ctx.pullsChanged(this);
  }

  /** The linked checkouts as the elevator shows them, with the branch each is on. */
  private describeLinks(links: FloorLink[]): FloorLinkInfo[] {
    return links.map((l) => ({ id: l.id, name: l.name, repo: l.repo, dir: l.dir, branch: branchOf(l.dir), addedBy: l.addedBy, addedAt: l.addedAt }));
  }

  /**
   * The checkouts linked to this floor changed (see Building.link): their boards come and go, and the
   * workers can be hired in (and Claude sessions are seated from) the ones there are now.
   */
  setLinks(links: FloorLink[]) {
    const next: Board[] = [this.boards[0]];
    for (const l of links) {
      const had = this.boards.find((b) => b.checkout === l.id);
      const b = had ?? this.board(l);
      next.push(b);
      if (!had) void b.github.refresh();
    }
    for (const b of this.boards) if (!next.includes(b)) b.github.stop();
    this.boards = next;
    this.linkInfo = this.describeLinks(links);
    this.workers.setLinks(links);
    this.boardsChanged({ issues: true, pulls: true });
  }

  /** A repository's issues and PRs on this floor: `checkout` names a linked one, none the floor's own. */
  boardOf(checkout: string | undefined): GitHub | undefined {
    return this.boards.find((b) => b.checkout === checkout)?.github;
  }

  /** Every repository's issues on this floor, for its board (see gather). */
  issues(): GhState<GhIssue> {
    return this.gather((g) => g.issues);
  }

  /** Every repository's pull requests on this floor, for its board (see gather). */
  pulls(): GhState<GhPull> {
    return this.gather((g) => g.pulls);
  }

  /** One repository's pull requests (`checkout` as for boardOf), labelled as on the board. */
  pullsOf(checkout: string | undefined): GhPull[] {
    return this.pulls().items.filter((p) => p.checkout === checkout);
  }

  /** Every repository's list as one, for the boards (see gatherBoards). */
  private gather<T extends GhIssue | GhPull>(of: (g: GitHub) => GhState<T>): GhState<T> {
    return gatherBoards(this.boards.map((b) => ({ checkout: b.checkout, label: b.repo ?? b.name, state: of(b.github) })));
  }

  /** Every repository's issues and PRs on this floor, asked of GitHub again. */
  refresh(): Promise<void> {
    return Promise.all(this.boards.map((b) => b.github.refresh())).then(() => undefined);
  }

  /** Pull request `n` merged (`by` someone, from the PR window), in a linked checkout's repository with `checkout`: the gong rings, once per PR. */
  merged(n: number, by?: string, checkout?: string) {
    const b = this.boards.find((x) => x.checkout === checkout);
    if (b?.merges.ring(n)) this.ctx.emit(this, { t: 'gong', why: 'merged', pr: n, by, checkout });
  }

  /**
   * With ⚙️ Settings' *go home once merged* on, sends home every worker whose pull request merged,
   * once it's at rest and nobody has its terminal open, deleting its worktree and branch unless they
   * hold work that isn't on GitHub. Called whenever that might have changed; it looks a moment later,
   * once for a burst of calls, and not from inside the event that prompted it.
   */
  sendLandedHome() {
    if (this.landedTimer || !this.ctx.leaveOnMerge()) return;
    this.landedTimer = setTimeout(() => {
      this.landedTimer = undefined;
      if (!this.ctx.leaveOnMerge()) return;
      const pullsOf = (key: string) => {
        const { floor, checkout } = splitRepoKey(key);
        return this.ctx.floor(floor)?.pullsOf(checkout);
      };
      // Each worker's own pull requests are in the repository it works in.
      const workers = this.workers.list();
      const tasks = this.queue.state().tasks;
      for (const landed of this.boards.flatMap((b) => landedWorkers(workers.filter((w) => w.checkout === b.checkout), this.pullsOf(b.checkout), tasks, pullsOf))) {
        const { worker, head, heads } = landed;
        if (!worker.repos?.length) {
          this.goHome(worker, `PR #${landed.pr} merged`, head);
          continue;
        }
        // Across repositories, one PR can merge before another repository's work even has one:
        // it goes once nothing is left that its merged PRs didn't deliver.
        if (this.landing.has(worker.id)) continue;
        this.landing.add(worker.id);
        void this.workers.holdsWork(worker.id, head, heads).catch(() => true).then((held) => {
          this.landing.delete(worker.id);
          if (!held && this.workers.get(worker.id) === worker) this.goHome(worker, `its pull requests merged (${landed.prs?.join(', ')})`, head, heads);
        });
      }
    }, LANDED_DELAY_MS);
  }

  private goHome(worker: WorkerInfo, why: string, head?: string, heads?: Record<string, string | undefined>) {
    const done = this.workers.kill(worker.id, undefined, head, heads);
    this.ctx.toast(this, `🏠 ${worker.name} went home: ${why}`);
    void done.then(({ note, error }) => {
      if (note) this.ctx.toast(this, note);
      if (error) this.ctx.toast(this, error, 'warn');
    });
  }

  /** Someone just walked in: boards that haven't been looked at in a while get fetched again. */
  arrived() {
    if (Date.now() - Math.max(this.github.issues.fetchedAt, this.github.pulls.fetchedAt) > REFRESH_MS) void this.refresh();
  }

  private active(): boolean {
    return this.ctx.people(this) > 0 || this.ctx.lent(this) || this.workers.list().some((w) => isBusy(w.status)) || this.queue.state().tasks.some((t) => t.status !== 'done') || this.meetings.state().current?.status === 'running';
  }

  info(): FloorInfo {
    const ws = this.workers.list();
    return {
      id: this.id,
      name: this.def.name,
      repo: this.def.repo,
      dir: this.dir,
      branch: this.project.branch,
      palette: this.def.palette,
      addedBy: this.def.addedBy,
      addedAt: this.def.addedAt,
      workers: ws.filter((w) => !DESK_BY_ID.get(w.deskId)?.station).length,
      busy: ws.filter((w) => w.status === 'working').length,
      waiting: ws.filter((w) => w.kind === 'agent' && (w.status === 'needs_input' || (w.status === 'done' && !w.acked))).length,
      people: this.ctx.people(this),
      links: this.linkInfo.length ? this.linkInfo : undefined,
    };
  }

  /** With `keep` (a restart), the workers' terminals keep running for the next office to pick up. */
  shutdown(keep = false) {
    clearInterval(this.timer);
    clearTimeout(this.landedTimer);
    this.boardFlush.stop();
    this.dog.stop();
    for (const b of this.boards) b.github.stop();
    this.queue.shutdown();
    this.meetings.shutdown();
    this.changes.stop();
    this.whiteboard.flush();
    this.workers.shutdown(keep);
  }
}
