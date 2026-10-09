import { MEETING_PATTERNS, MEETING_PATTERN_IDS, NO_MEETING_BUDGET, TOKENS_PER_SEAT, meetingBudgetLabel, meetingSpend, outputProblem, slugify } from '../../shared/meetings';
import { fmtTokens, type Meeting, type MeetingPattern, type MeetingTurn } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { meetingStage } from '../world/meeting';
import { h, openModal, timeAgo, toast, STATUS_LABEL, type Modal } from './dom';
import { checkoutPicker, confirmDialog, type CheckoutChoice } from './prompt';
import { providerPicker } from './provider';
import { officePrompt } from './prompts';
import { issueVars } from './boards';

/** What a meeting called from an issue, a PR or a task starts out with. */
export interface MeetingPreset {
  pattern?: MeetingPattern;
  prompt?: string;
  title?: string;
  pr?: number;
  issue?: number;
  /** The linked checkout `pr` or `issue` is in (see GhIssue.checkout); the meeting works there. */
  checkout?: string;
}

export interface MeetingActions {
  openTerminal(workerId: string): void;
  /** Push the meeting's branch and open a pull request for it, through the head of the table's worker. */
  openPr(workerId: string): void;
  /** On a floor with more than one repository: the checkouts a meeting can work in (see checkoutPicker). */
  checkouts(): CheckoutChoice[] | undefined;
}

/** A meeting about a GitHub issue, in the repository it's in (`checkout`, see GhIssue.checkout): the form filled in with it. */
export function issueMeeting(n: number, title: string, checkout?: string): MeetingPreset {
  return { issue: n, title: `#${n} ${title}`, prompt: officePrompt('issue.meeting', issueVars({ number: n, title })), checkout };
}

/** A linked checkout's name as the floor has it, or as the meeting remembers it (see Meeting.checkout). */
export function checkoutName(m: Pick<Meeting, 'checkout' | 'checkoutName'>): string | undefined {
  if (!m.checkout) return undefined;
  return store.currentFloor()?.links?.find((l) => l.id === m.checkout)?.name ?? m.checkoutName ?? m.checkout;
}

const CHECKOUT_KEY = 'agent-office.meeting-checkout';
/** The checkout the last meeting on this floor was called in, to start the next form with. */
function lastCheckout(): string {
  try {
    return localStorage.getItem(`${CHECKOUT_KEY}.${store.floor}`) ?? '';
  } catch {
    return '';
  }
}
function rememberCheckout(id: string) {
  try {
    localStorage.setItem(`${CHECKOUT_KEY}.${store.floor}`, id);
  } catch {
    // just a convenience
  }
}

const PART_LABEL: Record<MeetingTurn['state'], string> = { waiting: '⏳ up next', sent: '📨 handed over', working: '💬 on it', done: '✅ written' };

/**
 * The meeting room's window. With a meeting at the table it shows how it's going (and stops it, or
 * clears the table once it's over); otherwise, or with a preset from an issue or a PR, it's the form
 * that calls one.
 */
export function openMeeting(net: Net, actions: MeetingActions, preset?: MeetingPreset) {
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const title = h('h2', {}, '🤝 Meeting room');
  const body = h('div.body.meeting');
  const foot = h('footer');
  const el = h('div.modal.meeting-window', { role: 'dialog', 'aria-label': 'Meeting room' }, h('header', {}, title, close), body, foot);
  let view: 'status' | 'form' = preset || !store.meeting.current ? 'form' : 'status';
  let form: ReturnType<typeof meetingForm> | null = null;
  const render = () => {
    if (view === 'status' && store.meeting.current) {
      form = null;
      title.textContent = '🤝 Meeting room';
      renderStatus(store.meeting.current, body, foot, net, actions, () => {
        view = 'form';
        render();
      });
      return;
    }
    if (!form) {
      form = meetingForm(net, preset, actions.checkouts(), () => modal.close(), () => {
        view = 'status';
        render();
      });
      title.textContent = '🤝 Call a meeting';
      body.replaceChildren(form.body);
      foot.replaceChildren(...form.foot);
    }
    form.refresh();
  };
  const offs = [store.on('meeting', render), store.on('workers', () => view === 'status' && render()), store.on('pulls', () => form?.refresh())];
  const modal: Modal = openModal(el, { doing: '🤝 at the meeting room', onClose: () => offs.forEach((off) => off()) });
  close.addEventListener('click', () => modal.close());
  render();
}

function renderStatus(m: Meeting, body: HTMLElement, foot: HTMLElement, net: Net, actions: MeetingActions, callAnother: () => void) {
  const p = MEETING_PATTERNS[m.pattern];
  const running = m.status === 'running';
  const pill = h('span.pill', { class: running ? 'working' : m.status === 'done' ? 'done' : 'needs_input' }, running ? 'in a meeting' : m.status);
  const f = m.budget > NO_MEETING_BUDGET ? Math.min(1, m.tokens / m.budget) : 0;
  const seats = h(
    'ul.meeting-seats',
    {},
    ...m.seats.map((s, i) => {
      const w = s.workerId ? store.workers.get(s.workerId) : undefined;
      const t = m.turns.find((x) => x.seat === i);
      const part = running ? (t ? `${PART_LABEL[t.state]}: ${t.doing}` : '👂 listening') : '';
      return h(
        'li',
        {},
        h('span.dot', { style: `background:${w?.color ?? '#adb5bd'}` }),
        h('b', {}, s.role),
        h('span.muted', {}, `${i === 0 ? 'head of the table · ' : ''}${s.workerName ?? '…'}`),
        w ? h('span.pill', { class: w.status }, STATUS_LABEL[w.status]) : h('span.pill.exited', {}, 'gone home'),
        part ? h('span.meeting-part', { title: t?.file ?? '' }, part) : null,
        s.tokens ? h('span.muted', {}, `${fmtTokens(s.tokens)} tokens`) : null,
        w ? h('button.btn.small', { type: 'button', onclick: () => actions.openTerminal(w.id) }, '🖥️ Terminal') : null,
      );
    }),
  );
  const repo = checkoutName(m);
  const where = m.worktree ? h('span', {}, '🌿 ', h('code', {}, m.worktree.branch), m.commit ? ` · committed ${m.commit}` : '') : null;
  const review = m.review?.url ? h('a', { href: m.review.url, target: '_blank', rel: 'noopener noreferrer' }, `🔍 The review on PR #${m.pr} ↗`) : m.review?.error ? h('span.bad', {}, `Couldn't post the review: ${m.review.error}`) : null;
  body.replaceChildren(
    ...present(
    h('div.meeting-head', {}, pill, h('b', {}, `${p.icon} ${p.label}`), h('span.meeting-title', { title: m.prompt }, m.title), repo ? h('span.muted', { title: 'The repository it works in' }, `📁 ${repo}`) : null),
    m.stranded ? h('p.bad', {}, `⏸️ ${m.stranded}`) : null,
    h('p.meeting-line', {}, running ? `${meetingStage(m)} · called by ${m.calledBy} ${timeAgo(new Date(m.startedAt).toISOString())}` : m.status === 'done' ? `✅ Wrote ${m.output} in ${m.round} round${m.round === 1 ? '' : 's'}` : `⛔ Stopped in round ${m.round}: ${m.reason ?? 'stopped'}`),
    h('div.meeting-budget', { title: m.budget > NO_MEETING_BUDGET ? `${m.tokens.toLocaleString()} of ${m.budget.toLocaleString()} tokens` : `${m.tokens.toLocaleString()} tokens, no limit` }, h('div.meeting-bar', {}, h('i', { style: `width:${(f * 100).toFixed(1)}%;background:${f > 0.9 ? 'var(--bad)' : f > 0.7 ? 'var(--warn)' : 'var(--good)'}` })), h('span', {}, m.budget > NO_MEETING_BUDGET ? `${meetingSpend(m)} of ${fmtTokens(m.budget)} tokens` : `${meetingSpend(m)} · ${meetingBudgetLabel(m.budget)}`)),
    seats,
    h('div.meeting-out', {}, h('div.meeting-out-head', {}, h('b', {}, '📄 '), h('code', {}, m.output), where, review), h('pre.meeting-preview', {}, m.preview?.trim() ? m.preview : running ? 'Nothing written yet.' : 'Nothing was written.')),
    store.meeting.past.length
      ? h('details.meeting-past', {}, h('summary', {}, `Earlier meetings (${store.meeting.past.length})`), h('ul', {}, ...store.meeting.past.map((r) => h('li', { title: `Called by ${r.calledBy}` }, h('b', {}, r.title), r.checkout ? h('span.muted', {}, ` · 📁 ${r.checkout}`) : null, h('div.muted', {}, r.summary)))))
      : null,
    ),
  );
  const head = m.seats[0]?.workerId ? store.workers.get(m.seats[0].workerId) : undefined;
  foot.replaceChildren(
    ...present(
    h('span.grow', {}, running ? 'The workers stay at the table after it ends, so you can read their terminals.' : 'Clearing the room sends the workers home. A committed output stays on its branch.'),
    running ? h('button.btn', { type: 'button', onclick: () => confirmDialog('Stop the meeting?', `The workers stop where they are and stay at the table. ${m.output} is only there if it was written.`, 'Stop it', () => net.send({ t: 'meeting.stop' })) }, '⛔ Stop meeting') : null,
    !running && m.commit && head?.worktree ? h('button.btn', { type: 'button', title: `Push ${m.worktree?.branch} and open a pull request`, onclick: () => actions.openPr(head.id) }, head.pr ? `🔀 PR #${head.pr.number}` : '🔀 Open PR') : null,
    !running ? h('button.btn', { type: 'button', onclick: () => net.send({ t: 'meeting.clear' }) }, '🧹 Clear the room') : null,
    !running ? h('button.btn.primary', { type: 'button', onclick: callAnother }, '🤝 Call a meeting…') : null,
    ),
  );
}

const present = (...xs: (Node | null)[]): Node[] => xs.filter((x): x is Node => x !== null);

/** The form that calls a meeting: the pattern, what it's about, who sits down, the output, the bounds. */
function meetingForm(net: Net, preset: MeetingPreset | undefined, checkouts: CheckoutChoice[] | undefined, done: () => void, back: () => void) {
  let pattern: MeetingPattern = preset?.pattern ?? 'debate';
  let roles: string[] = [];
  let outputTouched = false;
  let budgetTouched = false;
  const patterns = h('div.meeting-patterns', { role: 'radiogroup', 'aria-label': 'Pattern' });
  const about = h('textarea', { rows: 4, placeholder: 'The question to settle, or the task to do: e.g. “Should the dog use A* or a navmesh?”', 'aria-label': 'What the meeting is about' }) as HTMLTextAreaElement;
  about.value = preset?.prompt ?? '';
  const titleIn = h('input', { type: 'text', placeholder: 'Title (optional): the first line otherwise', maxlength: 100, 'aria-label': 'Title' }) as HTMLInputElement;
  titleIn.value = preset?.title ?? '';
  const outputIn = h('input', { type: 'text', 'aria-label': 'Output file', spellcheck: 'false' }) as HTMLInputElement;
  const outputNote = h('small.muted');
  const prSel = h('select.provider-select', { 'aria-label': 'Pull request' }) as HTMLSelectElement;
  const prRow = h('div.meeting-field', {}, h('label', {}, 'Pull request'), prSel);
  const partsIn = h('textarea', { rows: 3, placeholder: 'src/server/\nsrc/client/\nsrc/shared/', 'aria-label': 'Parts', spellcheck: 'false' }) as HTMLTextAreaElement;
  const partsRow = h('div.meeting-field', {}, h('label', {}, 'Parts, one per line'), partsIn, h('small.muted', {}, 'Handed out to the mappers in turn: files, folders, modules or issues.'));
  const count = h('b');
  const minus = h('button.btn.small', { type: 'button', 'aria-label': 'Fewer workers' }, '−');
  const plus = h('button.btn.small', { type: 'button', 'aria-label': 'More workers' }, '+');
  const roleList = h('div.meeting-roles');
  const roundsIn = h('input', { type: 'number', 'aria-label': 'Rounds' }) as HTMLInputElement;
  const roundsNote = h('small.muted');
  const budgetIn = h('input', { type: 'number', min: 0, step: 250, 'aria-label': 'Token budget in thousands, 0 for no limit' }) as HTMLInputElement;
  const provider = providerPicker(store.project, 'meeting-provider', 'Workers');
  // On a floor with more than one repository: which one it works in, as from the issue or PR it's
  // about, else the one picked last time. Its worktree, workers, commit and PRs are that one's.
  const multi = (checkouts?.length ?? 0) > 1;
  const initial = !multi ? '' : preset && (preset.pr || preset.issue) ? (preset.checkout ?? '') : (preset?.checkout ?? lastCheckout());
  const checkout = checkoutPicker(checkouts, { element: null, value: () => [], exclude() {} }, initial);
  const branchHere = () => {
    const c = checkout.value();
    return c ? store.currentFloor()?.links?.find((l) => l.id === c)?.branch : store.project?.branch;
  };
  const busy = h('p.meeting-busy');
  const submit = h('button.btn.primary', { type: 'submit' }, '🤝 Start the meeting');
  const cancel = h('button.btn', { type: 'button', onclick: store.meeting.current ? back : done }, store.meeting.current ? '← Back' : 'Cancel');

  const def = () => MEETING_PATTERNS[pattern];
  const slug = () => slugify(titleIn.value.trim() || about.value.trim().split('\n')[0] || 'meeting', 32);
  const pr = () => Number(prSel.value) || undefined;
  const syncOutput = () => {
    if (!outputTouched) outputIn.value = def().output(slug(), pr());
    const problem = outputProblem(outputIn.value.trim());
    outputNote.textContent = problem ? `⚠️ ${problem}` : pattern === 'review' ? 'It ends when this file is written; the office then posts it on the PR as one review.' : branchHere() ? 'It ends when this file is written; the office commits it on the meeting’s own branch.' : 'It ends when this file is written.';
    outputNote.classList.toggle('bad', !!problem);
  };
  const syncBudget = () => {
    if (!budgetTouched) budgetIn.value = String((roles.length * TOKENS_PER_SEAT) / 1000);
  };
  const renderRoles = () => {
    const d = def();
    count.textContent = String(roles.length);
    minus.toggleAttribute('disabled', roles.length <= d.seats.min);
    plus.toggleAttribute('disabled', roles.length >= d.seats.max);
    roleList.replaceChildren(
      ...roles.map((r, i) => {
        const input = h('input', { type: 'text', value: r, maxlength: 40, 'aria-label': `Role ${i + 1}` }) as HTMLInputElement;
        input.addEventListener('input', () => (roles[i] = input.value));
        return h('div.meeting-role', {}, h('span.muted', {}, i === 0 ? '👑' : `${i + 1}`), input);
      }),
    );
    syncBudget();
  };
  const pickPattern = (p: MeetingPattern) => {
    pattern = p;
    const d = def();
    roles = d.roles.slice(0, d.seats.default);
    for (const b of patterns.children) b.classList.toggle('on', (b as HTMLElement).dataset.pattern === p);
    for (const b of patterns.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.pattern === p));
    roundsIn.min = String(d.rounds.min);
    roundsIn.max = String(d.rounds.max);
    roundsIn.value = String(d.rounds.default);
    roundsIn.disabled = d.rounds.min === d.rounds.max;
    roundsNote.textContent = d.roundsNote;
    prRow.classList.toggle('hidden', d.needs !== 'pr');
    partsRow.classList.toggle('hidden', d.needs !== 'parts');
    renderRoles();
    syncOutput();
  };
  for (const id of MEETING_PATTERN_IDS) {
    const d = MEETING_PATTERNS[id];
    patterns.append(h('button.meeting-pattern', { type: 'button', role: 'radio', 'data-pattern': id, onclick: () => pickPattern(id) }, h('b', {}, `${d.icon} ${d.label}`), h('small', {}, d.blurb)));
  }
  minus.addEventListener('click', () => {
    if (roles.length > def().seats.min) roles.pop();
    renderRoles();
  });
  plus.addEventListener('click', () => {
    if (roles.length < def().seats.max) roles.push(def().roles[roles.length] ?? `Worker ${roles.length + 1}`);
    renderRoles();
  });
  outputIn.addEventListener('input', () => {
    outputTouched = true;
    syncOutput();
  });
  budgetIn.addEventListener('input', () => (budgetTouched = true));
  titleIn.addEventListener('input', syncOutput);
  about.addEventListener('input', syncOutput);
  prSel.addEventListener('change', syncOutput);
  // Another repository: its own pull requests (numbers are only unique within one).
  checkout.element?.addEventListener('change', () => {
    prSel.value = '';
    refresh();
    syncOutput();
  });

  const bodyEl = h(
    'form.meeting-form',
    {},
    patterns,
    checkout.element ? h('div.meeting-field', {}, checkout.element) : null,
    h('div.meeting-field', {}, h('label', {}, 'What’s it about?'), about),
    h('div.meeting-field', {}, titleIn),
    prRow,
    partsRow,
    h('div.meeting-field', {}, h('label', {}, 'Output file'), outputIn, outputNote),
    h('div.meeting-field', {}, h('label.meeting-count', {}, 'Workers at the table', minus, count, plus), roleList),
    h('div.meeting-bounds', {}, h('div.meeting-field', {}, h('label', {}, 'Round limit'), roundsIn, roundsNote), h('div.meeting-field', {}, h('label', {}, 'Token budget (thousands)'), budgetIn, h('small.muted', {}, 'For everyone at the table together. Over it, the meeting stops. 0 = no limit: it runs until the file is written or the rounds are up.'))),
    provider.element,
    busy,
  ) as HTMLFormElement;
  bodyEl.noValidate = true;

  const send = () => {
    if (store.meeting.current?.status === 'running') return;
    const prompt = about.value.trim();
    if (!prompt) return about.focus();
    if (def().needs === 'pr' && !pr()) return prSel.focus();
    const parts = partsIn.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (def().needs === 'parts' && parts.length < roles.length - 1) {
      toast(`List at least ${roles.length - 1} parts, one per line, or seat fewer workers`, 'warn');
      return partsIn.focus();
    }
    const output = outputIn.value.trim();
    if (outputProblem(output)) return outputIn.focus();
    if (!provider.valid()) return;
    net.send({
      t: 'meeting.start',
      pattern,
      prompt,
      title: titleIn.value.trim() || undefined,
      output,
      roles: roles.map((r) => r.trim()),
      parts: def().needs === 'parts' ? parts : undefined,
      pr: def().needs === 'pr' ? pr() : undefined,
      issue: preset?.issue,
      rounds: Number(roundsIn.value) || undefined,
      // 0 is sent as 0 (no limit); only an empty field leaves the default to the office.
      budget: budgetIn.value.trim() === '' ? undefined : Math.max(0, Math.round((Number(budgetIn.value) || 0) * 1000)),
      provider: provider.value(),
      model: provider.model(),
      effort: provider.effort(),
      checkout: checkout.value(),
    });
    if (multi) rememberCheckout(checkout.value() ?? '');
    toast(`🤝 Calling the ${def().label} meeting: the workers are heading for the meeting room`);
    done();
  };
  bodyEl.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  submit.addEventListener('click', (e) => {
    e.preventDefault();
    send();
  });

  /** Keeps what depends on the board and the room up to date: the open PRs, and whether the room is free. */
  const refresh = () => {
    // The pull requests of the repository the meeting works in (see GhPull.checkout).
    const c = checkout.value();
    const open = store.pulls.items.filter((p) => p.state === 'OPEN' && p.checkout === c);
    // The preset's PR is in the repository it came from.
    const presetPr = preset?.pr && (preset.checkout || undefined) === c ? preset.pr : undefined;
    const want = prSel.value || (presetPr ? String(presetPr) : '');
    const opts: (readonly [string, string])[] = open.map((p) => [String(p.number), `#${p.number} ${p.title}`] as const);
    if (presetPr && !open.some((p) => p.number === presetPr)) opts.unshift([String(presetPr), `#${presetPr}`]);
    const key = JSON.stringify(opts);
    if (prSel.dataset.key !== key) {
      prSel.dataset.key = key;
      prSel.replaceChildren(h('option', { value: '' }, open.length || presetPr ? 'Pick a pull request…' : 'No open pull requests'), ...opts.map(([v, label]) => h('option', { value: v }, label.length > 70 ? `${label.slice(0, 69)}…` : label)));
      prSel.value = want;
      syncOutput();
    }
    const m = store.meeting.current;
    const taken = m?.status === 'running';
    busy.textContent = taken ? `The room is busy with “${m.title}” until it ends or someone stops it.` : m ? `Starting this sends the last meeting’s workers home.` : '';
    submit.toggleAttribute('disabled', taken);
  };
  pickPattern(pattern);
  if (preset?.pr) prSel.value = String(preset.pr);
  refresh();
  setTimeout(() => (preset?.prompt ? titleIn : about).focus(), 0);
  return { body: bodyEl, foot: [h('span.grow', {}, 'Few rounds and a file at the end: that’s what keeps meetings cheap.'), cancel, submit], refresh };
}
