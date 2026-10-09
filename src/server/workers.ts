import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync, accessSync, chmodSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, constants } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexUsageReader } from './codex-usage.js';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { AgentChoice, AgentEffort, AgentProvider, Run, TerminalHit, WorkerInfo, WorkerKind, WorkerRepo, WorkerStatus, WorkerTask } from '../shared/protocol.js';
import { FAILS_TO_DESPAIR, outputFailed, toolAction } from '../shared/actions.js';
import { FLAG_BOLD, FLAG_DIM, FLAG_INVERSE, RGB_FLAG, isAgentEffort, isClaudeModel } from '../shared/protocol.js';
import { WORKSPACE_FILES, WORKTREES_DIR, Worktrees, describeWork, workspaceOf, type WorktreeCleanup, type WorktreeRef, type WorktreeState } from './worktrees.js';
import { normalizeRepo, repoKey, sameRepo, splitRepoKey } from '../shared/floors.js';
import { DESK_BY_ID, STATION_AGENT, nextFreeSeat } from '../shared/layout.js';
import { QUEUE_AGENT_DISALLOWED_TOOLS, stationBrief } from './stations.js';
import { officePrompt, type PromptSource } from './prompts.js';
import { isBusy } from '../shared/status.js';
import { gh } from './github.js';
import type { GhAs } from './signins.js';
import type { ServiceOwner } from './services.js';
import { TaskNamer, fallbackTask } from './tasks.js';
import { addUsage, newTracker, restoreTracker, scanTracker, trackerUsage, zeroUsage, type Ledger, type UsageTracker } from './usage.js';
import { PtyHost, SCROLLBACK, type Adopted, type Pty } from './ptys.js';
import { codexHookArgs, normalizeCodexHook, writeCodexHook } from './codex.js';
import { reportedUsage } from './reported-usage.js';
import { configuredProvider, isValidOpenCodeModel, validateWorkerEffort, validateWorkerModel } from './agents.js';
import { mergeOpenCodeConfigContent, openCodePluginSpecifier, writeOpenCodePlugin, type OpenCodeStatusEvent } from './opencode.js';
import { ScrollbackStore, searchTerminal, terminalTail } from './history.js';
import { DropStore } from './drops.js';
import { screenSnapshot } from './screen.js';
import type { Capacity } from './machine.js';
import { claudeConfigDir, descendsFrom, liveClaudeSessions, realProcesses, sameProcess, sessionTitle, type LiveSession, type ProcessProbe } from './sessions.js';

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;
type Worktree = NonNullable<WorkerInfo['worktree']>;

const NAMES = [
  'Pixel', 'Byte', 'Nibble', 'Sprocket', 'Widget', 'Gizmo', 'Bolt', 'Cosmo', 'Dot', 'Echo',
  'Fizz', 'Glitch', 'Hopper', 'Jinx', 'Kilo', 'Lumen', 'Mochi', 'Noodle', 'Orbit', 'Pip',
  'Quark', 'Rivet', 'Sparky', 'Tofu', 'Uno', 'Volt', 'Waffle', 'Zippy',
];
const COLORS = ['#ff8a5b', '#5bc0eb', '#9bc53d', '#fde74c', '#c3423f', '#b388eb', '#f7aef8', '#72ddf7', '#ffb400', '#00a6a6'];

// Env vars from a parent agent session (e.g. starting the office from inside Claude Code) that
// would make a worker think it is a child session — that silently turns off transcript saving,
// which breaks resume.
const SCRUB_ENV = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'NO_COLOR', 'FORCE_COLOR', 'VSCODE_INJECTION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
]);
const SCRUB_PREFIXES = ['CLAUDE_CODE_SESSION', 'CLAUDE_CODE_CHILD', 'CLAUDE_CODE_MESSAGING', 'NEBULA_', 'AGENT_OFFICE_'];
const scrubbed = (k: string) => SCRUB_ENV.has(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p));

const SCREEN_INTERVAL_MS = 250;
/** What a worker with a live terminal can be doing. */
const RUNNING = new Set<unknown>(['starting', 'idle', 'working', 'done', 'needs_input'] satisfies WorkerStatus[]);
const LATE_PROMPT_GRACE_MS = 5000;
const KEYFRAME_MS = 8000;
/** How often a steady typist's "last typed" time is refreshed for everyone. */
const TYPED_REFRESH_MS = 15_000;
/** How many of a worker's latest prompts and tool calls the task namer sees. */
const TASK_PROMPTS = 5;
const TASK_TOOLS = 10;
/** While a worker works, refresh its task summary after this many tool calls, at most this often. */
const TASK_REFRESH_TOOLS = 8;
const TASK_REFRESH_MS = 90_000;
const PR_TITLE_MAX = 72;
const PR_TASK_MAX = 2500;
/** The most other repositories one worker can take on (see WorkerInfo.repos). */
export const MAX_REPOS = 8;
/** Around the list of a change's pull requests in each of their descriptions, so it can be brought up to date. */
const RELATED_START = '<!-- agent-office:related -->';
const RELATED_END = '<!-- /agent-office:related -->';
/**
 * A hook finding the office restarting (its workers keep running through that) retries, once a
 * second, this many times in all: long enough for a dev-server reload.
 */
const HOOK_TRIES = 6;
/** How often every worker's transcript is checked for new spend, on top of the hook-driven checks. */
const USAGE_SCAN_MS = 10_000;
/** How often a terminal with new output is saved to disk, so even a crash loses at most this much. */
const SAVE_SCROLLBACK_MS = 15_000;
/** Between a worker's saved scrollback and what it prints after the office restarted. */
/** What a worker for a session in someone's terminal is called when nobody has typed anything into it yet. */
const TERMINAL_NAME = 'Terminal session';
const TERMINAL_NAME_MAX = 40;
/** How long a worker's last terminal's process (and what ran under it) still counts as the office's once it's gone. */
const LAST_PTY_MS = 30_000;
const RESTORED_NOTE = '\x1b[2m──── the office restarted · earlier output above ────\x1b[0m\r\n';
/**
 * What a worker whose terminal didn't make it through a restart (the machine rebooted, the terminal
 * host was replaced or died) is resumed with when it was in the middle of something, so it carries on
 * by itself instead of waiting at every desk for someone to type "continue".
 */
export const CARRY_ON_PROMPT = 'continue — the office restarted and interrupted you. Pick up where you left off; if you were waiting on an answer or a permission, ask again.';

export interface HookEnv {
  url: string;
  token: string;
}

/** Another floor's repository for a worker to work in too (see WorkerInfo.repos). */
export interface RepoSource {
  floor: string;
  /** One of that floor's linked checkouts (see LinkedCheckout) rather than its own; that floor can be this one. */
  checkout?: string;
  /** The floor's name, for messages. */
  name: string;
  /** owner/name on GitHub, when known. */
  repo?: string;
  /** Its checkout. */
  dir: string;
}

/**
 * Another repository's checkout on this floor besides its own (see FloorLink): workers can be hired in
 * it (WorkerInfo.checkout), and Claude sessions in a terminal there are seated here too.
 */
export interface LinkedCheckout {
  id: string;
  name: string;
  repo?: string;
  dir: string;
}

/** A checkout a worker works in, git plumbing for it, and a worktree of the worker's in its terms (see home). */
export interface Home {
  dir: string;
  trees: Worktrees;
  /** A worktree whose path is relative to the floor's dir, where it lives, with that path relative to this checkout instead. */
  ref<T extends { path?: string }>(wt: T): T;
}

/**
 * The repositories a new worker works in too (see WorkerInfo.repos), from their repoKeys: `own` is
 * the one it's hired in, and `find` looks a checkout up as the building has it now (a floor's, or a
 * link's). Why not, when one is its own or is no longer in the building.
 */
export function repoSources(keys: string[], own: string, find: (at: { floor: string; checkout?: string }) => { name: string; repo?: string; dir: string } | undefined): RepoSource[] | string {
  const found: RepoSource[] = [];
  for (const key of keys) {
    if (key === own) return "The worker's own project is already in its workspace";
    const at = splitRepoKey(key);
    const there = find(at);
    if (!there) return 'That project is no longer in the building';
    found.push({ floor: at.floor, checkout: at.checkout, name: there.name, repo: there.repo, dir: there.dir });
  }
  return found;
}

/** A pull request 'worker.pr' opened, or found already open, for a worker's branch. */
export interface OpenedPr {
  /** For a worker across repositories: which of its repositories (the folder in its workspace). */
  repo?: string;
  number: number;
  url: string;
  /** The branch already had it. */
  existed: boolean;
  /** The worktree still has uncommitted changes, which aren't in it. */
  dirty: boolean;
}

/**
 * Runs a worker as the account that hired it, on that account's own Claude and GitHub sign-ins
 * (see signins.ts). Workers hired without an account run as the office, as they always have.
 */
export interface RunAs {
  /** Whether the account has a Claude sign-in its workers can start on. */
  claudeReady(owner: string): boolean;
  /** What to tell the account when it hasn't. */
  why(which: 'claude'): string;
  /** Puts the account's sign-ins in place of the office's in `env`; `dirs` are where the worker starts. */
  apply(owner: string, env: Record<string, string>, dirs: string[]): Record<string, string>;
}

interface Worker {
  info: WorkerInfo;
  /** The account that hired it, whose sign-ins it runs on. None: the office's own. */
  owner?: string;
  pty?: Pty;
  term?: HeadlessTerminal;
  ser?: InstanceType<typeof serialize.SerializeAddon>;
  /** The screen so far, for a browser opening the terminal (see screen.ts). */
  snapshot?: () => string;
  viewers: Map<string, string>; // clientId -> name
  screenDirty: boolean;
  lastLines: string[];
  leftNeedsInputAt: number;
  keyframeAt: number;
  hookToken: string;
  /** Claude never reported SessionStart: it's stuck on a trust/login/onboarding screen. */
  bootBlocked?: boolean;
  /** OpenCode errors keep the desk visibly actionable until a new turn starts. */
  openCodeError?: boolean;
  codexUsage: CodexUsageReader;
  codexHome?: string;
  codexTranscript?: string;
  codexTools: Map<string, string>;
  codexPending: Set<string>;
  codexPermissionUnknown?: boolean;
  /** Test runs and builds that have failed in a row (see FAILS_TO_DESPAIR). */
  failStreak: number;
  /** Its latest prompts and tool calls, for naming its task. */
  prompts: string[];
  tools: string[];
  toolsSinceNamed: number;
  namedAt: number;
  /** Bumped by /clear: a new conversation, so a new task. */
  taskEpoch: number;
  /** Where the session's tokens and cost are read from (see usage.ts). */
  tracker: UsageTracker;
  scanTimer?: NodeJS.Timeout;
  /** Its terminal in the host as of the last save, and how it was doing, to pick back up after a restart. */
  saved?: { ptyId: string; pid?: number; status: WorkerStatus; acked: boolean; waitingSince?: number };
  /** Its process went away mid-turn with the office or the terminal host: its next start carries on (CARRY_ON_PROMPT). */
  interrupted?: boolean;
  /** Output since its scrollback was last saved to disk. */
  unsaved?: boolean;
  /** Where this run's own output starts, below the scrollback carried over from before. */
  fresh?: { readonly line: number };
  /**
   * It came from a Claude session in someone's terminal (WorkerInfo.external): the folder that session
   * ran in, which it carries on in (Claude keeps a conversation under the folder it ran in, so
   * --resume only finds it from there), and when that terminal's process started, to tell it from a
   * later process with the same pid.
   */
  terminal?: { cwd: string; procStart?: string };
  /** Its terminal session ended on its own: it sleeps until someone wakes it (R, a prompt), not with wakeAll. */
  noWake?: boolean;
  /** Its last terminal's process, and when it went: the office's own for a little while after (see ours). */
  lastPty?: { pid: number; at: number };
  /** The name of the linked checkout it works in (WorkerInfo.checkout), for saying so once the floor no longer has it (see stranded). */
  checkoutName?: string;
  /**
   * Which repository that linked checkout is: its folder with symlinks resolved, and its origin. A
   * link by the same id that's another repository isn't this worker's (see linkOf).
   */
  checkoutAt?: { dir: string; repo?: string };
}

export interface WorkerEvents {
  update(info: WorkerInfo): void;
  remove(workerId: string): void;
  data(workerId: string, data: string, viewers: string[]): void;
  screen(workerId: string, frame: { cols: number; rows: number; lines: Record<number, Run[]>; full: boolean; cursor: [number, number] }): void;
  toast(text: string, level: 'info' | 'warn' | 'error'): void;
}

export class WorkerManager {
  private workers = new Map<string, Worker>();
  private statePath: string;
  private settingsPath: string;
  private trees: Worktrees;
  private agentPath: string | null = null;
  readonly defaultProvider: AgentProvider;
  private openCodePlugin: string;
  private codexHook: string;
  /** Where the office-queue command is, for the board agents' PATH (see writeQueueCommand). */
  private queueBin: string | undefined;
  private screenTimer: NodeJS.Timeout;
  /** The office is shutting down: workers exiting now are being stopped, not failing to resume. */
  private closing = false;
  /** Closing for good (Ctrl+C), not restarting: whatever the workers were doing is stopped on purpose. */
  private stopping = false;
  private namer: TaskNamer;
  private usageTimer: NodeJS.Timeout;
  /** Runs the workers' terminals outside the office, so they outlive a restart of it (see ptys.ts). */
  private host: PtyHost;
  /** Each worker's terminal on disk, so a restart doesn't wipe it (see history.ts). */
  private scrollback: ScrollbackStore;
  private drops: DropStore;
  private saveTimer: NodeJS.Timeout;
  /**
   * The terminal sessions (by their Claude process) that aren't to come back as workers while they
   * run: sent home from their desk, or taken over by the office (see syncTerminals). Kept in memory:
   * a restarted office shows them again.
   */
  private dismissed = new Set<number>();
  /** This floor's checkouts, as given and with their symlinks resolved, as the sessions' folders are (see roots). */
  private rootCache?: { checkout?: string; dirs: string[] }[];
  /** Git plumbing for each linked checkout, by its id: it keeps when it last fetched. */
  private linkTrees = new Map<string, Worktrees>();
  /** Whether a Claude process runs under one of this floor's terminals, by pid, and which terminals those were (`of`). */
  private underUs = new Map<number, { under: boolean; of: string }>();

  constructor(
    private dir: string,
    private dataDir: string,
    private agentCmd: string,
    private agentArgs: string[],
    private hook: HookEnv,
    private events: WorkerEvents,
    private ledger: Ledger,
    /** The office's worker limit, across every floor (see machine.ts). */
    private capacity?: Capacity,
    /** The office's prompts and the worker everyone starts on, as set in ⚙️ Settings (see prompts.ts). */
    private prompts?: PromptSource,
    /** Everyone's own sign-ins, for workers hired by an account. */
    private runAs?: RunAs,
    /** How processes outside the office are looked at (see sessions.ts); tests stand one in. */
    private probe: ProcessProbe = realProcesses,
    /** The other repositories' checkouts on this floor (see setLinks). */
    private links: LinkedCheckout[] = [],
  ) {
    this.defaultProvider = configuredProvider(agentCmd);
    this.trees = new Worktrees(dir);
    this.statePath = path.join(dataDir, 'workers.json');
    this.settingsPath = path.join(dataDir, 'claude-hooks.json');
    this.writeHookSettings();
    this.openCodePlugin = writeOpenCodePlugin(dataDir);
    this.codexHook = writeCodexHook(dataDir);
    this.queueBin = this.writeQueueCommand();
    this.agentPath = resolveCommand(agentCmd);
    const claude = this.defaultProvider === 'claude' ? this.agentPath : resolveCommand('claude');
    this.namer = new TaskNamer(claude, childEnv(), () => officePrompt(this.prompts, 'office.namer'), (id, task, ctx) => {
      const w = this.workers.get(id);
      if (!w || w.taskEpoch !== ctx.epoch) return;
      w.info.task = task;
      this.emitUpdate(w);
      this.persist();
    });
    this.host = new PtyHost(dataDir, () => this.events.toast("The workers' terminal host stopped — resuming them", 'warn'));
    this.scrollback = new ScrollbackStore(dataDir);
    this.drops = new DropStore(dataDir);
    this.restore();
    this.scrollback.prune(new Set(this.workers.keys()));
    this.drops.prune(new Set(this.workers.keys()));
    // A session may have ended (and written its final tally) while the office was down.
    for (const w of this.workers.values()) this.scanUsage(w);
    this.screenTimer = setInterval(() => this.flushScreens(), SCREEN_INTERVAL_MS);
    this.usageTimer = setInterval(() => {
      for (const w of this.workers.values()) this.scanUsage(w);
    }, USAGE_SCAN_MS);
    this.saveTimer = setInterval(() => {
      for (const w of this.workers.values()) if (w.unsaved) this.saveScrollback(w);
    }, SAVE_SCROLLBACK_MS);
  }

  /**
   * Picks every worker whose terminal outlived the last office (a dev-server reload, an upgrade)
   * back up where it is, mid-turn or not. Whoever else was at a desk when the office stopped (a
   * restart, a crash) gets straight back to work, carrying on with whatever it was in the middle of.
   * Call once, before anyone can walk in.
   */
  async start() {
    await this.host.connect();
    await Promise.all(
      [...this.workers.values()].map(async (w) => {
        // Its repository isn't on the floor: its terminal waits in the host until it's back (see setLinks).
        if (this.stranded(w.info.id)) return;
        const saved = w.saved;
        w.saved = undefined;
        const adopted = saved && (await this.host.attach(saved.ptyId));
        if (adopted) this.adopt(w, adopted, saved);
      }),
    );
    // Terminals nobody saved a claim on (their worker was sent home as the office went down), but
    // not those of workers whose repository is off the floor for now.
    this.host.killUnclaimed(new Set([...this.workers.values()].flatMap((w) => (w.saved ? [w.saved.ptyId] : []))));
    this.wakeAll();
    // It may have switched branches while the office was down, its terminal still going.
    void this.syncBranches();
  }

  get resolvedAgent(): string | null {
    return this.agentPath;
  }

  /** What an agent starts on when whoever starts it doesn't pick: the one set in ⚙️ Settings, or the office's --agent. */
  get officeDefault(): AgentChoice {
    const picked = this.prompts?.agent();
    if (picked && (picked.provider !== 'custom' || this.defaultProvider === 'custom')) return picked;
    return { provider: this.defaultProvider };
  }

  list(): WorkerInfo[] {
    return [...this.workers.values()].map((w) => w.info);
  }

  get(id: string): WorkerInfo | undefined {
    return this.workers.get(id)?.info;
  }

  /** The account a worker runs as (see RunAs), if not the office. */
  ownerOf(id: string): string | undefined {
    return this.workers.get(id)?.owner;
  }

  /** Each worker's terminal process and directory, to tell whose servers are whose. */
  owners(): ServiceOwner[] {
    return [...this.workers.values()].map((w) => ({
      workerId: w.info.id,
      // A session in someone's terminal: its own Claude process, whose servers they are.
      pid: w.pty?.pid ?? w.info.external?.pid,
      agent: w.info.kind === 'agent',
      cwd: this.cwd(w.info),
      // A worktree lives in this floor's checkout, whichever repository it's of.
      root: workspaceOf(w.info) ? this.dir : this.homeDir(w.info),
    }));
  }

  /** The other repositories' checkouts on this floor changed (one was linked, or unlinked). */
  setLinks(links: LinkedCheckout[]) {
    const stranded = [...this.workers.values()].filter((w) => this.stranded(w.info.id));
    this.links = links;
    this.rootCache = undefined;
    for (const id of this.linkTrees.keys()) if (!links.some((l) => l.id === id)) this.linkTrees.delete(id);
    // Its repository is back on the floor: so is the worker, terminal and all, as after a restart.
    for (const w of stranded) {
      // The same repository, linked again by another name: it works in that one now.
      const again = !this.linkOf(w) && w.checkoutAt && links.find((l) => sameCheckout(l, w.checkoutAt));
      if (again) {
        w.info.checkout = again.id;
        w.checkoutName = again.name;
      }
      if (this.stranded(w.info.id)) continue;
      w.info.activity = undefined;
      const saved = w.saved;
      w.saved = undefined;
      void (async () => {
        const adopted = saved && (await this.host.attach(saved.ptyId));
        if (this.workers.get(w.info.id) !== w) return;
        if (adopted) this.adopt(w, adopted, saved);
        else if (!w.noWake && !w.info.external) this.resume(w.info.id);
        else this.emitUpdate(w);
        this.persist();
      })();
    }
  }

  /**
   * Why a worker can't do anything right now: it works in a linked checkout the floor no longer has
   * (WorkerInfo.checkout; the floor was taken off and added back without it, or floors.json was
   * edited). It stays at its desk, with its worktree and its terminal (kept in the host), and isn't
   * resumed, woken, sent home or cleaned up until that repository is on the floor again.
   */
  stranded(id: string): string | undefined {
    const w = this.workers.get(id);
    const checkout = w?.info.checkout;
    if (!w || !checkout || this.linkOf(w)) return undefined;
    return `${w.info.name} works in ${w.checkoutName ?? checkout}, which isn't on this floor any more — add it back to carry on`;
  }

  /**
   * The linked checkout a worker works in, as the floor has it now: by its id, and only while that's
   * still the same repository (see Worker.checkoutAt). Undefined for one in the floor's own checkout.
   */
  private linkOf(w: Worker): LinkedCheckout | undefined {
    const link = w.info.checkout ? this.links.find((l) => l.id === w.info.checkout) : undefined;
    if (!link || !sameCheckout(link, w.checkoutAt)) return undefined;
    // Known from now on, so a different repository under this id later isn't taken for it.
    w.checkoutAt ??= { dir: realDir(link.dir), repo: link.repo };
    w.checkoutName = link.name;
    return link;
  }

  /**
   * Sends home a worker whose repository is off the floor (see stranded), forgetting it: nothing in git
   * is touched, so its worktree and branch stay where they are, for `agent-office prune` to tidy up.
   * Its terminal, kept in the host until now, ends. Returns a line for the team, or why it can't.
   */
  forget(id: string): { note: string } | string {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (!this.stranded(id)) return `${w.info.name} isn't missing its repository — send it home as usual`;
    this.workers.delete(id);
    this.namer.forget(id);
    clearTimeout(w.scanTimer);
    if (w.saved) this.host.killUnclaimed(undefined, w.saved.ptyId);
    w.saved = undefined;
    w.term?.dispose();
    this.scrollback.remove(id);
    this.drops.remove(id);
    this.events.remove(id);
    this.persist();
    const { name, worktree } = w.info;
    if (!worktree) return { note: `Forgot ${name}` };
    const repo = w.checkoutAt?.dir ?? w.checkoutName ?? w.info.checkout;
    return { note: `Forgot ${name}: its worktree ${path.join(this.dir, workspaceOf(w.info) ?? worktree.path)} and branch ${worktree.branch} are still there — run agent-office prune in ${this.dir} and in ${repo} to tidy them up` };
  }

  /**
   * The workers working in a linked checkout (WorkerInfo.checkout), by name: it can't be unlinked
   * while there are any. Workers with a worktree of it in their workspace are in WorkerInfo.repos.
   */
  onCheckout(linkId: string): string[] {
    return [...this.workers.values()].filter((w) => w.info.checkout === linkId && this.linkOf(w)).map((w) => w.info.name);
  }

  /**
   * The checkout a worker works in: one linked to this floor (WorkerInfo.checkout), or the floor's own.
   * Its worktree is kept in the floor's .agent-office/worktrees either way, so `ref` puts its path in
   * that checkout's terms for the git plumbing.
   */
  private home(info: { id?: string; checkout?: string }): Home | string {
    if (!info.checkout) return { dir: this.dir, trees: this.trees, ref: (wt) => wt };
    // A worker's: only while that id is still its repository (see linkOf).
    const w = info.id ? this.workers.get(info.id) : undefined;
    const link = w ? this.linkOf(w) : this.links.find((l) => l.id === info.checkout);
    // Never the floor's own instead: its worktrees and branches aren't this worker's.
    if (!link) return `${info.checkout} isn't on this floor any more`;
    let trees = this.linkTrees.get(link.id);
    if (!trees) {
      trees = new Worktrees(link.dir);
      this.linkTrees.set(link.id, trees);
    }
    return { dir: link.dir, trees, ref: (wt) => (wt.path ? { ...wt, path: path.relative(link.dir, path.join(this.dir, wt.path)) } : wt) };
  }

  /**
   * The checkout a meeting works in (Meeting.checkout), as home() has it for a worker: the floor's own
   * without `checkout`, or a linked one, with the git plumbing its workers use. `at` is the repository
   * it was when the meeting was called (see Worker.checkoutAt): it's found while the floor has it, under
   * that id or linked again under another (`link` says which); otherwise why not.
   */
  checkoutHome(checkout?: string, at?: { dir: string; repo?: string }): (Home & { link?: LinkedCheckout; at?: { dir: string; repo?: string } }) | string {
    if (!checkout) return this.home({});
    const link = this.links.find((l) => l.id === checkout && sameCheckout(l, at)) ?? (at ? this.links.find((l) => sameCheckout(l, at)) : undefined);
    if (!link) return `${checkout} isn't on this floor any more`;
    const own = this.home({ checkout: link.id });
    if (typeof own === 'string') return own;
    return { ...own, link, at: at ?? { dir: realDir(link.dir), repo: link.repo } };
  }

  /** The folder of the checkout a worker works in, or the floor's own when it's one the floor no longer has (see stranded). */
  private homeDir(info: { id?: string; checkout?: string }): string {
    const own = this.home(info);
    return typeof own === 'string' ? this.dir : own.dir;
  }

  /**
   * Fetches the branch the project is on, so a worktree made next starts from what's on GitHub now
   * (see Worktrees.fetch). Undefined when there's nothing to wait for.
   */
  fetchBase(checkout?: string): Promise<void> | undefined {
    const own = this.home({ checkout });
    return typeof own === 'string' ? undefined : own.trees.fetch();
  }

  deskOccupied(deskId: string): boolean {
    for (const w of this.workers.values()) if (w.info.deskId === deskId) return true;
    return false;
  }

  /**
   * Hires a worker at a desk. `meeting` seats one at the meeting room's table instead, for that meeting
   * (see meetings.ts), in the meeting's own worktree, which everyone at the table shares (cut from the
   * meeting's checkout, `checkout` then too). `repos` are
   * other floors' repositories a worker in its own worktree works in too (see makeWorkspace). With
   * `checkout`, one of this floor's linked checkouts, it works in that repository instead of the floor's
   * own (see WorkerInfo.checkout).
   */
  spawn(deskId: string, by: string, prompt?: string, worktree = false, kind: WorkerKind = 'agent', provider?: AgentProvider, model?: string, effort?: AgentEffort, meeting?: { id: string; worktree?: WorkerInfo['worktree'] }, owner?: string, repos: RepoSource[] = [], checkout?: string): WorkerInfo | string {
    // Nobody picked (a board agent, say): the office's default worker, model and effort included.
    if (kind === 'agent' && provider === undefined) ({ provider, model, effort } = this.officeDefault);
    const selectedProvider = kind === 'agent' ? provider : undefined;
    const modelError = validateWorkerModel(kind, selectedProvider, model);
    if (modelError) return modelError;
    const effortError = validateWorkerEffort(kind, selectedProvider, effort);
    if (effortError) return effortError;
    const seat = DESK_BY_ID.get(deskId);
    if (!seat) return 'Unknown desk';
    if (this.deskOccupied(deskId)) return seat.station ? `The ${STATION_AGENT[seat.station].name} is already there` : `That ${seat.beanbag ? 'bean bag' : 'desk'} is taken`;
    if (kind === 'shell' && seat.station) return 'A board agent is always an agent, not a shell';
    if (seat.station && !prompt?.trim()) return 'Tell the board agent what to do';
    if (!seat.room !== !meeting) return seat.room ? 'Only a meeting seats workers at the meeting table: call one in the meeting room' : 'A meeting seats its workers at the meeting table';
    if (meeting && (kind !== 'agent' || worktree)) return 'A meeting seats agents, in its own worktree';
    if (repos.length && (kind !== 'agent' || !worktree || seat.station || meeting)) return 'Only a worker in its own worktree can work in other repositories too';
    if (repos.length > MAX_REPOS) return `A worker can take on at most ${MAX_REPOS} other repositories`;
    if (checkout && !this.links.some((l) => l.id === checkout)) return "That repository isn't on this floor any more";
    if (checkout && seat.station) return "Board agents work in the floor's own checkout";
    if (kind === 'shell' && provider !== undefined) return 'Shell workers do not have an agent provider';
    if (kind === 'agent' && selectedProvider === 'custom' && this.defaultProvider !== 'custom') return 'Custom is not the configured agent provider';
    if (kind === 'agent') {
      const paused = this.ledger.hiringPaused;
      if (paused) return paused;
    }
    if (owner && selectedProvider === 'claude' && this.runAs && !this.runAs.claudeReady(owner)) return this.runAs.why('claude');
    const full = this.capacity?.full();
    if (full) return full;
    const used = new Set([...this.workers.values()].map((w) => w.info.name.replace(/ 🐚$/, '')));
    const agent = seat.station && STATION_AGENT[seat.station];
    const name = agent ? agent.name : (NAMES.find((n) => !used.has(n)) ?? `Worker ${this.workers.size + 1}`);
    const id = randomBytes(6).toString('hex');
    let wt: WorkerInfo['worktree'] = meeting?.worktree;
    let others: WorkerRepo[] | undefined;
    if (worktree) {
      const slug = `${name.toLowerCase()}-${id.slice(0, 4)}`;
      // Cut from the checkout it works in, but kept with this floor's other worktrees.
      const own = this.home({ checkout });
      if (typeof own === 'string') return own;
      const made = repos.length ? this.makeWorkspace(slug, repos, own) : own.trees.create(slug, undefined, this.dir);
      if (typeof made === 'string') return made;
      if ('repos' in made) {
        ({ worktree: wt, repos: others } = made);
        for (const note of made.notes) this.events.toast(`🌿 ${name}'s worktree of ${note}`, 'info');
      } else {
        const { note, ...ref } = made;
        wt = ref;
        if (note) this.events.toast(`🌿 ${name}'s worktree ${note}`, 'info');
      }
    }
    const info: WorkerInfo = {
      id,
      kind,
      provider: selectedProvider,
      model: selectedProvider === 'opencode' || selectedProvider === 'claude' ? model : undefined,
      effort: selectedProvider === 'claude' ? effort : undefined,
      deskId,
      name: kind === 'shell' ? `${name} 🐚` : name,
      color: kind === 'shell' ? '#8d99ae' : agent ? agent.color : COLORS[Math.floor(Math.random() * COLORS.length)],
      status: 'starting',
      acked: true,
      createdBy: by,
      createdAt: Date.now(),
      prompt: kind === 'shell' ? undefined : prompt?.trim() || undefined,
      worktree: wt,
      repos: others,
      checkout,
      cols: 100,
      rows: 30,
      viewers: [],
      viewerIds: [],
      activity: prompt ? truncate(prompt, 80) : undefined,
      meeting: meeting?.id,
    };
    const w = newWorker(info, newTracker());
    w.owner = owner;
    this.workers.set(id, w);
    if (info.prompt) this.notePrompt(w, info.prompt);
    // A board agent is told what it's there for ahead of its first request (which is what shows).
    this.launch(w, seat.station && info.prompt ? `${stationBrief(seat.station, this.prompts)}\n\n${info.prompt}` : info.prompt, undefined);
    this.persist();
    return info;
  }

  /**
   * The workspace of a worker across repositories: `.agent-office/worktrees/<slug>`, with a worktree of
   * the checkout it works in (`own`: this floor's project, or one linked to it) and of each of `repos`
   * in it, all on office/<slug>, and a brief for the agent (the 'worker.repos' prompt, as CLAUDE.md and
   * AGENTS.md). All or nothing: when one repository can't have its worktree, the ones already made are
   * taken out again.
   */
  private makeWorkspace(slug: string, repos: RepoSource[], own: Home = this.home({}) as Home): { worktree: NonNullable<WorkerInfo['worktree']>; repos: WorkerRepo[]; notes: string[] } | string {
    // A branch can only be checked out once per repository, and two floors can be checkouts of the same one.
    const seen = new Map<string, string>();
    const common = own.trees.commonDir();
    if (!common) return "This floor's project isn't a git checkout";
    seen.set(common, "this floor's project");
    for (const r of repos) {
      const theirs = new Worktrees(r.dir).commonDir();
      if (!theirs) return `${r.name} isn't a git checkout`;
      const twin = seen.get(theirs);
      if (twin) return `${r.name} is the same repository as ${twin}`;
      seen.set(theirs, r.name);
    }
    const names = workspaceNames([own.dir, ...repos.map((r) => r.dir)]);
    const made: { trees: Worktrees; ref: WorktreeRef }[] = [];
    const fail = (why: string) => {
      // Fresh branches with nothing on them: nothing is lost taking them out again.
      void (async () => {
        for (const m of made.reverse()) await m.trees.remove(m.ref, 'all');
        clearWorkspace(path.join(this.dir, WORKTREES_DIR, slug));
      })();
      return why;
    };
    const first = own.trees.create(slug, names[0], this.dir);
    if (typeof first === 'string') return fail(first);
    const { note, ...primary } = first;
    const notes = note ? [`${names[0]} ${note}`] : [];
    made.push({ trees: own.trees, ref: own.ref(primary) });
    const others: WorkerRepo[] = [];
    for (const [i, r] of repos.entries()) {
      const trees = new Worktrees(r.dir);
      const wt = trees.create(slug, names[i + 1], this.dir);
      if (typeof wt === 'string') return fail(`${r.name}: ${wt}`);
      if (wt.note) notes.push(`${names[i + 1]} ${wt.note}`);
      made.push({ trees, ref: { ...wt, path: path.relative(r.dir, path.join(this.dir, wt.path)) } });
      others.push({ floor: r.floor, checkout: r.checkout, name: names[i + 1], repo: r.repo, dir: r.dir, path: wt.path, branch: wt.branch, base: wt.base, from: wt.from });
    }
    const home = originRepo(own.dir) ?? path.basename(own.dir);
    const line = (name: string, project: string, from?: string, note = '') => `- \`${name}/\`: ${project}${from ? `, cut from ${from}` : ''}${note}`;
    const brief = officePrompt(this.prompts, 'worker.repos', {
      branch: primary.branch,
      home,
      repos: [line(names[0], home, primary.from, " (this floor's project)"), ...repos.map((r, i) => line(names[i + 1], r.repo ?? r.name, others[i].from))].join('\n'),
    });
    try {
      for (const file of WORKSPACE_FILES) writeFileSync(path.join(this.dir, WORKTREES_DIR, slug, file), `${brief.trim()}\n`);
    } catch (err) {
      return fail(`Could not write the workspace's brief: ${(err as Error).message}`);
    }
    return { worktree: primary, repos: others, notes };
  }

  /**
   * Starts a worker that isn't running again, carrying on its session, with `prompt` as its next
   * message. Never while a Claude process outside the office has that conversation open (two of them
   * would both write to it): only taking it over (`takeOver`, which someone confirmed) does that.
   */
  resume(id: string, prompt?: string, takingOver = false): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (w.pty) return 'Worker is already running';
    const why = this.stranded(id);
    if (why) return why;
    if (!takingOver) {
      // It's someone's terminal's to run: only taking it over (see takeOver) starts it here.
      if (w.info.external) return `${w.info.name} is running in your terminal — take it over to carry it on here`;
      const open = w.info.kind === 'agent' && w.info.sessionId ? this.holder(w.info.sessionId) : undefined;
      if (open) return `${w.info.name}'s conversation is open in a terminal (PID ${open.pid}) — close it there or use Take over`;
    }
    // Woken on purpose: from now on it wakes up with everyone else again.
    w.noWake = false;
    w.info.status = 'starting';
    w.info.exitCode = undefined;
    const station = DESK_BY_ID.get(w.info.deskId)?.station;
    // A board agent with no session to carry on starts over, so it needs telling what it's for again.
    const first = prompt && station && !w.info.sessionId ? `${stationBrief(station, this.prompts)}\n\n${prompt}` : prompt;
    if (prompt) {
      w.info.activity = truncate(prompt, 80);
      this.notePrompt(w, prompt);
    }
    // Cut off mid-turn by a restart: it gets on with it, as whoever was watching would have told it to.
    const carryOn = !prompt && w.interrupted && w.info.kind === 'agent' && !!w.info.sessionId;
    w.interrupted = false;
    this.launch(w, carryOn ? CARRY_ON_PROMPT : first, w.info.sessionId);
    return undefined;
  }

  /**
   * A request for the agent standing by a board (see STATIONS): typed into its session, which is woken
   * up with it if it's asleep, or it's hired there with it when nobody is. Returns what went wrong, or
   * the agent and whether it was just hired.
   */
  station(deskId: string, by: string, text: string, owner?: string): { info: WorkerInfo; hired: boolean } | string {
    if (!DESK_BY_ID.get(deskId)?.station) return 'There is no agent to ask there';
    const clean = text.replace(/\r\n?/g, '\n').trim();
    if (!clean) return 'Empty prompt';
    const w = [...this.workers.values()].find((x) => x.info.deskId === deskId);
    if (!w) {
      const info = this.spawn(deskId, by, clean, false, 'agent', undefined, undefined, undefined, undefined, owner);
      return typeof info === 'string' ? info : { info, hired: true };
    }
    // Typed into the question it's asking, the prompt would answer it.
    if (w.info.status === 'needs_input') return `The ${w.info.name} is waiting on an answer in its terminal`;
    if (!w.pty) w.info.lastInput = { by, at: Date.now() };
    const err = w.pty ? this.prompt(w.info.id, clean, by) : this.resume(w.info.id, clean);
    return err ?? { info: w.info, hired: false };
  }

  /** The worker whose terminal holds this hook token: how a worker proves it's asking for itself. */
  authenticate(id: string, token: string): WorkerInfo | undefined {
    const w = this.workers.get(id);
    return w?.pty && token && safeEq(token, w.hookToken) ? w.info : undefined;
  }

  /** Starts every worker that isn't running: nobody should be found asleep at their desk. */
  wakeAll() {
    // Except a session in someone's terminal, running there, and one that was until it ended there:
    // whoever left it can pick it up with R.
    // Nor one whose repository is off the floor (see stranded).
    for (const w of this.workers.values()) if (!w.pty && !w.info.external && !w.noWake && !this.stranded(w.info.id)) this.resume(w.info.id);
  }

  /**
   * Seats the Claude Code sessions running in someone's own terminal in this floor's checkout (see
   * sessions.ts; `live` is every one on the machine) at free desks, as workers that say they're in
   * that terminal (WorkerInfo.external), and lets those whose process has gone become sleeping
   * workers that only R wakes (noWake), carrying their conversation on in the office. One whose
   * conversation a terminal has open now, resumed there, is that terminal's again. Nothing is ever
   * started or stopped here. Sessions in the office's worktrees and workspaces are left out (they're
   * the office's own workers), and so are the office's own workers here, by their process (or one of
   * its parents) or their session. `live` is null when the registry couldn't be read: then nothing
   * changes. `titleOf` names a new one (by default from the first thing typed into it).
   */
  syncTerminals(live: LiveSession[] | null = liveClaudeSessions(claudeConfigDir(), this.probe), titleOf: (s: LiveSession) => string | undefined = (s) => sessionTitle(claudeConfigDir(), s.cwd, s.sessionId) ?? s.name) {
    // The registry couldn't be read: that says nothing about who's running, so nothing changes.
    if (!live) return;
    const byPid = new Map(live.map((s) => [s.pid, s]));
    // Its process is gone: the pid may come round again for something else.
    for (const pid of this.dismissed) if (!byPid.has(pid) && !this.probe.alive(pid)) this.dismissed.delete(pid);
    for (const pid of this.underUs.keys()) if (!byPid.has(pid)) this.underUs.delete(pid);
    let changed = false;
    for (const w of this.workers.values()) {
      const ext = w.info.external;
      if (!ext) continue;
      const now = byPid.get(ext.pid);
      if (now) {
        // /clear or /resume in the terminal: the same process on another conversation.
        if (now.sessionId !== w.info.sessionId) {
          w.info.sessionId = now.sessionId;
          this.emitUpdate(w);
          changed = true;
        }
        continue;
      }
      // Missing from this read of the registry but still running (a file being rewritten): still there.
      if (sameProcess(ext.pid, w.terminal?.procStart, this.probe)) continue;
      // Closed in the terminal: asleep at its desk, until someone presses R to carry it on here.
      w.info.external = undefined;
      w.noWake = true;
      w.info.status = 'offline';
      w.info.activity = 'Its terminal session ended — press R to carry it on in the office';
      this.events.toast(`🖥️ ${w.info.name}'s terminal session ended — press R at its desk to carry it on in the office`, 'info');
      this.emitUpdate(w);
      changed = true;
    }
    const externals = new Set<number>();
    for (const w of this.workers.values()) if (w.info.external) externals.add(w.info.external.pid);
    // The cheap checks first: whether a process is under one of the office's terminals asks `ps`.
    for (const s of live) {
      if (externals.has(s.pid)) continue;
      // A conversation one of the workers here had, open in a terminal now (resumed there, or never
      // closed after a take-over): it's that terminal's while it runs, so nothing here resumes it.
      const had = [...this.workers.values()].find((w) => w.info.sessionId === s.sessionId);
      if (had) {
        if (had.pty || had.info.external || this.ours(s.pid)) continue;
        had.info.external = { pid: s.pid, since: s.startedAt || Date.now() };
        had.terminal = { cwd: this.checkoutAt(s.cwd) ? s.cwd : (had.terminal?.cwd ?? this.homeDir(had.info)), procStart: s.procStart };
        had.info.status = 'offline';
        had.info.activity = `🖥️ In your terminal (PID ${s.pid})`;
        externals.add(s.pid);
        this.emitUpdate(had);
        changed = true;
        continue;
      }
      if (this.dismissed.has(s.pid)) continue;
      // In one of this floor's checkouts, its own or a linked one: the worker works in that one.
      const at = this.checkoutAt(s.cwd);
      if (!at || this.ours(s.pid)) continue;
      const seat = nextFreeSeat((id) => this.deskOccupied(id));
      if (!seat) break;
      const title = titleOf(s)?.replace(/\s+/g, ' ').trim() || undefined;
      const info: WorkerInfo = {
        id: randomBytes(6).toString('hex'),
        kind: 'agent',
        provider: 'claude',
        deskId: seat.id,
        name: title ? truncate(title, TERMINAL_NAME_MAX) : TERMINAL_NAME,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        // Not running here: asleep, as far as the office's own terminals go.
        status: 'offline',
        acked: true,
        createdBy: 'terminal',
        createdAt: s.startedAt || Date.now(),
        title,
        sessionId: s.sessionId,
        activity: `🖥️ In your terminal (PID ${s.pid})`,
        cols: 100,
        rows: 30,
        viewers: [],
        viewerIds: [],
        external: { pid: s.pid, since: s.startedAt || Date.now() },
        checkout: at.checkout,
      };
      // No owner: it runs as the office once taken over, on the office's own Claude sign-in, which is
      // where its session was found (an account's own sign-in has a config folder of its own).
      const w = newWorker(info, newTracker());
      w.terminal = { cwd: s.cwd, procStart: s.procStart };
      this.workers.set(info.id, w);
      externals.add(s.pid);
      this.emitUpdate(w);
      changed = true;
    }
    if (changed) this.persist();
  }

  /**
   * Whether a Claude process is one of this floor's own: one of its terminals, or something running
   * under one (a worker's agent started through a shell). Parents that can't be told: not ours.
   */
  private ours(pid: number): boolean {
    const roots = new Set<number>();
    const now = Date.now();
    for (const w of this.workers.values()) {
      if (w.pty?.pid) roots.add(w.pty.pid);
      // A terminal of its kept in the host, not picked back up yet (see stranded).
      if (w.saved?.pid) roots.add(w.saved.pid);
      // Its terminal just went (the terminal host died): its Claude may still be on its way out.
      if (w.lastPty && now - w.lastPty.at < LAST_PTY_MS) roots.add(w.lastPty.pid);
    }
    if (roots.has(pid)) return true;
    if (!roots.size) return false;
    // A process never gains a parent, so what was found holds for as long as the terminals are the same ones.
    const of = [...roots].sort((a, b) => a - b).join(' ');
    const known = this.underUs.get(pid);
    if (known && known.of === of) return known.under;
    const under = descendsFrom(pid, roots, this.probe);
    this.underUs.set(pid, { under, of });
    return under;
  }

  /** The Claude process outside the office that has a conversation open right now, if one has. */
  private holder(sessionId: string): LiveSession | undefined {
    return liveClaudeSessions(claudeConfigDir(), this.probe, sessionId)?.find((s) => !this.ours(s.pid));
  }

  /**
   * Carries a session from someone's terminal (WorkerInfo.external) on in the office: `claude --resume`
   * of its conversation, at its desk. Its terminal isn't touched, even while it's still running there:
   * whoever took it over closes that themselves (two Claudes on one conversation each write to it).
   * It has no owner, so it runs on the office's own Claude sign-in, whose config folder the session
   * was found in (see syncTerminals), and --resume finds its transcript there. Returns the terminal's
   * Claude process, or why it can't.
   */
  takeOver(id: string): { pid: number } | string {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    const ext = w.info.external;
    if (!ext) return `${w.info.name} isn't in a terminal outside the office`;
    if (!w.info.sessionId) return `${w.info.name} has no Claude session to carry on`;
    w.info.external = undefined;
    // Still running in the terminal, maybe: it isn't to come back as a second worker.
    this.dismissed.add(ext.pid);
    const err = this.resume(id, undefined, true);
    if (err) {
      w.info.external = ext;
      this.dismissed.delete(ext.pid);
      return err;
    }
    return { pid: ext.pid };
  }

  /**
   * This floor's checkouts, its own first and then the linked ones, each as given and with its
   * symlinks resolved (as the sessions' folders are).
   */
  private roots(): { checkout?: string; dirs: string[] }[] {
    const all: { checkout?: string; dir: string }[] = [{ dir: this.dir }, ...this.links.map((l) => ({ checkout: l.id, dir: l.dir }))];
    this.rootCache ??= all.map(({ checkout, dir }) => {
      let real: string;
      try {
        real = realpathSync(dir);
      } catch {
        real = path.resolve(dir);
      }
      return { checkout, dirs: [...new Set([path.resolve(dir), real])] };
    });
    return this.rootCache;
  }

  /** Somewhere in one of this floor's checkouts. */
  private inFloor(p: string): boolean {
    const abs = path.resolve(p);
    return this.roots().some((r) => r.dirs.some((root) => inside(abs, root)));
  }

  /**
   * Which of this floor's checkouts `cwd` is in (`checkout` unset for the floor's own), leaving out the
   * office's worktrees and workspaces, which are the office's own workers; undefined for anywhere else.
   */
  private checkoutAt(cwd: string): { checkout?: string } | undefined {
    for (const r of this.roots()) {
      for (const root of r.dirs) {
        if (!inside(cwd, root)) continue;
        if (inside(cwd, path.join(root, WORKTREES_DIR))) return undefined;
        const theirs = [...this.workers.values()].some((w) => {
          const rel = workspaceOf(w.info);
          return !!rel && inside(cwd, path.join(root, rel));
        });
        return theirs ? undefined : { checkout: r.checkout };
      }
    }
    return undefined;
  }

  /**
   * Sends a worker home. For one with its own worktree, `cleanup` says what becomes of it; with no
   * choice given, the worktree and branch go only when they hold no work, where `landed` (its merged
   * pull request's head commit) is work delivered. Resolves once that's done, with a line for the team
   * about the worktree.
   */
  async kill(id: string, cleanup?: WorktreeCleanup, landed?: string, landedRepos?: Record<string, string | undefined>): Promise<{ note?: string; error?: string }> {
    const w = this.workers.get(id);
    if (!w) return {};
    // Its worktree and branch are in a repository the floor doesn't have now: nothing to clean them up with.
    const why = this.stranded(id);
    if (why) return { error: why };
    this.workers.delete(id);
    this.namer.forget(id);
    clearTimeout(w.scanTimer);
    // A session in someone's terminal leaves the desk and carries on there; it isn't seated again.
    if (w.info.external) this.dismissed.add(w.info.external.pid);
    const proc = w.pty;
    w.pty = undefined; // so the exit handler knows this worker is gone and stays quiet
    try {
      proc?.kill();
    } catch {
      // already gone
    }
    w.term?.dispose();
    this.scrollback.remove(id);
    this.drops.remove(id);
    this.events.remove(id);
    this.persist();
    // A meeting's worktree is everyone at the table's: the meeting tidies it away once they've all gone.
    if (!w.info.worktree || w.info.meeting) return {};
    // On the branch its work is on, should it have switched since it last came to rest.
    const wt = await this.current(w.info, w.info.worktree);
    const name = w.info.name;
    if (w.info.repos?.length) return this.clearRepos(w.info, cleanup, landed, landedRepos);
    // The repository it's a worktree of: this floor's, or a linked checkout's.
    const own = this.home(w.info);
    if (typeof own === 'string') return { error: `Couldn't clean up ${name}'s worktree: ${own}` };
    const { trees, ref } = own;
    if (!cleanup) {
      const work = describeWork(await trees.inspect(ref(wt), landed));
      if (work) return { note: `Kept ${name}'s worktree and branch ${wt.branch} — it has ${work}` };
      cleanup = 'all';
    }
    if (cleanup === 'keep') return { note: `Kept ${name}'s worktree and branch ${wt.branch}` };
    let gone = wt;
    let kept = '';
    if (cleanup === 'all' && wt.made) {
      if (!(await trees.hasBranch(wt.made))) {
        // The agent deleted the office's branch (a rename is followed, see current), so git can't say
        // whether the one it's on is its own or was there before it: that one stays.
        cleanup = 'worktree';
      } else {
        // The office's own branch stays while it has commits that no remote, the project's checkout
        // or the branch it's on has.
        const work = await trees.wouldLose(wt.made, [wt.branch]);
        if (work) kept = ` and kept branch ${wt.made} — it has ${work}`;
        // A branch it made itself goes with it; one that was there before it (main, say) isn't the office's to delete.
        if (await trees.madeSince(wt.branch, wt.made)) gone = work ? { ...wt, made: undefined } : wt;
        else if (work) cleanup = 'worktree';
        else gone = { ...wt, branch: wt.made, made: undefined };
      }
    }
    const error = await trees.remove(ref(gone), cleanup);
    if (error) return { error: `Couldn't delete ${name}'s worktree: ${error}` };
    if (cleanup === 'worktree') return { note: `Deleted ${name}'s worktree${kept || ` and kept branch ${wt.branch}`}` };
    return { note: `Deleted ${name}'s worktree and branch ${gone.branch}${kept && `,${kept}`}` };
  }

  /** Sending home a worker across repositories: what `kill` does with a worktree, for each of its worktrees, and then its workspace. */
  private async clearRepos(info: WorkerInfo, cleanup: WorktreeCleanup | undefined, landed?: string, landedRepos?: Record<string, string | undefined>): Promise<{ note?: string; error?: string }> {
    const trees = this.treesOf(info, landed, landedRepos);
    const { name } = info;
    if (typeof trees === 'string') return { error: `Couldn't clean up ${name}'s worktrees: ${trees}` };
    const branch = info.worktree!.branch;
    const where = trees.map((t) => t.name).join(', ');
    if (!cleanup) {
      const held = (await Promise.all(trees.map(async (t) => ({ name: t.name, work: describeWork(await t.trees.inspect(t.ref, t.landed)) })))).filter((t) => t.work);
      if (held.length) return { note: `Kept ${name}'s worktrees and branch ${branch} in ${where} — ${held.map((t) => `${t.name} has ${t.work}`).join('; ')}` };
      cleanup = 'all';
    }
    if (cleanup === 'keep') return { note: `Kept ${name}'s worktrees and branch ${branch} in ${where}` };
    const how = cleanup;
    const errors = (await Promise.all(trees.map(async (t) => {
      const error = await t.trees.remove(t.ref, how);
      return error && `${t.name}: ${error}`;
    }))).filter(Boolean);
    if (errors.length) return { error: `Couldn't delete all of ${name}'s worktrees: ${errors.join('; ')}` };
    clearWorkspace(path.join(this.dir, workspaceOf(info)!));
    return { note: how === 'all' ? `Deleted ${name}'s worktrees and branch ${branch} in ${where}` : `Deleted ${name}'s worktrees in ${where} and kept branch ${branch}` };
  }

  /**
   * Each worktree a worker across repositories has, its own floor's first: its folder in the
   * workspace, git plumbing for its repository, its worktree in that repository's terms, and the
   * commit its merged pull request delivered, when known.
   */
  private treesOf(info: WorkerInfo, landed?: string, landedRepos?: Record<string, string | undefined>): { name: string; trees: Worktrees; ref: WorktreeRef; landed?: string }[] | string {
    const wt = info.worktree!;
    const own = this.home(info);
    if (typeof own === 'string') return own;
    return [
      { name: path.basename(wt.path), trees: own.trees, ref: own.ref(wt), landed },
      ...(info.repos ?? []).map((r) => ({
        name: r.name,
        trees: new Worktrees(r.dir),
        ref: { path: path.relative(r.dir, path.join(this.dir, r.path)), branch: r.branch, base: r.base },
        landed: landedRepos?.[repoKey(r)],
      })),
    ];
  }

  /**
   * Whether any worktree of a worker across repositories holds work its merged pull requests didn't
   * deliver (`landed` and `landedRepos`, as for kill): then it doesn't go home by itself yet.
   */
  async holdsWork(id: string, landed?: string, landedRepos?: Record<string, string | undefined>): Promise<boolean> {
    const info = this.workers.get(id)?.info;
    if (!info?.worktree) return false;
    const trees = this.treesOf(info, landed, landedRepos);
    // Can't be looked at (see stranded): it might, so it stays.
    if (typeof trees === 'string') return true;
    const states = await Promise.all(trees.map(async (t) => describeWork(await t.trees.inspect(t.ref, t.landed))));
    return states.some(Boolean);
  }

  /** What a worker's worktree holds, so whoever sends it home knows what deleting it would lose. */
  async inspectWorktree(id: string): Promise<WorktreeState | undefined> {
    const w = this.workers.get(id);
    const info = w?.info;
    if (!w || !info?.worktree) return undefined;
    const why = this.stranded(id);
    if (why) return { exists: true, dirty: 0, ahead: 0, unpushed: 0, error: why };
    if (!info.repos?.length) {
      await this.syncBranch(w);
      const own = this.home(info);
      if (typeof own === 'string') return { exists: true, dirty: 0, ahead: 0, unpushed: 0, error: own };
      return own.trees.inspect(own.ref(w.info.worktree!));
    }
    const trees = this.treesOf(info);
    if (typeof trees === 'string') return { exists: true, dirty: 0, ahead: 0, unpushed: 0, error: trees };
    const repos = await Promise.all(trees.map(async (t) => ({ name: t.name, state: await t.trees.inspect(t.ref) })));
    const sum = (k: 'dirty' | 'ahead' | 'unpushed') => repos.reduce((n, r) => n + r.state[k], 0);
    const errors = repos.filter((r) => r.state.error).map((r) => `${r.name}: ${r.state.error}`);
    return { exists: repos.every((r) => r.state.exists), dirty: sum('dirty'), ahead: sum('ahead'), unpushed: sum('unpushed'), error: errors.length ? errors.join('; ') : undefined, repos };
  }

  /** Every worker's worktree branch, looked at again (see syncBranch): for when new pull requests may have come in. */
  async syncBranches(): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => this.syncBranch(w)));
  }

  /**
   * Keeps `worktree.branch` on the branch the worktree is actually on. Agents often make their own
   * (`git checkout -b fix-x`, because the task or the repo's CLAUDE.md says to) and open the pull
   * request from there with gh, and the PR badge, O at the desk and sending it home go by it. A
   * meeting's worktree stays the meeting's, and a worker across repositories keeps the branch it was
   * given in each (see openPrs).
   */
  private async syncBranch(w: Worker): Promise<void> {
    const wt = w.info.worktree;
    if (!wt || w.info.meeting || w.info.repos?.length) return;
    const now = await this.current(w.info, wt);
    // Sent home meanwhile, or another look got there first.
    if (now === wt || this.workers.get(w.info.id) !== w || w.info.worktree !== wt) return;
    w.info.worktree = now;
    this.emitUpdate(w);
    this.persist();
  }

  /** A worktree of `info`'s on the branch it's on now, with the office's own branch kept in `made`; the same one when nothing moved. */
  private async current(info: WorkerInfo, wt: Worktree): Promise<Worktree> {
    const own = this.home(info);
    if (typeof own === 'string') return wt;
    const { trees, ref } = own;
    const live = await trees.branchOf(ref(wt));
    if (!live) return wt;
    let made = wt.made ?? (live === wt.branch ? undefined : wt.branch);
    // Back on it, or renamed it (`git branch -m fix-x`): the branch it's on is the office's own.
    if (made === live || (made && (await trees.renamedTo(made, live)))) made = undefined;
    return live === wt.branch && made === wt.made ? wt : { ...wt, branch: live, made };
  }

  attach(id: string, clientId: string, name: string): { data: string; cols: number; rows: number } | undefined {
    const w = this.workers.get(id);
    if (!w) return undefined;
    w.viewers.set(clientId, name);
    let changed = this.syncViewers(w);
    if (!w.info.acked && w.info.status !== 'needs_input') {
      w.info.acked = true;
      changed = true;
    }
    if (changed) this.emitUpdate(w);
    const data = w.snapshot ? w.snapshot() : offlineBanner(w.info);
    return { data, cols: w.info.cols, rows: w.info.rows };
  }

  /** Lines of every worker's terminal holding `needle` (a searchKey), newest first, at most `perWorker` each. */
  search(needle: string, perWorker: number): { hits: TerminalHit[]; more: boolean } {
    const hits: TerminalHit[] = [];
    let more = false;
    for (const w of this.workers.values()) {
      if (!w.term) continue;
      const found = searchTerminal(w.term, needle, perWorker);
      more ||= found.more;
      for (const hit of found.hits) hits.push({ workerId: w.info.id, ...hit });
    }
    return { hits, more };
  }

  detach(id: string, clientId: string) {
    const w = this.workers.get(id);
    if (!w) return;
    if (w.viewers.delete(clientId) && this.syncViewers(w)) this.emitUpdate(w);
  }

  detachAll(clientId: string) {
    for (const w of this.workers.values()) {
      if (w.viewers.delete(clientId) && this.syncViewers(w)) this.emitUpdate(w);
    }
  }

  /** Keystrokes from `by`'s browser. */
  write(id: string, data: string, by: string) {
    const w = this.workers.get(id);
    if (!w?.pty) return;
    w.pty.write(data);
    let changed = this.typed(w, by);
    if (w.info.status === 'needs_input' && w.info.acked === false) {
      w.info.acked = true;
      changed = true;
    }
    if (changed) this.emitUpdate(w);
  }

  /** Keeps a file dropped or pasted into a worker's terminal on this machine; where it is, for the terminal to type. */
  drop(id: string, name: string, type: string, body: Buffer): string | undefined {
    return this.workers.has(id) ? this.drops.save(id, name, type, body) : undefined;
  }

  /**
   * Remembers who typed into the terminal last. Says whether that's news: another person, or the
   * same one after a pause (not every keystroke, or a typist would flood everyone with updates).
   */
  private typed(w: Worker, by: string): boolean {
    const now = Date.now();
    const last = w.info.lastInput;
    if (last?.by === by && now - last.at < TYPED_REFRESH_MS) return false;
    w.info.lastInput = { by, at: now };
    return true;
  }

  /** Types a prompt into the agent's input box and submits it; `by` is the person who sent it, if any. */
  prompt(id: string, text: string, by?: string): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (!w.pty) return 'Worker is not running';
    const clean = text.replace(/\r\n?/g, '\n').trim();
    if (!clean) return 'Empty prompt';
    // Bracketed paste keeps multi-line prompts in one message, then Enter submits.
    w.pty.write(`\x1b[200~${clean}\x1b[201~`);
    setTimeout(() => w.pty?.write('\r'), 120);
    w.info.activity = truncate(clean, 80);
    this.notePrompt(w, clean);
    if (by) w.info.lastInput = { by, at: Date.now() };
    this.emitUpdate(w);
    return undefined;
  }

  /**
   * Pushes a worktree worker's branch and opens a pull request for it, with a title and body
   * drafted from its task, as `as` (whoever pressed the button) or else the office. Resolves to the
   * PR, or to a message saying why there is none. The branch may already have an open PR (a second
   * press, or one opened by hand): that one is used. A worker across repositories gets one in each
   * repository it committed to (see openPrs).
   */
  async openPr(id: string, by: string, as?: GhAs): Promise<{ prs: OpenedPr[]; failed: string[] } | string> {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    const why = this.stranded(id);
    if (why) return why;
    const { info } = w;
    const wt = info.worktree;
    if (!wt) return `${info.name} works in the main checkout — only workers with their own worktree can open a PR`;
    if (info.prOpening) return `${info.name}'s pull request is already being opened`;
    if (isBusy(info.status)) {
      return `${info.name} is still ${info.status === 'needs_input' ? 'waiting on input' : info.status} — wait until it's done`;
    }
    if (info.repos?.length) return this.openPrs(w, by, as);
    const cwd = path.join(this.dir, wt.path);
    if (!existsSync(cwd)) return `${info.name}'s worktree is gone (${wt.path})`;
    info.prOpening = true;
    this.emitUpdate(w);
    try {
      // The PR comes from the branch its work is on, which may be one it made itself.
      await this.syncBranch(w);
      const branch = info.worktree?.branch ?? wt.branch;
      const commits = (await run('git', ['log', '--reverse', '--format=%h %s', `${wt.base}..${branch}`], cwd)).split('\n').filter(Boolean);
      const dirty = (await run('git', ['status', '--porcelain'], cwd)) !== '';
      if (!commits.length) return dirty ? `${info.name} hasn't committed anything yet — ask it to commit first` : `${info.name} has no commits on ${branch} yet`;
      const open = await findOpenPr(branch, cwd);
      if (open) {
        info.pr = open;
        this.persist();
        return { prs: [{ ...open, existed: true, dirty }], failed: [] };
      }
      await run('git', ['push', '-u', 'origin', branch], cwd, 90_000, as?.env);
      const own = this.home(info);
      if (typeof own === 'string') return own;
      const base = await this.pushedBranch([wt.from, own.trees.currentBranch()], branch, own.dir);
      const { title, body } = draftPr(info, commits, by, undefined, originRepo(own.dir));
      const { number, url } = await createPr(branch, base, title, body, cwd, as);
      info.pr = { number, url };
      this.persist();
      return { prs: [{ number, url, existed: false, dirty }], failed: [] };
    } catch (err) {
      return `Couldn't open a PR for ${info.name}: ${(err as Error).message}`;
    } finally {
      info.prOpening = false;
      // The worker may have been sent home meanwhile; an update would bring it back as a ghost.
      if (this.workers.get(id) === w) this.emitUpdate(w);
    }
  }

  /**
   * 'worker.pr' for a worker across repositories: a pull request in each repository it committed to
   * (or the one its branch already has there), with every one of them listed in each one's
   * description, so they're reviewed and merged together. The issue its task came from is closed by
   * its own floor's pull request; the others only mention it.
   */
  private async openPrs(w: Worker, by: string, as?: GhAs): Promise<{ prs: OpenedPr[]; failed: string[] } | string> {
    const { info } = w;
    const wt = info.worktree!;
    const at = this.homeDir(info);
    const home = originRepo(at);
    const parts = [
      { name: path.basename(wt.path), dir: at, ...wt, pr: info.pr, own: true, set: (pr: { number: number; url: string }) => (info.pr = pr) },
      ...info.repos!.map((r) => ({ ...r, own: false, set: (pr: { number: number; url: string }) => (r.pr = pr) })),
    ];
    const gone = parts.filter((p) => !existsSync(path.join(this.dir, p.path)));
    if (gone.length) return `${info.name}'s worktree${gone.length > 1 ? 's' : ''} of ${gone.map((p) => p.name).join(', ')} ${gone.length > 1 ? 'are' : 'is'} gone`;
    info.prOpening = true;
    this.emitUpdate(w);
    const prs: (OpenedPr & { cwd: string })[] = [];
    const failed: string[] = [];
    const uncommitted: string[] = [];
    try {
      for (const p of parts) {
        const cwd = path.join(this.dir, p.path);
        try {
          const dirty = (await run('git', ['status', '--porcelain'], cwd)) !== '';
          const known = p.pr ?? (await findOpenPr(p.branch, cwd));
          if (known) {
            p.set(known);
            prs.push({ repo: p.name, ...known, existed: true, dirty, cwd });
            continue;
          }
          const commits = (await run('git', ['log', '--reverse', '--format=%h %s', `${p.base}..${p.branch}`], cwd)).split('\n').filter(Boolean);
          if (!commits.length) {
            if (dirty) uncommitted.push(p.name);
            continue;
          }
          await run('git', ['push', '-u', 'origin', p.branch], cwd, 90_000, as?.env);
          const base = await this.pushedBranch([p.from, new Worktrees(p.dir).currentBranch()], p.branch, p.dir);
          const { title, body } = draftPr(info, commits, by, p.own ? undefined : { home }, p.own ? home : originRepo(p.dir));
          const pr = await createPr(p.branch, base, title, body, cwd, as);
          p.set(pr);
          this.persist();
          prs.push({ repo: p.name, ...pr, existed: false, dirty, cwd });
        } catch (err) {
          failed.push(`Couldn't open a PR in ${p.name}: ${(err as Error).message}`);
        }
      }
      if (!prs.length) {
        if (failed.length) return failed.join('; ');
        return uncommitted.length ? `${info.name} hasn't committed anything yet in ${uncommitted.join(', ')} — ask it to commit first` : `${info.name} has no commits on ${wt.branch} yet in any of its repositories`;
      }
      if (prs.length > 1 && prs.some((p) => !p.existed)) {
        for (const p of prs) {
          try {
            const body = await gh(['pr', 'view', p.url, '--json', 'body', '--jq', '.body'], p.cwd, 30_000, as?.env);
            const next = withRelated(body, relatedBlock(prs, p.url, wt.branch));
            if (next !== body) await gh(['pr', 'edit', p.url, '--body', next], p.cwd, 60_000, as?.env);
          } catch (err) {
            failed.push(`Couldn't list the other pull requests on ${p.repo} #${p.number}: ${(err as Error).message}`);
          }
        }
      }
      this.persist();
      return { prs: prs.map(({ cwd: _, ...p }) => p), failed };
    } finally {
      info.prOpening = false;
      if (this.workers.get(info.id) === w) this.emitUpdate(w);
    }
  }

  /** The first of these branches that exists on origin (of `dir`'s repository), for a PR base. None: gh picks the default branch. */
  private async pushedBranch(candidates: (string | undefined)[], not: string, dir = this.dir): Promise<string | undefined> {
    for (const c of candidates) {
      if (!c || c === not) continue;
      try {
        await run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${c}`], dir);
        return c;
      } catch {
        // not on the remote (or never fetched)
      }
    }
    return undefined;
  }

  resize(id: string, cols: number, rows: number) {
    const w = this.workers.get(id);
    if (!w?.pty || !w.term) return;
    cols = clamp(Math.floor(cols), 20, 400);
    rows = clamp(Math.floor(rows), 5, 200);
    if (cols === w.info.cols && rows === w.info.rows) return;
    w.info.cols = cols;
    w.info.rows = rows;
    try {
      w.pty.resize(cols, rows);
      w.term.resize(cols, rows);
    } catch {
      // pty may have exited between checks
    }
    w.screenDirty = true;
    w.lastLines = [];
    this.emitUpdate(w);
  }

  /** Claude Code hook callback. */
  handleHook(workerId: string, token: string, event: string, payload: any): boolean {
    const w = this.workers.get(workerId);
    if (!w || !w.pty || w.info.kind !== 'agent' || (w.info.provider !== 'claude' && w.info.provider !== 'custom') || !safeEq(token, w.hookToken)) return false;
    const now = Date.now();
    if (payload?.session_id && typeof payload.session_id === 'string' && payload.session_id !== w.info.sessionId) {
      w.info.sessionId = payload.session_id;
      this.persist();
    }
    if (typeof payload?.transcript_path === 'string' && payload.transcript_path !== w.tracker.transcript) {
      w.tracker.transcript = payload.transcript_path;
      this.persist();
    }
    this.scheduleScan(w);
    switch (event) {
      case 'SessionStart':
        if (payload?.source === 'clear') {
          this.clearTask(w);
          w.failStreak = 0;
        }
        if (w.info.status === 'starting' || (w.bootBlocked && w.info.status === 'needs_input')) {
          w.bootBlocked = false;
          this.setStatus(w, 'idle');
        }
        break;
      case 'UserPromptSubmit':
        w.bootBlocked = false;
        w.info.action = undefined;
        if (typeof payload?.prompt === 'string') {
          w.info.activity = truncate(payload.prompt, 80);
          this.notePrompt(w, payload.prompt);
        }
        if (w.info.status !== 'working') this.setStatus(w, 'working');
        else this.emitUpdate(w);
        break;
      case 'PreToolUse':
        if (payload?.tool_name === 'AskUserQuestion') this.setStatus(w, 'needs_input');
        else {
          w.info.activity = describeTool(payload);
          w.info.action = toolAction(payload?.tool_name, payload?.tool_input);
          this.noteTool(w, w.info.activity);
          if (w.info.status !== 'working') this.setStatus(w, 'working');
          else this.emitUpdate(w);
        }
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.noteOutcome(w, payload, event === 'PostToolUseFailure');
        if (w.info.status === 'needs_input') {
          w.leftNeedsInputAt = now;
          this.setStatus(w, 'working');
        }
        break;
      case 'PermissionRequest':
        w.info.activity = `Wants permission: ${describeTool(payload)}`;
        this.setStatus(w, 'needs_input');
        break;
      case 'Notification':
        if (payload?.notification_type === 'permission_prompt') {
          if (now - w.leftNeedsInputAt > LATE_PROMPT_GRACE_MS) this.setStatus(w, 'needs_input');
        } else if (payload?.notification_type === 'idle_prompt') {
          if (w.info.status === 'working') this.setStatus(w, 'done');
        }
        break;
      case 'Stop':
        this.setStatus(w, 'done');
        break;
    }
    return true;
  }

  /** Native Codex lifecycle hooks register the root rollout for bounded metric reads. */
  handleCodexHook(workerId: string, token: string, event: string, payload: unknown): boolean {
    const w = this.workers.get(workerId);
    if (!w || !w.pty || w.info.kind !== 'agent' || w.info.provider !== 'codex' || !safeEq(token, w.hookToken)) return false;
    const report = normalizeCodexHook(event, payload);
    if (!report) return false;
    if (w.info.sessionId && w.info.sessionId !== report.sessionId && event !== 'SessionStart') return false;
    if (!w.info.sessionId || w.info.sessionId !== report.sessionId) {
      if (w.info.sessionId) {
        this.clearTask(w);
        w.info.usage = undefined;
        w.codexTranscript = undefined;
        w.codexUsage = new CodexUsageReader();
      }
      w.info.sessionId = report.sessionId;
      this.persist();
    }
    if (report.transcriptPath) w.codexTranscript = report.transcriptPath;
    this.scheduleScan(w);
    w.bootBlocked = false;
    const clearPending = () => {
      w.codexTools.clear();
      w.codexPending.clear();
      w.codexPermissionUnknown = false;
    };
    const busy = () => this.setStatus(w, w.codexPending.size || w.codexPermissionUnknown ? 'needs_input' : 'working');
    switch (report.event) {
      case 'SessionStart':
        clearPending();
        if (report.source === 'clear') this.clearTask(w);
        w.info.activity = undefined;
        if (w.info.status === 'starting' || w.info.status === 'needs_input') this.setStatus(w, 'idle');
        break;
      case 'UserPromptSubmit':
        clearPending();
        w.info.action = undefined;
        if (report.prompt) {
          w.info.activity = truncate(report.prompt, 80);
          this.notePrompt(w, report.prompt);
        }
        this.setStatus(w, 'working');
        break;
      case 'PreToolUse':
        w.info.activity = report.tool ? truncate(report.tool, 80) : 'Using a tool';
        w.info.action = toolAction(report.tool);
        if (report.toolUseId && w.codexTools.size < 256) w.codexTools.set(report.toolUseId, report.tool ?? '');
        if (/(?:^|[.])(?:AskUserQuestion|request_user_input)$/.test(report.tool ?? '')) {
          if (report.toolUseId) w.codexPending.add(report.toolUseId);
          else w.codexPermissionUnknown = true;
        }
        busy();
        break;
      case 'PermissionRequest':
        w.info.activity = `Wants permission: ${truncate(report.tool ?? 'tool', 80)}`;
        // PermissionRequest has no tool_use_id in the native schema. Keep every matching
        // active call pending so an unrelated parallel tool cannot dismiss the prompt.
        const candidates = [...w.codexTools].filter(([, tool]) => tool === report.tool);
        if (!candidates.length) w.codexPermissionUnknown = true;
        for (const [id] of candidates) w.codexPending.add(id);
        this.setStatus(w, 'needs_input');
        break;
      case 'PostToolUse':
        if (report.toolUseId) {
          w.codexTools.delete(report.toolUseId);
          w.codexPending.delete(report.toolUseId);
        }
        busy();
        break;
      case 'Stop':
      case 'Interrupt':
        clearPending();
        this.setStatus(w, 'done');
        break;
    }
    this.emitUpdate(w);
    this.persist();
    return true;
  }

  /** OpenCode plugin callback. The plugin has already filtered child sessions before this bridge. */
  handleOpenCodeHook(workerId: string, token: string, payload: unknown): boolean {
    const w = this.workers.get(workerId);
    if (!w || !w.pty || w.info.kind !== 'agent' || w.info.provider !== 'opencode' || !safeEq(token, w.hookToken)) return false;
    if (payload && typeof payload === 'object' && 'type' in payload && payload.type === 'usage') {
      const report = payload as { sessionId?: unknown; usage?: unknown };
      const usage = reportedUsage(report.usage);
      if (!usage || !w.info.sessionId || report.sessionId !== w.info.sessionId) return false;
      // Full snapshots replace previous totals. They never advance task status or enter the Claude ledger.
      w.info.usage = usage;
      this.emitUpdate(w);
      this.persist();
      return true;
    }
    if (!isOpenCodeHookEvent(payload)) return false;
    if (w.info.sessionId && w.info.sessionId !== payload.sessionId && !(payload.type === 'session' && payload.status === 'starting')) return false;
    if (!w.info.sessionId || (payload.type === 'session' && payload.status === 'starting' && w.info.sessionId !== payload.sessionId)) {
      const switching = !!w.info.sessionId;
      w.info.sessionId = payload.sessionId;
      if (switching) {
        w.info.usage = undefined;
        this.clearTask(w);
        w.info.activity = undefined;
        this.setStatus(w, 'idle');
      }
      w.openCodeError = false;
      this.persist();
    }
    if (payload.type === 'error') w.openCodeError = true;
    else if (payload.status === 'working' || payload.prompt) w.openCodeError = false;
    if (payload.prompt) {
      w.info.activity = truncate(payload.prompt, 80);
      w.info.action = undefined;
      this.notePrompt(w, payload.prompt);
    } else if (payload.tool) {
      w.info.activity = truncate(payload.tool, 80);
      w.info.action = toolAction(payload.tool);
    } else if (payload.detail) {
      w.info.activity = truncate(payload.detail, 80);
    }
    if (payload.status === 'needs_input') this.setStatus(w, 'needs_input');
    else if (payload.status === 'working') this.setStatus(w, 'working');
    else if (payload.status === 'done' && w.pty) this.setStatus(w, w.openCodeError ? 'needs_input' : 'done');
    else if (payload.status === 'starting' && w.info.status === 'starting') this.setStatus(w, 'idle');
    else this.emitUpdate(w);
    return true;
  }

  /** A new message for the worker: show it right away, and have its task (re)named. */
  private notePrompt(w: Worker, prompt: string) {
    if (w.info.kind !== 'agent') return;
    const clean = prompt.replace(/\s+/g, ' ').trim();
    // Bare slash commands (/model, /compact), repeats and the office's own carry-on aren't new work.
    if (!clean || /^\/\S+$/.test(clean) || w.prompts.at(-1) === clean || clean === CARRY_ON_PROMPT) return;
    w.prompts = [...w.prompts, clean].slice(-TASK_PROMPTS);
    const hadTask = !!w.info.task;
    if (!hadTask) w.info.task = fallbackTask(clean);
    if (w.info.provider !== 'claude' && w.info.provider !== 'custom') return;
    // "yes", "go ahead", "2": a reply within the same task, not worth a new name.
    if (hadTask && clean.length < 16) return;
    this.nameTask(w);
  }

  private noteTool(w: Worker, tool: string) {
    if (w.info.provider !== 'claude' && w.info.provider !== 'custom') return;
    w.tools = [...w.tools, tool].slice(-TASK_TOOLS);
    w.toolsSinceNamed++;
    if (w.info.task && w.toolsSinceNamed >= TASK_REFRESH_TOOLS && Date.now() - w.namedAt > TASK_REFRESH_MS) this.nameTask(w);
  }

  /**
   * A tool call finished. Tests or a build that failed again (by exit code, or by the summary it
   * printed when the exit code was piped away) and the worker puts its head in its hands, until its
   * next tool call; a passing run ends the streak.
   */
  private noteOutcome(w: Worker, payload: any, failed: boolean) {
    if (payload?.is_interrupt || toolAction(payload?.tool_name, payload?.tool_input) !== 'test') return;
    const res = payload?.tool_response;
    const output = [payload?.error, res?.stdout, res?.stderr].filter((s) => typeof s === 'string').join('\n');
    if (!failed && !outputFailed(output)) {
      w.failStreak = 0;
      return;
    }
    if (++w.failStreak < FAILS_TO_DESPAIR || w.info.action === 'failing') return;
    w.info.action = 'failing';
    this.emitUpdate(w);
  }

  private nameTask(w: Worker) {
    if (w.info.provider !== 'claude' && w.info.provider !== 'custom') return;
    w.toolsSinceNamed = 0;
    w.namedAt = Date.now();
    const previous = w.info.task && w.prompts.length > 1 ? w.info.task : undefined;
    this.namer.request(w.info.id, { prompts: w.prompts, tools: w.tools, previous, epoch: w.taskEpoch });
  }

  private clearTask(w: Worker) {
    w.taskEpoch++;
    w.prompts = [];
    w.tools = [];
    w.toolsSinceNamed = 0;
    this.namer.forget(w.info.id);
    if (!w.info.task) return;
    w.info.task = undefined;
    this.emitUpdate(w);
    this.persist();
  }

  /**
   * The office is closing. On a restart (`keep`), terminals in the host keep running for the next
   * office to pick back up; otherwise every worker stops.
   */
  shutdown(keep = false) {
    this.closing = true;
    this.stopping = !keep;
    clearInterval(this.screenTimer);
    clearInterval(this.usageTimer);
    clearInterval(this.saveTimer);
    for (const w of this.workers.values()) {
      clearTimeout(w.scanTimer);
      this.scanUsage(w);
      // Before the process goes, so the next office shows what it was doing, not how it was stopped.
      if (w.unsaved) this.saveScrollback(w);
      if (keep && w.pty?.id) continue;
      // A restart only takes this one down because it runs in-process: the next office carries on its turn.
      if (keep && midTurn(w)) w.interrupted = true;
      try {
        w.pty?.kill();
      } catch {
        // ignore
      }
    }
    this.persist();
    if (keep) this.host.detach();
    else this.host.stop();
  }

  // ---------------------------------------------------------------------------

  private launch(w: Worker, prompt: string | undefined, resumeSessionId: string | undefined) {
    const { info } = w;
    // The new terminal starts with what the last one showed (on a resume), or with what was saved
    // when the office last stopped, so earlier output is still there to scroll back to and search.
    const restarted = !w.term;
    const before = w.term && w.ser ? terminalTail(w.term, w.ser, SCROLLBACK) : this.scrollback.load(info.id);
    const prelude = before ? `${before}\r\n${restarted ? RESTORED_NOTE : ''}` : undefined;
    const term = this.newTerm(w);
    if (prelude) {
      // Writes are parsed in order, so this lands before anything the new process prints.
      term.write(prelude, () => {
        if (w.term === term) w.fresh = term.registerMarker(0);
      });
    }

    const shell = defaultShell();
    const isShell = info.kind === 'shell';
    const provider = info.provider;
    const isClaude = !isShell && provider === 'claude';
    const isOpenCode = !isShell && provider === 'opencode';
    const isCodex = !isShell && provider === 'codex';
    const configured = !isShell && provider === this.defaultProvider;
    const station = DESK_BY_ID.get(info.deskId)?.station;
    const command = this.command(info);
    const commandPath = isShell ? undefined : configured ? this.agentPath : resolveCommand(command);
    let args = isShell ? (WIN && !process.env.SHELL ? [] : ['-l']) : configured ? [...this.agentArgs] : [];
    if (isClaude) {
      args.unshift('--settings', this.settingsPath);
      // A model/effort chosen for this worker overrides whatever --agent-args set office-wide.
      if (info.model) args.push('--model', info.model);
      if (info.effort) args.push('--effort', info.effort);
      // The queue agent only ever adds to the queue: without these it can't touch the checkout's files.
      if (station === 'queue') args.push('--disallowedTools', ...QUEUE_AGENT_DISALLOWED_TOOLS);
      if (resumeSessionId) args.push('--resume', resumeSessionId);
      // `--` so a prompt like "- fix login" is never parsed as a CLI option.
      if (prompt) args.push('--', prompt);
    } else if (isOpenCode) {
      if (resumeSessionId || info.model) args = withoutOpenCodeModel(args);
      if (!resumeSessionId && info.model) args.push('--model', info.model);
      if (resumeSessionId) args.push('--session', resumeSessionId);
      if (prompt) args.push('--prompt', prompt);
    } else if (isCodex) {
      args.push(...codexHookArgs(this.codexHook), '--no-alt-screen');
      if (resumeSessionId) args.push('resume', resumeSessionId);
      if (prompt) args.push('--', prompt);
    }
    if (isCodex) {
      w.codexTools.clear();
      w.codexPending.clear();
      w.codexPermissionUnknown = false;
    }
    if (isOpenCode || isCodex) {
      w.hookToken = randomBytes(16).toString('hex');
      w.openCodeError = false;
    }
    const env = childEnv();
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      AGENT_OFFICE_WORKER_ID: info.id,
      AGENT_OFFICE_HOOK_URL: this.hook.url,
      AGENT_OFFICE_HOOK_TOKEN: w.hookToken,
    });
    // A board agent reaches the queue with the office-queue command, whichever agent it runs.
    if (station && this.queueBin) {
      // Windows spells it Path.
      const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
      env[key] = [this.queueBin, env[key]].filter(Boolean).join(path.delimiter);
    }

    const cwd = this.cwd(info);
    // A workspace isn't a repository, but it's inside this floor's checkout: git run in it must not
    // find that checkout (and switch its branch, say) instead of saying it's no repository.
    if (info.repos?.length) env.GIT_CEILING_DIRECTORIES = [path.dirname(cwd), env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter);
    if (w.owner && this.runAs) {
      if (isClaude && !this.runAs.claudeReady(w.owner)) {
        this.startFailed(w, `whoever hired ${info.name} (${info.createdBy}) isn't signed in to Claude — they can sign in under ☰ → 🔐 Your sign-ins, then press R here`);
        return;
      }
      this.runAs.apply(w.owner, env, [this.homeDir(info), cwd]);
    }
    if (isCodex) w.codexHome = codexHome(cwd, env);
    // The host keeps its own copy of the screen for the next office: it starts with the same history.
    const where = { cwd, env, cols: info.cols, rows: info.rows, prelude };
    let proc: Pty;
    try {
      if (!existsSync(cwd)) throw new Error(`working directory is gone: ${cwd}`);
      if (isOpenCode) {
        env.AGENT_OFFICE_SESSION_ID = resumeSessionId ?? '';
        env.OPENCODE_CONFIG_CONTENT = mergeOpenCodeConfigContent(env.OPENCODE_CONFIG_CONTENT, openCodePluginSpecifier(this.openCodePlugin));
      }
      if (isShell) {
        proc = this.host.spawn({ file: shell, args, ...where });
      } else if (commandPath) {
        proc = this.host.spawn({ file: commandPath, args, ...where });
      } else {
        // Not found on PATH: let a login shell find it (nvm, asdf, ~/.local/bin ...).
        const line = ['exec', command, ...args].map((a, i) => (i < 2 ? a : shq(a))).join(' ');
        proc = this.host.spawn({ file: shell, args: shellRun(line), ...where });
      }
    } catch (err) {
      this.startFailed(w, (err as Error).message);
      return;
    }
    if (!isClaude && !isCodex) info.status = 'idle';
    this.follow(w, proc, term, resumeSessionId);
    this.emitUpdate(w);
    this.persist();
  }

  /** Takes back a terminal the host kept running while the office was down. */
  private adopt(w: Worker, adopted: Adopted, saved: NonNullable<Worker['saved']>) {
    const { info } = w;
    // It kept working through the restart: nothing to carry on, and it's the office's terminal, not someone's own.
    w.interrupted = false;
    info.external = undefined;
    info.cols = adopted.cols;
    info.rows = adopted.rows;
    const term = this.newTerm(w);
    // Scrollback and all, the history from before this run included: only what it prints from here
    // on can say it's stuck on a login.
    term.write(adopted.snapshot, () => {
      if (w.term === term) w.fresh = term.registerMarker(0);
    });
    this.setTitle(w, adopted.title);
    // A hook that came in since the office started already says how it's doing.
    if (info.status === 'offline') {
      info.status = saved.status;
      info.acked = saved.acked;
      info.waitingSince = saved.waitingSince;
    }
    if (info.provider === 'codex') w.codexHome = codexHome(this.cwd(info), childEnv());
    this.follow(w, adopted.pty, term, undefined);
    // A turn that ended while the office was down says so with its Stop hook, which retries until
    // the office is back. Claude's progress report, where it gives one, says a turn is still going.
    if (adopted.busy && info.provider === 'claude') this.onProgress(w, true);
    this.emitUpdate(w);
  }

  /** A fresh screen for a worker's terminal, reading Claude's progress and title off it. */
  private newTerm(w: Worker): HeadlessTerminal {
    const term = new headless.Terminal({ cols: w.info.cols, rows: w.info.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const ser = new serialize.SerializeAddon();
    term.loadAddon(ser as any);
    // OSC 9;4 progress (Claude Code emits it): 0 = idle, anything else = busy. Catches Esc-cancel,
    // which fires no Stop hook.
    if (w.info.provider === 'claude') {
      term.parser.registerOscHandler(9, (data: string) => {
        const m = /^4;(\d)/.exec(data);
        if (m) this.onProgress(w, m[1] !== '0');
        return true;
      });
    }
    term.onTitleChange((title: string) => this.setTitle(w, title));
    w.term?.dispose();
    w.term = term;
    w.ser = ser;
    w.snapshot = screenSnapshot(term, ser);
    w.lastLines = [];
    w.screenDirty = true;
    w.fresh = undefined;
    return term;
  }

  private setTitle(w: Worker, title: string) {
    const clean = title.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (clean && clean !== w.info.title && !/^claude( code)?$/i.test(clean)) {
      w.info.title = clean;
      this.emitUpdate(w);
    }
  }

  /** Shows a worker's terminal output as it comes, and deals with the process ending. */
  private follow(w: Worker, proc: Pty, term: HeadlessTerminal, resumeSessionId: string | undefined) {
    const { info } = w;
    const isClaude = info.kind === 'agent' && info.provider === 'claude';
    const isCodex = info.kind === 'agent' && info.provider === 'codex';
    w.pty = proc;
    proc.onData((data) => {
      term.write(data);
      w.screenDirty = true;
      w.unsaved = true;
      if (w.viewers.size) this.events.data(info.id, data, [...w.viewers.keys()]);
    });
    proc.onExit(({ exitCode, error, lost }) => {
      if (w.pty !== proc || this.workers.get(info.id) !== w) return;
      w.pty = undefined;
      if (proc.pid) w.lastPty = { pid: proc.pid, at: Date.now() };
      if (error) {
        this.startFailed(w, error);
        return;
      }
      // The terminal host died and took the process with it: nothing the worker did.
      if (lost && !this.closing) {
        if (midTurn(w)) w.interrupted = true;
        const err = this.resume(info.id);
        // Its conversation is open in a terminal by now: it waits, asleep, rather than open it twice.
        if (err) {
          info.status = 'exited';
          this.events.toast(err, 'warn');
          this.emitUpdate(w);
        }
        return;
      }
      if (isCodex && !this.closing) this.scheduleScan(w);
      // Resuming a conversation Claude no longer has ("No conversation found") exits before Claude
      // ever starts. Start a fresh one rather than leave the worker asleep.
      if (isClaude && resumeSessionId && info.status === 'starting' && !this.closing) {
        this.events.toast(`${info.name}'s last conversation couldn't be resumed — starting a fresh one`, 'warn');
        this.launch(w, undefined, undefined);
        return;
      }
      info.exitCode = exitCode;
      info.status = 'exited';
      const hint = info.kind === 'shell' ? ' — press R to restart' : info.sessionId ? ' — press R to resume' : '';
      const msg = `\r\n\x1b[2m[${info.name} exited with code ${exitCode}${hint}]\x1b[0m\r\n`;
      term.write(msg);
      if (w.viewers.size) this.events.data(info.id, msg, [...w.viewers.keys()]);
      w.screenDirty = true;
      w.unsaved = true;
      this.emitUpdate(w);
      this.persist();
      void this.syncBranch(w);
    });
    // SessionStart fires as soon as Claude can take input. Still silent after a while means it is
    // blocked on a human: folder trust dialog, login, first-run onboarding. Flag it so it jumps.
    setTimeout(() => {
      if (info.status !== 'starting' || w.pty !== proc) return;
      if (isClaude || isCodex) {
        w.bootBlocked = true;
        info.activity = isCodex
          ? 'Open the terminal: complete login and review Office hooks in /hooks'
          : 'Waiting on a setup prompt (trust / login) — open the terminal';
        this.setStatus(w, 'needs_input');
      } else this.setStatus(w, 'idle');
    }, 12000);
  }

  private startFailed(w: Worker, message: string) {
    const what = this.command(w.info);
    const msg = `\r\n\x1b[31mFailed to start ${what}: ${message}\x1b[0m\r\n`;
    w.info.status = 'exited';
    w.info.exitCode = -1;
    w.term?.write(msg);
    if (w.viewers.size) this.events.data(w.info.id, msg, [...w.viewers.keys()]);
    w.screenDirty = true;
    w.unsaved = true;
    this.events.toast(`Could not start ${what}: ${message}`, 'error');
    this.emitUpdate(w);
  }

  /** What a worker's terminal runs: the shell, the configured agent command, or another provider's CLI. */
  private command(info: WorkerInfo): string {
    if (info.kind === 'shell') return defaultShell();
    return info.provider === this.defaultProvider ? this.agentCmd : info.provider ?? this.agentCmd;
  }

  /**
   * Where a worker works: its worktree, a workspace for a worker across repositories, or the checkout
   * it works in itself (this floor's, or one linked to it).
   */
  private cwd(info: WorkerInfo): string {
    const rel = workspaceOf(info);
    if (rel) return path.join(this.dir, rel);
    // One from a terminal carries on in the folder its session ran in, while that's still there.
    const from = this.workers.get(info.id)?.terminal?.cwd;
    return from && existsSync(from) ? from : this.homeDir(info);
  }

  /** Hooks fire in bursts (every tool call); one read a moment later covers the whole burst. */
  private scheduleScan(w: Worker) {
    if (w.scanTimer) return;
    w.scanTimer = setTimeout(() => {
      w.scanTimer = undefined;
      this.scanUsage(w);
    }, 300);
  }

  /** Picks up what the session logged since last time and books the difference. */
  private scanUsage(w: Worker) {
    if (w.info.kind === 'agent' && w.info.provider === 'codex') {
      if (this.workers.get(w.info.id) !== w || !w.codexTranscript || !w.codexHome || !w.info.sessionId) return;
      const usage = w.codexUsage.read(w.codexTranscript, w.info.sessionId, w.codexHome);
      if (usage && JSON.stringify(usage) !== JSON.stringify(w.info.usage)) {
        w.info.usage = usage;
        this.emitUpdate(w);
        this.persist();
      }
      return;
    }
    if (w.info.kind !== 'agent' || (w.info.provider !== 'claude' && w.info.provider !== 'custom') || !w.tracker.transcript || this.workers.get(w.info.id) !== w) return;
    try {
      if (!scanTracker(w.tracker)) return;
    } catch {
      return; // an unreadable transcript is retried on the next scan
    }
    const before = w.info.usage ?? zeroUsage();
    const after = trackerUsage(w.tracker);
    w.info.usage = after;
    this.ledger.add(addUsage(after, before, -1));
    this.emitUpdate(w);
    this.persist();
  }

  private onProgress(w: Worker, busy: boolean) {
    const s = w.info.status;
    if (busy && (s === 'idle' || s === 'done' || s === 'starting')) this.setStatus(w, 'working');
    // Progress stays busy while a permission prompt is open, so going idle from needs_input means the
    // turn ended without a Stop hook (the prompt was rejected or Esc'd).
    else if (!busy && (s === 'working' || (s === 'needs_input' && !w.bootBlocked))) this.setStatus(w, 'done');
  }

  private setStatus(w: Worker, status: WorkerStatus) {
    if (w.info.status === status) return;
    if (w.info.status === 'needs_input') w.leftNeedsInputAt = Date.now();
    w.info.status = status;
    // Done, idle or asleep: it's not acting anything out any more.
    if (status !== 'working' && status !== 'needs_input') w.info.action = undefined;
    // Nobody is looking at the terminal right now -> raise the flag (the worker jumps). A worker at the
    // meeting table that ends its part is waiting on the meeting, not on anyone, so it stays quiet.
    if (status === 'done' || status === 'needs_input') {
      w.info.acked = status === 'done' && (w.viewers.size > 0 || !!w.info.meeting);
      w.info.waitingSince = Date.now();
    } else w.info.acked = true;
    this.emitUpdate(w);
    // What a restarted office picks the worker back up as, should its terminal outlive this one.
    if (w.pty?.id) this.persist();
    // At rest: it may have made a branch of its own this turn, and opened its PR from there.
    if (status === 'done' || status === 'idle') void this.syncBranch(w);
  }

  private syncViewers(w: Worker): boolean {
    const names = [...new Set(w.viewers.values())];
    const ids = [...w.viewers.keys()];
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((n, i) => n === b[i]);
    if (same(names, w.info.viewers) && same(ids, w.info.viewerIds)) return false;
    w.info.viewers = names;
    w.info.viewerIds = ids;
    return true;
  }

  private emitUpdate(w: Worker) {
    this.events.update({ ...w.info });
  }

  /** Full screens for every running worker — sent to people as they walk in. */
  fullScreens() {
    const out: { workerId: string; frame: NonNullable<ReturnType<typeof snapshotScreen>> }[] = [];
    for (const w of this.workers.values()) {
      if (!w.term) continue;
      const frame = snapshotScreen(w.term, []);
      if (frame) out.push({ workerId: w.info.id, frame });
    }
    return out;
  }

  private flushScreens() {
    const now = Date.now();
    for (const w of this.workers.values()) {
      if (!w.term) continue;
      // Diffs can be dropped for slow clients, so resend the whole screen now and then.
      if (now - w.keyframeAt > KEYFRAME_MS) {
        w.keyframeAt = now;
        w.lastLines = [];
        w.screenDirty = true;
      }
      if (!w.screenDirty) continue;
      w.screenDirty = false;
      this.checkBlocked(w);
      const frame = snapshotScreen(w.term, w.lastLines);
      if (frame) this.events.screen(w.info.id, frame);
    }
  }

  /**
   * Claude can sit at its prompt without being usable: stuck on a first-run screen, or not signed
   * in on this machine. Flag that as needing a human, and clear it once the screen moves on.
   */
  private checkBlocked(w: Worker) {
    if (w.info.kind !== 'agent' || !w.term || (w.info.provider !== 'claude' && w.info.provider !== 'custom')) return;
    const s = w.info.status;
    if (s !== 'starting' && s !== 'idle' && !(w.bootBlocked && s === 'needs_input')) return;
    // Only this run's output counts: a "Not logged in" in the scrollback from before is old news.
    const text = screenText(w.term, w.term.buffer.active.type === 'normal' ? Math.max(0, w.fresh?.line ?? 0) : 0);
    const loggedOut = NOT_LOGGED_IN.test(text);
    const blocked = loggedOut || (SETUP_PROMPT.test(text) && (s === 'starting' || w.bootBlocked));
    if (blocked && s !== 'needs_input') {
      w.bootBlocked = true;
      w.info.activity = loggedOut
        ? "Claude isn't signed in on this machine — open the terminal and type /login"
        : 'Waiting on a setup prompt (trust / login) — open the terminal';
      this.setStatus(w, 'needs_input');
    } else if (!blocked && w.bootBlocked && s === 'needs_input') {
      w.bootBlocked = false;
      w.info.activity = undefined;
      this.setStatus(w, 'idle');
    }
  }

  private writeHookSettings() {
    const events: [string, string | undefined][] = [
      ['SessionStart', undefined],
      ['UserPromptSubmit', undefined],
      ['Stop', undefined],
      ['Notification', undefined],
      ['PermissionRequest', undefined],
      ['PreToolUse', undefined],
      ['PostToolUse', undefined],
      ['PostToolUseFailure', undefined],
    ];
    // Minimal VPS images sometimes lack curl; the office's own node binary is always there.
    const nodeHook = path.join(this.dataDir, 'hook.cjs');
    writeFileSync(
      nodeHook,
      `const http = require('http');
const [event] = process.argv.slice(2);
let body = '';
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', () => {
  const url = new URL(process.env.AGENT_OFFICE_HOOK_URL + '/hooks/claude');
  url.searchParams.set('worker', process.env.AGENT_OFFICE_WORKER_ID);
  url.searchParams.set('event', event);
  const send = (tries) => {
    const req = http.request(url, { method: 'POST', timeout: 3000, headers: { authorization: 'Bearer ' + process.env.AGENT_OFFICE_HOOK_TOKEN, 'content-type': 'application/json' } }, (res) => res.resume());
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED' && tries > 1) setTimeout(() => send(tries - 1), 1000);
    });
    req.on('timeout', () => req.destroy());
    req.end(body);
  };
  send(${HOOK_TRIES});
});
`,
      { mode: 0o600 },
    );
    const hooks: Record<string, unknown[]> = {};
    for (const [event, matcher] of events) {
      const curl =
        `curl -sS -m 3 --retry ${HOOK_TRIES - 1} --retry-delay 1 --retry-connrefused -X POST -H "Authorization: Bearer $AGENT_OFFICE_HOOK_TOKEN" -H "Content-Type: application/json" ` +
        `--data-binary @- "$AGENT_OFFICE_HOOK_URL/hooks/claude?worker=$AGENT_OFFICE_WORKER_ID&event=${event}"`;
      const command =
        `if [ -z "$AGENT_OFFICE_WORKER_ID" ] || [ -z "$AGENT_OFFICE_HOOK_URL" ]; then exit 0; fi; ` +
        `if command -v curl >/dev/null 2>&1; then ${curl} >/dev/null 2>&1; ` +
        `else ${shq(process.execPath)} ${shq(nodeHook)} ${event} >/dev/null 2>&1; fi; true`;
      hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] }];
    }
    writeFileSync(this.settingsPath, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
  }

  /**
   * Writes the office-queue command into the data dir's bin/, running bin/office-queue.js with the
   * office's own node, and returns that directory. Rewritten on every start, so after an upgrade it
   * runs the new install's script.
   */
  private writeQueueCommand(): string | undefined {
    const script = queueScript();
    if (!script) return undefined;
    const dir = path.join(this.dataDir, 'bin');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'office-queue');
    writeFileSync(file, `#!/bin/sh\n# Agent Office's task queue, for the board agents (see bin/office-queue.js).\nexec ${shq(process.execPath)} ${shq(script)} "$@"\n`, { mode: 0o700 });
    chmodSync(file, 0o700);
    // cmd.exe and PowerShell find it by PATHEXT; Git Bash (Claude Code's shell there) runs the sh one.
    if (WIN) writeFileSync(`${file}.cmd`, `@"${process.execPath}" "${script}" %*\r\n`);
    return dir;
  }

  private saveScrollback(w: Worker) {
    if (!w.term || !w.ser) return;
    w.unsaved = false;
    this.scrollback.save(w.info.id, terminalTail(w.term, w.ser, SCROLLBACK));
  }

  private persist() {
    // Which repository each one in a linked checkout works in, while the floor has it (see linkOf).
    for (const w of this.workers.values()) if (w.info.checkout) this.linkOf(w);
    const saved = [...this.workers.values()].map(({ info, owner, tracker, codexTranscript, hookToken, pty, bootBlocked, interrupted, terminal, noWake, saved: waiting, checkoutName, checkoutAt }) => ({
      id: info.id,
      owner,
      kind: info.kind,
      provider: info.provider,
      model: info.model,
      effort: info.effort,
      deskId: info.deskId,
      name: info.name,
      color: info.color,
      createdBy: info.createdBy,
      createdAt: info.createdAt,
      prompt: info.prompt,
      worktree: info.worktree,
      repos: info.repos,
      checkout: info.checkout,
      // So a floor that no longer has it can still say which repository it was (see stranded).
      checkoutName: info.checkout ? checkoutName : undefined,
      checkoutAt: info.checkout ? checkoutAt : undefined,
      title: info.title,
      sessionId: info.sessionId,
      activity: info.activity,
      task: info.task,
      pr: info.pr,
      meeting: info.meeting,
      external: info.external,
      terminal,
      noWake: noWake || undefined,
      tracker: info.kind === 'agent' ? tracker : undefined,
      usage: info.provider === 'opencode' || info.provider === 'codex' ? info.usage : undefined,
      codexTranscript: info.provider === 'codex' ? codexTranscript : undefined,
      // A terminal still running in the host, to pick back up after a restart. Its hooks keep the token.
      hookToken,
      // Or one kept in the host for a worker whose repository is off the floor for now (see stranded).
      pty: pty?.id ? { id: pty.id, pid: pty.pid, status: info.status, acked: info.acked, waitingSince: info.waitingSince } : waiting ? { id: waiting.ptyId, pid: waiting.pid, status: waiting.status, acked: waiting.acked, waitingSince: waiting.waitingSince } : undefined,
      // In the middle of something: if its terminal doesn't make it through a restart, it carries on after.
      midTurn: !this.stopping && (!!interrupted || midTurn({ info, bootBlocked })),
    }));
    try {
      writeFileSync(this.statePath, JSON.stringify(saved, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }

  private restore() {
    if (!existsSync(this.statePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as (Partial<WorkerInfo> & { owner?: unknown; tracker?: unknown; codexTranscript?: unknown; hookToken?: unknown; pty?: any; midTurn?: unknown; terminal?: any; noWake?: unknown; checkoutName?: unknown; checkoutAt?: any })[];
      for (const s of saved) {
        if (!s.id || !s.deskId || !DESK_BY_ID.has(s.deskId) || this.deskOccupied(s.deskId)) continue;
        // A linked checkout of this floor's (see setLinks). One the floor no longer has can't be worked in,
        // but the worker stays, with its worktree and its terminal, until it's back (see stranded).
        const checkout = typeof s.checkout === 'string' && /^[a-z0-9-]{1,40}$/.test(s.checkout) ? s.checkout : undefined;
        const tracker = restoreTracker(s.tracker);
        const provider = s.kind === 'shell'
          ? undefined
          : s.provider === 'claude' || s.provider === 'opencode' || s.provider === 'codex' || s.provider === 'custom'
            ? s.provider
            : tracker.transcript
              ? 'claude'
              : this.defaultProvider;
        const info: WorkerInfo = {
          id: s.id,
          kind: s.kind === 'shell' ? 'shell' : 'agent',
          provider,
          model: provider === 'opencode' && isValidOpenCodeModel(s.model) ? s.model : provider === 'claude' && isClaudeModel(s.model) ? s.model : undefined,
          effort: provider === 'claude' && isAgentEffort(s.effort) ? s.effort : undefined,
          deskId: s.deskId,
          name: s.name ?? 'Worker',
          color: s.color ?? COLORS[0],
          status: 'offline',
          acked: true,
          createdBy: s.createdBy ?? '?',
          createdAt: s.createdAt ?? Date.now(),
          prompt: s.prompt,
          worktree: s.worktree,
          repos: s.worktree ? validRepos(s.repos) : undefined,
          checkout,
          title: s.title,
          sessionId: s.sessionId,
          activity: s.activity,
          task: validTask(s.task),
          pr: s.pr && typeof s.pr.number === 'number' && typeof s.pr.url === 'string' ? { number: s.pr.number, url: s.pr.url } : undefined,
          usage: provider === 'opencode' || provider === 'codex' ? reportedUsage(s.usage) : (provider === 'claude' || provider === 'custom') && tracker.transcript ? trackerUsage(tracker) : undefined,
          cols: 100,
          rows: 30,
          viewers: [],
          viewerIds: [],
          meeting: typeof s.meeting === 'string' && DESK_BY_ID.get(s.deskId)?.room ? s.meeting : undefined,
          // Still in someone's terminal, as far as the last office knew: the first syncTerminals says whether it still is.
          external: s.external && Number.isInteger(s.external.pid) && s.external.pid > 0 ? { pid: s.external.pid, since: typeof s.external.since === 'number' ? s.external.since : 0 } : undefined,
        };
        const w = newWorker(info, tracker, typeof s.hookToken === 'string' && s.hookToken ? s.hookToken : undefined);
        if (typeof s.owner === 'string' && s.owner) w.owner = s.owner;
        if (checkout) {
          w.checkoutName = typeof s.checkoutName === 'string' ? s.checkoutName.slice(0, 100) : undefined;
          const at = s.checkoutAt;
          if (at && typeof at.dir === 'string' && path.isAbsolute(at.dir)) w.checkoutAt = { dir: at.dir, repo: normalizeRepo(at.repo) };
        }
        if (provider === 'codex' && typeof s.codexTranscript === 'string') w.codexTranscript = s.codexTranscript;
        // The folder a terminal's session ran in: only ever one in this floor's checkout.
        const from = s.terminal?.cwd;
        if (typeof from === 'string' && path.isAbsolute(from) && this.inFloor(from)) w.terminal = { cwd: path.resolve(from), procStart: typeof s.terminal.procStart === 'string' ? s.terminal.procStart.slice(0, 64) : undefined };
        w.noWake = s.noWake === true;
        w.screenDirty = false;
        if (typeof s.pty?.id === 'string') {
          const status: WorkerStatus = RUNNING.has(s.pty.status) ? s.pty.status : 'idle';
          w.saved = { ptyId: s.pty.id, pid: Number.isInteger(s.pty.pid) && s.pty.pid > 0 ? s.pty.pid : undefined, status, acked: s.pty.acked !== false, waitingSince: typeof s.pty.waitingSince === 'number' ? s.pty.waitingSince : undefined };
        }
        // Mid-turn as the office went down: cut off, unless its terminal is picked back up still
        // running (adopt). An office from before midTurn only said so for a terminal in the host.
        w.interrupted = typeof s.midTurn === 'boolean' ? s.midTurn : s.pty?.status === 'working' || s.pty?.status === 'needs_input';
        if (info.prompt) w.prompts = [info.prompt.replace(/\s+/g, ' ').trim()];
        this.workers.set(info.id, w);
        const why = this.stranded(info.id);
        if (why) {
          info.activity = why;
          console.warn(`agent-office: ${why}`);
        }
      }
    } catch {
      // corrupt state file: start fresh
    }
  }
}

// ---------------------------------------------------------------------------

/** In the middle of a turn: working, or asking something (not stuck on a trust or login screen). */
function midTurn({ info, bootBlocked }: Pick<Worker, 'info' | 'bootBlocked'>): boolean {
  return info.kind === 'agent' && (info.status === 'working' || (info.status === 'needs_input' && !bootBlocked));
}

function newWorker(info: WorkerInfo, tracker: UsageTracker, hookToken = randomBytes(16).toString('hex')): Worker {
  return {
    info,
    viewers: new Map(),
    screenDirty: true,
    lastLines: [],
    leftNeedsInputAt: 0,
    keyframeAt: 0,
    hookToken,
    codexUsage: new CodexUsageReader(),
    codexTools: new Map(),
    codexPending: new Set(),
    failStreak: 0,
    prompts: [],
    tools: [],
    toolsSinceNamed: 0,
    namedAt: 0,
    taskEpoch: 0,
    tracker,
  };
}

/** Where a Codex worker's sessions are logged, for reading its usage. */
function codexHome(cwd: string, env: NodeJS.ProcessEnv): string {
  return path.resolve(cwd, env.CODEX_HOME || path.join(env.HOME || homedir(), '.codex'));
}

function withoutOpenCodeModel(args: string[]): string[] {
  const clean: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' || arg === '-m') {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (arg.startsWith('--model=') || (arg.startsWith('-m') && arg.length > 2)) continue;
    clean.push(arg);
  }
  return clean;
}

/** The office's environment, minus anything that would make a child think it's a nested session. */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !scrubbed(k)) env[k] = v;
  return env;
}

function validTask(t: unknown): WorkerTask | undefined {
  const v = t as Partial<WorkerTask> | undefined;
  return typeof v?.name === 'string' && typeof v.summary === 'string' ? { name: v.name, summary: v.summary } : undefined;
}

function isOpenCodeHookEvent(value: unknown): value is OpenCodeStatusEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === 'string' && ['session', 'prompt', 'tool', 'permission', 'question', 'error'].includes(v.type)
    && typeof v.sessionId === 'string' && v.sessionId.length > 0
    && typeof v.status === 'string' && ['starting', 'working', 'needs_input', 'done'].includes(v.status)
    && (v.prompt === undefined || typeof v.prompt === 'string')
    && (v.tool === undefined || typeof v.tool === 'string')
    && (v.detail === undefined || typeof v.detail === 'string');
}

function snapshotScreen(term: HeadlessTerminal, last: string[]) {
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;
  const full = last.length !== rows;
  const lines: Record<number, Run[]> = {};
  let changed = false;
  const cell = buf.getNullCell();
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    const runs: Run[] = [];
    if (line) {
      let cur: Run | null = null;
      for (let x = 0; x < cols; x++) {
        line.getCell(x, cell);
        const width = cell.getWidth();
        if (width === 0) continue;
        const ch = cell.getChars() || ' ';
        const fg = cell.isFgDefault() ? -1 : cell.isFgRGB() ? RGB_FLAG | cell.getFgColor() : cell.getFgColor();
        const bg = cell.isBgDefault() ? -1 : cell.isBgRGB() ? RGB_FLAG | cell.getBgColor() : cell.getBgColor();
        const flags = (cell.isBold() ? FLAG_BOLD : 0) | (cell.isInverse() ? FLAG_INVERSE : 0) | (cell.isDim() ? FLAG_DIM : 0);
        if (cur && cur[1] === fg && cur[2] === bg && cur[3] === flags) cur[0] += ch;
        else {
          cur = [ch, fg, bg, flags];
          runs.push(cur);
        }
      }
    }
    // Trim trailing default-styled whitespace to keep frames small.
    while (runs.length) {
      const r = runs[runs.length - 1];
      if (r[2] !== -1 || r[3] & FLAG_INVERSE) break;
      const trimmed = r[0].replace(/\s+$/, '');
      if (trimmed) {
        r[0] = trimmed;
        break;
      }
      runs.pop();
    }
    const key = JSON.stringify(runs);
    if (full || last[y] !== key) {
      lines[y] = runs;
      last[y] = key;
      changed = true;
    }
  }
  last.length = rows;
  if (!changed) return null;
  return { cols, rows, lines, full, cursor: [buf.cursorX, buf.cursorY] as [number, number] };
}

/** First-run screens Claude shows before it can take a prompt. */
const SETUP_PROMPT = /trust this folder|Do you trust the files|Select login method|Choose the text style|Press Enter to continue|Bypass Permissions mode/i;
const NOT_LOGGED_IN = /Not logged in\s*·\s*Run \/login|Invalid API key|Please run \/login/i;

/** The text on screen, leaving out rows above buffer row `from`. */
function screenText(term: HeadlessTerminal, from = 0): string {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let y = Math.max(0, from - buf.viewportY); y < term.rows; y++) out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
  return out.join('\n');
}

/** bin/office-queue.js in the install this office runs from (src/server under tsx, dist/server/server built). */
function queueScript(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
    const file = path.join(dir, 'bin', 'office-queue.js');
    if (existsSync(file)) return file;
  }
  return undefined;
}

const WIN = process.platform === 'win32';

/** The shell workers get when none is configured: $SHELL on Unix, cmd.exe on Windows. */
export function defaultShell(): string {
  return process.env.SHELL || (WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/bash');
}

/** How to have the default shell run one command line. */
function shellRun(line: string): string[] {
  return WIN && !process.env.SHELL ? ['/d', '/s', '/c', line] : ['-l', '-i', '-c', line];
}

export function resolveCommand(cmd: string): string | null {
  // Windows runs files by extension: `claude` is really claude.exe / claude.cmd. An npm shim with
  // no extension is a sh script the console can't run, so only take it when asked for by name.
  const exts = WIN && !path.extname(cmd) ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const usable = (p: string): string | null => {
    for (const ext of exts) {
      try {
        accessSync(p + ext, constants.X_OK);
        return p + ext;
      } catch {
        // keep looking
      }
    }
    return null;
  };
  if (cmd.includes('/') || (WIN && cmd.includes('\\'))) {
    const found = usable(cmd);
    return found && path.resolve(found);
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const found = usable(path.join(dir, cmd));
    if (found) return found;
  }
  if (WIN && !process.env.SHELL) return null;
  try {
    const found = execFileSync(defaultShell(), ['-l', '-i', '-c', `command -v ${shq(cmd)}`], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .pop();
    if (found && found.startsWith('/')) return found;
  } catch {
    // fall through
  }
  return null;
}

function describeTool(payload: any): string {
  const name = payload?.tool_name ?? 'tool';
  const input = payload?.tool_input ?? {};
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? '';
  return truncate(detail ? `${name}: ${detail}` : String(name), 80);
}

function offlineBanner(info: WorkerInfo): string {
  if (info.external) return `\x1b[2m${info.name} is running in your terminal (PID ${info.external.pid}), not in the office. Take it over to carry it on here.\x1b[0m\r\n`;
  const hint = info.kind === 'shell' ? ' Press R to restart it.' : info.sessionId ? ' Press R to resume the session.' : '';
  return `\x1b[2m${info.name} is not running.${hint}\x1b[0m\r\n`;
}

/** Runs a command without blocking the office (with `env`: as someone else); rejects with the last lines of its stderr. */
function run(cmd: string, args: string[], cwd: string, timeout = 30_000, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').filter(Boolean).slice(-2).join(' ') || `${cmd} failed`));
      else resolve(stdout.trim());
    });
  });
}

/**
 * The folder each checkout gets in a workspace: its folder's name, made safe, with -2, -3… when two
 * checkouts share one (owner-a/api and owner-b/api).
 */
export function workspaceNames(dirs: string[]): string[] {
  const used = new Set<string>();
  return dirs.map((dir) => {
    let base = path.basename(path.resolve(dir)).replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '') || 'project';
    if (WORKSPACE_FILES.has(base)) base = `${base}-repo`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** Takes a workspace folder away once its worktrees are gone: only the brief the office wrote, never anything else left in it. */
function clearWorkspace(abs: string) {
  try {
    for (const name of readdirSync(abs)) if (WORKSPACE_FILES.has(name)) unlinkSync(path.join(abs, name));
    rmdirSync(abs);
  } catch {
    // already gone, or something else is in it: it stays
  }
}

/** The other repositories of a worker across repositories, as workers.json kept them. */
function validRepos(raw: unknown): WorkerRepo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const repos = raw.flatMap((r): WorkerRepo[] => {
    const floor = str(r?.floor), name = str(r?.name), dir = str(r?.dir), rel = str(r?.path), branch = str(r?.branch), base = str(r?.base);
    if (!floor || !name || !dir || !rel || !branch || !base) return [];
    const pr = r.pr && typeof r.pr.number === 'number' && typeof r.pr.url === 'string' ? { number: r.pr.number, url: r.pr.url } : undefined;
    return [{ floor, checkout: str(r.checkout), name, repo: str(r.repo), dir, path: rel, branch, base, from: str(r.from), pr }];
  });
  return repos.length ? repos : undefined;
}

/** owner/name of a checkout's origin on GitHub, when it has one. */
function originRepo(dir: string): string | undefined {
  try {
    return normalizeRepo(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim());
  } catch {
    return undefined;
  }
}

async function findOpenPr(branch: string, cwd: string): Promise<{ number: number; url: string } | undefined> {
  const out = await gh(['pr', 'list', '--head', branch, '--state', 'open', '--limit', '1', '--json', 'number,url'], cwd);
  const found = (JSON.parse(out || '[]') as { number: number; url: string }[])[0];
  return found ? { number: found.number, url: found.url } : undefined;
}

/** `gh pr create` for a pushed branch; resolves to the new pull request. */
async function createPr(branch: string, base: string | undefined, title: string, body: string, cwd: string, as?: GhAs): Promise<{ number: number; url: string }> {
  const out = await gh(['pr', 'create', '--head', branch, ...(base ? ['--base', base] : []), '--title', title, '--body', body], cwd, 60_000, as?.env);
  const url = out.trim().split('\n').pop() ?? '';
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  if (!number) throw new Error(`gh did not return a pull request URL (${truncate(out, 120)})`);
  return { number, url };
}

/** owner/name#12 for a pull request on GitHub (which links it with its title), else its URL. */
function prRef(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]}#${m[2]}` : url;
}

/** The list of a change's pull requests across repositories, for the description of the one at `self`. */
export function relatedBlock(prs: { repo?: string; url: string }[], self: string, branch: string): string {
  const lines = prs.map((p) => `- ${p.repo ? `**${p.repo}**: ` : ''}${prRef(p.url)}${p.url === self ? ' (this one)' : ''}`);
  return [RELATED_START, `**One change across ${prs.length} repositories**, each on \`${branch}\`: review and merge them together.`, '', ...lines, RELATED_END].join('\n');
}

/** A description with its list of related pull requests put in, or brought up to date. */
export function withRelated(body: string, block: string): string {
  const at = body.indexOf(RELATED_START);
  const end = at < 0 ? -1 : body.indexOf(RELATED_END, at);
  if (end >= 0) return body.slice(0, at) + block + body.slice(end + RELATED_END.length);
  return body.trim() ? `${body.trimEnd()}\n\n${block}` : block;
}

/**
 * A pull request title and body from what the worker was asked to do. The title is the issue's
 * title when the task came off the issues board, else the task's first line; the body carries the
 * task, the commits, a "Closes #n" when the task asked for one, and which desk it came from. With
 * `other`, it's for one of the other repositories of a worker across repositories: the issue is its
 * own floor's (`home`), so this one only mentions it.
 */
function draftPr(info: WorkerInfo, commits: string[], by: string, other?: { home?: string }, self?: string): { title: string; body: string } {
  const task = (info.prompt ?? '').replace(/\r\n?/g, '\n').trim();
  const firstLine = task.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  // The issues board hands work over as: Work on GitHub issue #12: "Title", or on a floor with more
  // than one repository as: Work on GitHub issue owner/name#12: "Title".
  const issue = /\bissue (?:([\w.-]+\/[\w.-]+))?#(\d+):\s*["“](.+?)["”]\.?\s*$/i.exec(firstLine);
  const title = truncate(issue?.[3] || firstLine.replace(/[.:;,]+$/, '') || commits[0]?.replace(/^\S+\s+/, '') || info.worktree?.branch || info.name, PR_TITLE_MAX);
  const closing = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[^\n]{0,40}?(?:([\w.-]+\/[\w.-]+))?#(\d+)/i.exec(task);
  const closes = closing?.[2] ?? issue?.[2];
  // The repository the issue is in, when the task says (`self` is this pull request's): another one's
  // has to be named for GitHub to close it.
  const where = closing ? closing[1] : issue?.[1];
  const ref = where && !sameRepo(where, self) ? `${where}#${closes}` : `#${closes}`;
  const parts: string[] = [];
  if (task) parts.push(`## Task\n\n${task.length > PR_TASK_MAX ? `${task.slice(0, PR_TASK_MAX)}…` : task}`);
  parts.push(`## Commits\n\n${commits.map((c) => `- \`${c.slice(0, c.indexOf(' '))}\` ${c.slice(c.indexOf(' ') + 1)}`).join('\n')}`);
  if (closes && !other) parts.push(`Closes ${ref}`);
  else if (closes && (where ?? other?.home)) parts.push(`Part of ${where ?? other?.home}#${closes}`);
  parts.push(`_Opened from Agent Office by ${by} · ${info.name} at ${DESK_BY_ID.get(info.deskId)?.label ?? info.deskId}_`);
  return { title, body: parts.join('\n\n') };
}

/** `p` with its symlinks resolved, or as it is when it isn't there. */
function realDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Whether `link` is the repository a worker worked in (see Worker.checkoutAt; none known: any is). */
function sameCheckout(link: LinkedCheckout, at: { dir: string; repo?: string } | undefined): boolean {
  if (!at) return true;
  return realDir(link.dir) === at.dir && (!at.repo || !link.repo || sameRepo(at.repo, link.repo));
}

/** `p` is `root` or somewhere under it. */
function inside(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function truncate(s: string, n: number) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function shq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
