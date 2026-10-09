import type { FloorInfo, FloorLinkInfo, LocalCheckout, RepoChoice, ServerMsg } from '../../shared/protocol';
import { floorPalette, normalizeRepo, sameRepo } from '../../shared/floors';
import { ROOF, ROOF_NAME } from '../../shared/rooftop';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo, type Modal } from './dom';
import { confirmDialog } from './prompt';

// The elevator's panel: a button for every floor (every project), and "add a project", which makes a
// floor of a checkout already on the office's machine, where it is (admins), or clones one of the
// repositories the office's gh login can see and makes that a new floor. The first time
// the office runs there are no floors, and this is where you start. Admins can take a floor off the
// building here too; its checkout stays on disk. Under the floors, it goes down to the garage.
// Under each floor are the other repositories linked to it (feyer-app on feyer's floor, say), and
// admins add another with the same two lists, picking one to join that floor instead of a floor of its own.

/**
 * The garage under the building, where the elevator goes too. It isn't a floor: it's down under the
 * one you're on (from the roof, the bottom one), level with the street.
 */
export const GARAGE = '@garage';

export interface ElevatorOptions {
  net: Net;
  /** Rides to a floor, the roof (ROOF) or the garage (GARAGE). */
  ride(floorId: string): void;
  /** You're down in the garage (or out on the street), under the floor you're on. */
  downstairs(): boolean;
}

/** How many repositories the list shows at once; typing narrows it down. */
const SHOWN = 60;
/** Ask gh for the repositories again after this long. */
const REPOS_STALE_MS = 5 * 60_000;
/** Look in the projects folder again after this long: Claude sessions come and go. */
const LOCAL_STALE_MS = 15_000;

const addedWaiters = new Set<(msg: Extract<ServerMsg, { t: 'floor.added' }>) => void>();
const linkedWaiters = new Set<(msg: Extract<ServerMsg, { t: 'floor.linked' }>) => void>();

/** Main feeds server messages through here, so a panel waiting on its clone hears back. */
export function routeElevatorMessage(msg: ServerMsg) {
  if (msg.t === 'floor.added') for (const fn of addedWaiters) fn(msg);
  if (msg.t === 'floor.linked') for (const fn of linkedWaiters) fn(msg);
}

/** The floor a repository is on, as its own or linked to it, if it's in the building. */
function floorWithRepo(repo: string): FloorInfo | undefined {
  return store.floors.find((f) => sameRepo(f.repo, repo) || f.links?.some((l) => sameRepo(l.repo, repo)));
}

let current: Modal | null = null;

export function elevatorPanelOpen(): boolean {
  return !!current;
}

export function openElevator(opts: ElevatorOptions): void {
  if (current) return;
  // Nowhere to go yet: the panel greets you. It closes like any other; the elevator (or the floor
  // name in the corner) opens it again.
  const setup = !store.floor;
  const { net } = opts;
  let filter = '';
  let selected: string | null = null;
  let adding: string | null = null;
  let error = '';
  let showAdd = setup || !store.floors.length;
  /** Which list "add a project" shows: checkouts on this machine (admins, who can add those), or GitHub. */
  let source: 'local' | 'github' = store.me.admin ? 'local' : 'github';
  /** The checkout picked in the local list, by its folder. */
  let selectedDir: string | null = null;
  /** "➕ Add a repo to this floor": what's picked joins this floor, rather than becoming a floor of its own. */
  let linkTo: string | null = null;
  /** The search box and list are in place (rebuilding them would lose the focus mid-typing). */
  let built = false;

  const floorsEl = h('div.floors');
  const addEl = h('div.add');
  const input = h('input', { type: 'text', placeholder: 'Search your repositories, or type owner/name', 'aria-label': 'Repository', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const listEl = h('div.repo-list', { role: 'listbox', 'aria-label': 'Repositories' });
  const statusEl = h('div');
  const addBtn = h('button.btn.primary', { type: 'button' }, '🛗 Add floor');
  const refreshBtn = h('button.btn', { type: 'button', title: 'Look again' }, '↻');
  const localTab = h('button.btn', { type: 'button', title: 'Git checkouts already in the workspace folder: the floor works in it where it is, nothing is cloned' }, '💻 On this machine');
  const githubTab = h('button.btn', { type: 'button', title: "Repositories this machine's gh login can clone" }, '🐙 GitHub');
  const tabsEl = h('div.seg.add-tabs', { role: 'tablist' }, localTab, githubTab);
  const pathInput = h('input', { type: 'text', placeholder: '…or a folder path, like ~/Projects/my-app', 'aria-label': 'Folder of a checkout', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const pathAdd = h('button.btn', { type: 'button', title: 'Make a floor of the checkout in this folder' }, 'Add');
  const pathEl = h('div.repo-search.path-add', {}, pathInput, pathAdd);
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const addTitle = h('h3');
  const notLinking = h('button.btn.dir-change', { type: 'button', title: 'Add a project as a floor of its own instead' }, '✕ Not to this floor');

  // Where clones go. Admins can move it right here: the first project is when it matters.
  const dirInput = h('input', { type: 'text', placeholder: '~/Workspace', 'aria-label': 'Workspace folder', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const dirSave = h('button.btn.primary', { type: 'button' }, 'Save');
  const dirCancel = h('button.btn', { type: 'button' }, 'Cancel');
  const dirEl = h('div.webhook.dir-pick.hidden', {}, dirInput, dirSave, dirCancel);
  const editDir = (on: boolean) => {
    dirEl.classList.toggle('hidden', !on);
    if (!on) return;
    dirInput.value = store.projectsDir.dir;
    setTimeout(() => dirInput.focus(), 0);
  };
  const saveDir = () => {
    const dir = dirInput.value.trim();
    if (!dir) return dirInput.focus();
    // The server says why it can't, if it can't; the folder moving closes this.
    if (dir === store.projectsDir.dir) editDir(false);
    else net.send({ t: 'floor.projectsDir', dir });
  };
  dirSave.addEventListener('click', saveDir);
  dirCancel.addEventListener('click', () => editDir(false));
  dirInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) saveDir();
  });

  const needRepos = () => {
    const r = store.repos;
    if (r.loading || (r.at && Date.now() - r.at < REPOS_STALE_MS && !r.error)) return;
    store.repos = { ...r, loading: true };
    net.send({ t: 'floor.repos' });
  };

  const needLocal = () => {
    const l = store.local;
    if (!store.me.admin || l.loading || (l.at && Date.now() - l.at < LOCAL_STALE_MS && !l.error)) return;
    store.local = { ...l, loading: true };
    net.send({ t: 'floor.local' });
  };

  /** What "Add floor" would add: the row picked, else what's typed if it's owner/name. */
  const choice = (): string | undefined => selected ?? normalizeRepo(filter);
  const localPick = (): LocalCheckout | undefined => (selectedDir ? store.local.list.find((c) => c.dir === selectedDir && !c.floored && !c.on) : undefined);
  /** The floor "add" is adding to (see linkTo), while there is one. */
  const linkFloor = (): FloorInfo | undefined => (linkTo ? store.floors.find((f) => f.id === linkTo && !f.cloning) : undefined);

  const floorButton = (f: FloorInfo, i: number) => {
    // Down in the garage, your floor is somewhere to go back up to.
    const mine = f.id === store.floor;
    const here = mine && !opts.downstairs();
    const p = floorPalette(f.palette);
    const stats: (HTMLElement | string)[] = [];
    if (f.cloning) stats.push('⏳ Cloning…');
    else {
      if (f.busy) stats.push(h('span', { title: 'Working' }, `👷 ${f.busy}`));
      if (f.waiting) stats.push(h('span.waiting', { title: 'Waiting on someone' }, `🙋 ${f.waiting}`));
      stats.push(h('span', { title: 'Workers at desks' }, `💻 ${f.workers}`));
      if (f.people) stats.push(h('span', { title: 'People on this floor' }, `🧑 ${f.people}`));
    }
    const btn = h(
      'button.floor-btn',
      { type: 'button', class: here ? 'here' : '', disabled: f.cloning || here, title: here ? "You're on this floor" : f.cloning ? 'Still being cloned' : `Ride ${mine ? 'back up ' : ''}to ${f.name}` },
      h('span.floor-no', { style: `background:${p.trim}` }, String(i + 1)),
      h('span.floor-text', {}, h('span.floor-name', {}, f.name, here ? h('span.here-tag', {}, 'you are here') : mine ? h('span.here-tag', {}, 'your floor') : null), h('span.floor-sub', {}, f.repo ?? f.dir)),
      h('span.floor-stats', {}, ...stats.flatMap((s, j) => (j ? [' ', s] : [s]))),
    );
    btn.addEventListener('click', () => {
      if (here || f.cloning) return;
      modal.close();
      opts.ride(f.id);
    });
    return btn;
  };

  /** The floor's button, with a 🗑 beside it for admins to take it off the building, and the repositories linked to it under it. */
  const floorRow = (f: FloorInfo, i: number) => {
    const btn = floorButton(f, i);
    if (f.cloning) return btn;
    const links = linksOf(f);
    if (!store.me.admin) return links ? h('div.floor-entry', {}, btn, links) : btn;
    const off = h('button.btn.floor-off', { type: 'button', title: `Take ${f.name} off the building`, 'aria-label': `Remove ${f.name}` }, '🗑');
    off.addEventListener('click', () => confirmRemove(f));
    return h('div.floor-entry', {}, h('div.floor-row', {}, btn, off), links);
  };

  /** The other repositories on a floor (see FloorLinkInfo), each with a 🗑 for admins, who can add another. */
  const linksOf = (f: FloorInfo) => {
    const links = f.links ?? [];
    if (!links.length && !store.me.admin) return null;
    const rows = links.map((l) => {
      const off = store.me.admin ? h('button.btn.link-off', { type: 'button', title: `Take ${l.name} off ${f.name}`, 'aria-label': `Remove ${l.name} from ${f.name}` }, '🗑') : null;
      off?.addEventListener('click', () => confirmUnlink(f, l));
      return h('div.floor-link', { title: l.dir }, h('span.nm', {}, `🗂️ ${l.name}`), h('span.desc', {}, [l.repo, l.branch && `🌿 ${l.branch}`].filter(Boolean).join(' · ') || l.dir), off);
    });
    const add = store.me.admin ? h('button.btn.link-add', { type: 'button', class: linkTo === f.id ? 'on' : '', title: `Another repository's checkout on ${f.name}: hire workers in it, and see its issues and PRs on this floor's boards` }, '➕ Add a repo to this floor') : null;
    add?.addEventListener('click', () => startLink(f));
    return h('div.floor-links', {}, ...rows, add);
  };

  /** "➕ Add a repo to this floor": the lists below pick a repository for `f`. */
  const startLink = (f: FloorInfo) => {
    if (adding) return;
    linkTo = f.id;
    showAdd = true;
    selected = null;
    selectedDir = null;
    error = '';
    if (source === 'local') needLocal();
    else needRepos();
    renderFloors();
    renderAdd();
    setTimeout(() => input.focus(), 0);
  };

  const confirmUnlink = (f: FloorInfo, l: FloorLinkInfo) => {
    confirmDialog(
      `Take ${l.name} off ${f.name}?`,
      `Nothing is deleted: its checkout stays in ${l.dir}. Its issues and pull requests leave the boards, and workers can't be hired in it here any more. Anyone still working in it has to go home first.`,
      '🗑 Remove repo',
      () => net.send({ t: 'floor.unlink', floor: f.id, link: l.id }),
    );
  };

  const confirmRemove = (f: FloorInfo) => {
    const next = store.floors.find((o) => o.id !== f.id && !o.cloning);
    const workers = f.workers ? `Its ${f.workers} worker${f.workers === 1 ? '' : 's'} stop${f.workers === 1 ? 's' : ''}. ` : '';
    const people = f.people ? `Everyone on it rides the elevator to ${next ? next.name : 'the lobby'}. ` : '';
    // The office was started in it: its accounts, password and chat live in that .agent-office too, and stay.
    const own = f.local ? ' The office keeps its own settings there too, so it carries on as before, just without this floor.' : '';
    confirmDialog(`Take ${f.name} off the building?`, `${workers}${people}Nothing is deleted: its checkout stays in ${f.dir}, .agent-office folder and all.${own}`, '🗑 Remove floor', () => net.send({ t: 'floor.remove', floor: f.id }));
  };

  /** The roof, over every floor: the rooftop bar. */
  const roofButton = () => {
    const here = store.floor === ROOF;
    const people = [...store.peers.values()].filter((p) => p.floor === ROOF).length;
    const btn = h(
      'button.floor-btn',
      { type: 'button', class: here ? 'here' : '', disabled: here, title: here ? "You're up on the roof" : `Ride up to the ${ROOF_NAME.toLowerCase()}` },
      h('span.floor-no', { style: 'background:#2b2d42' }, '🍸'),
      h('span.floor-text', {}, h('span.floor-name', {}, ROOF_NAME, here ? h('span.here-tag', {}, 'you are here') : null), h('span.floor-sub', {}, 'The roof: a DJ playing drum and bass, a bar, and the city all around')),
      h('span.floor-stats', {}, people ? h('span', { title: 'People up there' }, `🧑 ${people}`) : ''),
    );
    btn.addEventListener('click', () => {
      if (here) return;
      modal.close();
      opts.ride(ROOF);
    });
    return btn;
  };

  /** Under floor 1: the garage, level with the street. */
  const garageButton = () => {
    const here = opts.downstairs();
    const bottom = store.floors.find((f) => !f.cloning);
    const under = store.floor === ROOF ? `Under ${bottom?.name ?? 'the building'}, level with the street` : 'Under the building, level with the street: the cars, and the way out';
    const btn = h(
      'button.floor-btn',
      { type: 'button', class: here ? 'here' : '', disabled: here, title: here ? "You're down at the street" : 'Ride down to the garage' },
      h('span.floor-no', { style: 'background:#2b2d42' }, '🏎️'),
      h('span.floor-text', {}, h('span.floor-name', {}, 'Garage', here ? h('span.here-tag', {}, 'you are here') : null), h('span.floor-sub', {}, under)),
      h('span.floor-stats', {}),
    );
    btn.addEventListener('click', () => {
      if (here) return;
      modal.close();
      opts.ride(GARAGE);
    });
    return btn;
  };

  const renderFloors = () => {
    const floors = store.floors;
    const built = floors.some((f) => !f.cloning);
    // Top floor first, the way an elevator's buttons stack, with the roof over them, floor 1 and then the garage at the bottom.
    floorsEl.replaceChildren(
      ...(built ? [roofButton()] : []),
      ...(floors.length ? floors.map(floorRow).reverse() : [h('p.empty', {}, 'No floors yet.')]),
      ...(built ? [garageButton()] : []),
    );
  };

  const repoRow = (r: RepoChoice) => {
    const floor = floorWithRepo(r.name);
    const row = h(
      'div.repo',
      { role: 'option', class: selected && sameRepo(selected, r.name) ? 'sel' : '', 'aria-selected': String(!!selected && sameRepo(selected, r.name)), title: r.description ?? r.name },
      h('span.nm', {}, r.name),
      r.private ? h('span', { title: 'Private' }, '🔒') : null,
      h('span.desc', {}, r.description ?? ''),
      floor ? h('span.pill', {}, floor.id === store.floor ? 'you are here' : `${sameRepo(floor.repo, r.name) ? '' : 'on '}floor ${store.floors.indexOf(floor) + 1}`) : r.pushedAt ? h('span.when', {}, timeAgo(r.pushedAt)) : null,
    );
    row.addEventListener('click', () => {
      if (adding) return;
      if (floor) {
        // Already a floor: the button takes you there.
        if (floor.id !== store.floor && !floor.cloning) {
          modal.close();
          opts.ride(floor.id);
        }
        return;
      }
      selected = r.name;
      renderAdd();
    });
    row.addEventListener('dblclick', () => {
      if (!floor) add(r.name);
    });
    return row;
  };

  /** A checkout in the projects folder: picked to become a floor, or the floor it already is. */
  const localRow = (c: LocalCheckout) => {
    // A floor's own checkout, or one linked to a floor: either way it's in the building already.
    const placed = !!c.on || c.floored;
    const floor = c.on ? store.floors.find((f) => f.id === c.on) : c.floored ? store.floors.find((f) => f.dir === c.dir) : undefined;
    const sel = selectedDir === c.dir && !placed;
    const row = h(
      'div.repo',
      { role: 'option', class: `${sel ? 'sel' : ''} ${placed ? 'floored' : ''}`, 'aria-selected': String(sel), 'aria-disabled': String(placed), title: c.floored ? `${c.shown} is a floor already` : floor ? `${c.shown} is on ${floor.name} already` : c.shown },
      h('span.nm', {}, c.name),
      h('span.desc', {}, c.repo ? `${c.shown} · ${c.repo}` : c.shown),
      c.sessions ? h('span.pill.live', { title: 'Claude Code running in this folder in a terminal: it sits at a desk on the floor' }, `🟢 ${c.sessions} Claude session${c.sessions === 1 ? '' : 's'}`) : null,
      floor ? h('span.pill', {}, floor.id === store.floor ? 'you are here' : `on floor ${store.floors.indexOf(floor) + 1}`) : placed ? h('span.pill', {}, 'a floor') : null,
    );
    row.addEventListener('click', () => {
      if (adding) return;
      if (floor) {
        if (floor.id !== store.floor && !floor.cloning) {
          modal.close();
          opts.ride(floor.id);
        }
        return;
      }
      if (placed) return;
      selectedDir = c.dir;
      renderAdd();
    });
    row.addEventListener('dblclick', () => {
      if (!placed) addLocal(c.dir);
    });
    return row;
  };

  const renderLocal = () => {
    const l = store.local;
    const q = filter.trim().toLowerCase();
    const matches = l.list.filter((c) => !q || c.name.toLowerCase().includes(q) || c.shown.toLowerCase().includes(q) || (c.repo ?? '').toLowerCase().includes(q));
    // Where Claude is running first, then the ones that could still become a floor.
    matches.sort((a, b) => Number(a.floored || !!a.on) - Number(b.floored || !!b.on) || b.sessions - a.sessions);
    const rows = matches.slice(0, SHOWN).map(localRow);
    if (!rows.length) rows.push(h('p.empty', { style: 'padding:10px' }, l.loading ? `Looking in ${store.projectsDir.dir}…` : l.error ? '' : q ? 'Nothing matches. Type the folder below to add any checkout.' : `No git checkouts in ${store.projectsDir.dir} — type a folder below, or change the workspace folder.`));
    if (matches.length > SHOWN) rows.push(h('p.empty', { style: 'padding:8px 10px' }, `…and ${matches.length - SHOWN} more — type to narrow it down`));
    listEl.replaceChildren(...rows);
    const pick = localPick();
    const change = h('button.btn.dir-change', { type: 'button', title: 'Look for projects in another folder on the office’s machine' }, '📁 Change folder');
    change.addEventListener('click', () => editDir(true));
    const to = linkFloor();
    statusEl.replaceChildren(
      adding
        ? h('p.note.busy', {}, `⏳ Adding ${adding}…`)
        : to
          ? h('p.note', {}, `Checkouts in ${store.projectsDir.dir}. It joins ${to.name} where it is: nothing is cloned. Workers can be hired in it, Claude sessions running there in your terminal sit at ${to.name}'s desks, and its issues and PRs go on the boards.`, change)
          : h('p.note', {}, `Checkouts in ${store.projectsDir.dir}. The floor works in the folder where it is: nothing is cloned, and Claude sessions running there in your terminal show up at its desks.`, change),
      ...[l.error, error].filter(Boolean).map((e) => h('p.err', {}, e)),
    );
    addBtn.disabled = !!adding || !pick;
    addBtn.textContent = adding ? '⏳ Adding…' : pick ? (to ? `🗂️ Add ${pick.name} to ${to.name}` : `🛗 Add ${pick.name}`) : to ? `🗂️ Add to ${to.name}` : '🛗 Add floor';
    pathAdd.toggleAttribute('disabled', !!adding || !pathInput.value.trim());
    pathInput.disabled = !!adding;
    input.disabled = !!adding;
  };

  const renderAdd = () => {
    if (!showAdd) {
      const open = h('button.btn', { type: 'button' }, '➕ Add a project');
      open.addEventListener('click', () => {
        showAdd = true;
        linkTo = null;
        if (source === 'local') needLocal();
        else needRepos();
        renderAdd();
        setTimeout(() => input.focus(), 0);
      });
      addEl.replaceChildren(open);
      addBtn.classList.add('hidden');
      return;
    }
    addBtn.classList.remove('hidden');
    if (!store.me.admin) source = 'github';
    // Gone, or nobody may: back to adding a floor.
    if (linkTo && (!linkFloor() || !store.me.admin)) linkTo = null;
    const to = linkFloor();
    addTitle.replaceChildren(to ? `🗂️ Add a repo to ${to.name}` : setup && !store.floors.length ? 'Pick your first project' : '➕ Add a project', to ? notLinking : '');
    localTab.classList.toggle('on', source === 'local');
    githubTab.classList.toggle('on', source === 'github');
    localTab.setAttribute('aria-selected', String(source === 'local'));
    githubTab.setAttribute('aria-selected', String(source === 'github'));
    tabsEl.classList.toggle('hidden', !store.me.admin);
    pathEl.classList.toggle('hidden', source !== 'local');
    input.placeholder = source === 'local' ? 'Search the checkouts on this machine' : 'Search your repositories, or type owner/name';
    refreshBtn.title = source === 'local' ? 'Look in the workspace folder again' : 'Ask GitHub for the list again';
    if (!built) {
      built = true;
      addEl.replaceChildren(
        addTitle,
        tabsEl,
        h('div.repo-search', {}, input, refreshBtn),
        listEl,
        pathEl,
        statusEl,
        dirEl,
      );
    }
    if (source === 'local') return renderLocal();
    pathAdd.toggleAttribute('disabled', true);
    input.disabled = !!adding;
    const r = store.repos;
    const q = filter.trim().toLowerCase();
    const typed = normalizeRepo(filter);
    const matches = r.list.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.description ?? '').toLowerCase().includes(q));
    const rows: HTMLElement[] = [];
    // owner/name that isn't in the list (someone else's public repository): offer it anyway.
    if (typed && !r.list.some((x) => sameRepo(x.name, typed))) rows.push(repoRow({ name: typed, private: false, description: 'Not in your list — the office will try to clone it' }));
    rows.push(...matches.slice(0, SHOWN).map(repoRow));
    if (!rows.length) rows.push(h('p.empty', { style: 'padding:10px' }, r.loading ? 'Asking GitHub for your repositories…' : r.error ? '' : q ? 'Nothing matches. Type owner/name to clone any repository.' : 'No repositories.'));
    if (matches.length > SHOWN) rows.push(h('p.empty', { style: 'padding:8px 10px' }, `…and ${matches.length - SHOWN} more — type to narrow it down`));
    listEl.replaceChildren(...rows);
    const pick = choice();
    const dest = pick ? `${store.projectsDir.dir}/${pick}` : `${store.projectsDir.dir}/<owner>/<repo>`;
    const change = store.me.admin ? h('button.btn.dir-change', { type: 'button', title: 'Clone new projects into another folder on the office’s machine' }, '📁 Change folder') : null;
    change?.addEventListener('click', () => editDir(true));
    statusEl.replaceChildren(
      adding
        ? h('p.note.busy', {}, `⏳ Cloning ${adding} into ${store.projectsDir.dir}/${adding}… A big repository can take a minute.`)
        : to
          ? h('p.note', {}, `Cloned into ${dest} with this machine's gh login (or used where it is, if it's there already), then added to ${to.name}.`, change)
          : h('p.note', {}, `Cloned into ${dest} with this machine's gh login. Everything on the new floor works in that checkout.`, change),
      ...[r.error, error].filter(Boolean).map((e) => h('p.err', {}, e)),
    );
    addBtn.disabled = !!adding || !pick || !!floorWithRepo(pick);
    addBtn.textContent = adding ? '⏳ Cloning…' : pick ? (to ? `🗂️ Add ${pick} to ${to.name}` : `🛗 Add ${pick}`) : to ? `🗂️ Add to ${to.name}` : '🛗 Add floor';
  };

  const add = (repo: string) => {
    if (adding) return;
    adding = repo;
    error = '';
    renderAdd();
    const to = linkFloor();
    net.send(to ? { t: 'floor.link', floor: to.id, target: repo } : { t: 'floor.add', repo });
  };

  /** Makes a floor of a checkout on this machine (or adds it to linkTo's); `dir` is as typed ('~' and all), which the answer names again. */
  const addLocal = (dir: string) => {
    if (adding || !dir.trim()) return;
    adding = dir;
    error = '';
    renderAdd();
    const to = linkFloor();
    net.send(to ? { t: 'floor.link', floor: to.id, target: dir } : { t: 'floor.addLocal', dir });
  };

  const onAdded = (msg: Extract<ServerMsg, { t: 'floor.added' }>) => {
    if (!adding || msg.repo !== adding) return;
    adding = null;
    if (msg.error || !msg.floor) {
      error = msg.error ?? 'The floor could not be added';
      renderAdd();
      return;
    }
    modal.close();
    opts.ride(msg.floor);
  };
  addedWaiters.add(onAdded);

  const onLinked = (msg: Extract<ServerMsg, { t: 'floor.linked' }>) => {
    if (!adding || msg.target !== adding || msg.floor !== linkTo) return;
    adding = null;
    if (msg.error || !msg.link) {
      error = msg.error ?? 'The repository could not be added';
      renderAdd();
      return;
    }
    // There now, under its floor: the panel goes back to adding floors, and the lists say where it is.
    linkTo = null;
    store.local = { ...store.local, at: 0 };
    selected = null;
    selectedDir = null;
    pathInput.value = '';
    showAdd = false;
    built = false;
    renderFloors();
    renderAdd();
  };
  linkedWaiters.add(onLinked);
  notLinking.addEventListener('click', () => {
    if (adding) return;
    linkTo = null;
    error = '';
    renderFloors();
    renderAdd();
  });

  const pickSource = (to: 'local' | 'github') => {
    if (source === to || adding) return;
    source = to;
    error = '';
    if (to === 'local') needLocal();
    else needRepos();
    renderAdd();
    input.focus();
  };
  localTab.addEventListener('click', () => pickSource('local'));
  githubTab.addEventListener('click', () => pickSource('github'));
  pathInput.addEventListener('input', () => renderAdd());
  pathInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    addLocal(pathInput.value.trim());
  });
  pathAdd.addEventListener('click', () => addLocal(pathInput.value.trim()));

  input.addEventListener('input', () => {
    filter = input.value;
    // Typing something else drops the row that was picked, unless it's still what's typed.
    if (selected && !sameRepo(selected, normalizeRepo(filter))) selected = null;
    renderAdd();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const q = filter.trim().toLowerCase();
    if (source === 'local') {
      const open = store.local.list.filter((c) => !c.floored && !c.on && (c.name.toLowerCase().includes(q) || c.shown.toLowerCase().includes(q)));
      const pick = localPick() ?? (q && open.length === 1 ? open[0] : undefined);
      if (pick) addLocal(pick.dir);
      return;
    }
    const matches = store.repos.list.filter((x) => !floorWithRepo(x.name) && (x.name.toLowerCase().includes(q) || (x.description ?? '').toLowerCase().includes(q)));
    const pick = choice() ?? (q && matches.length === 1 ? matches[0].name : undefined);
    if (pick) add(pick);
  });
  addBtn.addEventListener('click', () => {
    if (source === 'local') {
      const pick = localPick();
      if (pick) addLocal(pick.dir);
      return;
    }
    const pick = choice();
    if (pick) add(pick);
  });
  refreshBtn.addEventListener('click', () => {
    if (source === 'local') {
      store.local = { ...store.local, loading: true, error: undefined };
      renderAdd();
      net.send({ t: 'floor.local' });
      return;
    }
    store.repos = { ...store.repos, loading: true, error: undefined };
    renderAdd();
    net.send({ t: 'floor.repos', refresh: true });
  });

  const intro = setup
    ? h(
        'p.intro',
        {},
        store.floors.length
          ? 'Every project is a floor of this building. Pick a floor to ride to, or add another project.'
          : "Every project is a floor of this building, and it doesn't have any yet. Pick a checkout on this machine, or one of your repositories for the office to clone: it becomes the first floor.",
      )
    : null;
  const el = h(
    'div.modal.elevator',
    { role: 'dialog', 'aria-label': 'Elevator' },
    h('header', {}, h('h2', {}, setup ? '🏢 Welcome to Agent Office' : '🛗 Elevator'), close),
    h('div.body', {}, intro, floorsEl, addEl),
    h('footer', {}, h('span.grow', {}, setup ? 'Your office, one floor per project · Esc to look around first' : 'Pick a floor · Esc to stay here'), addBtn),
  );
  const unsubs = [store.on('floors', () => (renderFloors(), renderAdd())), store.on('repos', renderAdd), store.on('local', renderAdd), store.on('projectsDir', () => {
      editDir(false);
      // Somewhere else to look for checkouts now.
      store.local = { ...store.local, at: 0 };
      if (showAdd && source === 'local') needLocal();
      renderAdd();
    }), store.on('floor', renderFloors), store.on('peers', renderFloors), store.on('me', () => (renderFloors(), renderAdd()))];
  const modal = openModal(el, {
    doing: '🛗 at the elevator',
    // A stray click shouldn't lose the first-run panel; ✕ and Esc still close it.
    backdropCloses: !setup,
    onClose: () => {
      current = null;
      addedWaiters.delete(onAdded);
      linkedWaiters.delete(onLinked);
      for (const off of unsubs) off();
    },
  });
  current = modal;
  close.addEventListener('click', () => modal.close());
  renderFloors();
  if (showAdd) {
    if (source === 'local') needLocal();
    else needRepos();
  }
  renderAdd();
  if (showAdd) setTimeout(() => input.focus(), 30);
}
