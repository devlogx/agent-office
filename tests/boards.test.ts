import test from 'node:test';
import assert from 'node:assert/strict';
import { batched, gatherBoards } from '../src/server/floor.js';
import { landedWorkers } from '../src/server/leave-on-merge.js';
import { repoKey, splitRepoKey } from '../src/shared/floors.js';
import { workerPr } from '../src/shared/status.js';
import type { GhIssue, GhPull, GhState, WorkerInfo } from '../src/shared/protocol.js';

// A floor with more than one repository (see FloorLink): its boards show every repository's issues and
// pull requests, each saying which it's in, and a worker's PR is only ever its own repository's.

const issue = (number: number, title: string): GhIssue => ({ number, title, state: 'OPEN', url: '', author: '', labels: [], assignees: [], createdAt: '', updatedAt: '', body: '', comments: 0 });
const pull = (number: number, state: string, headRefName: string, checkout?: string): GhPull => ({
  number, title: `PR ${number}`, state, isDraft: false, url: '', author: '', labels: [], reviewDecision: '',
  headRefName, baseRefName: 'main', createdAt: '', updatedAt: '', additions: 0, deletions: 0, checks: 'none', body: '', closes: [], checkout,
});
const state = <T>(items: T[], more: Partial<GhState<T>> = {}): GhState<T> => ({ items, fetchedAt: 100, loading: false, ...more });

function worker(id: string, more: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id, kind: 'agent', deskId: 'desk-1', name: id, color: '#fff', status: 'done', acked: false, createdBy: 'test', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [],
    worktree: { path: `.agent-office/worktrees/${id}`, branch: `office/${id}`, base: 'abc' },
    ...more,
  };
}

test("a floor with just its own repository shows that repository's list as it came", () => {
  const own = state([issue(1, 'one')]);
  assert.equal(gatherBoards([{ label: 'acme/feyer', state: own }]), own);
});

test("a floor's repositories' lists are one on its boards, each item labelled with its repository", () => {
  const all = gatherBoards([
    { label: 'acme/feyer', state: state([issue(1, 'feyer one'), issue(2, 'feyer two')]) },
    { checkout: 'feyer-app', label: 'acme/feyer-app', state: state([issue(1, 'app one')], { fetchedAt: 50, loading: true }) },
  ]);
  assert.deepEqual(all.items.map((i) => [i.number, i.title, i.repo, i.checkout]), [
    [1, 'feyer one', 'acme/feyer', undefined],
    [2, 'feyer two', 'acme/feyer', undefined],
    [1, 'app one', 'acme/feyer-app', 'feyer-app'],
  ]);
  assert.equal(all.loading, true, 'still loading while any of them is');
  assert.equal(all.fetchedAt, 50, 'as old as the oldest');
  assert.equal(all.error, undefined);

  // One that can't be read says whose it is, and the others still show.
  const broken = gatherBoards([
    { label: 'acme/feyer', state: state([issue(1, 'feyer one')]) },
    { checkout: 'feyer-app', label: 'feyer-app', state: state<GhIssue>([], { error: 'no GitHub remote' }) },
  ]);
  assert.equal(broken.error, 'feyer-app: no GitHub remote');
  assert.deepEqual(broken.items.map((i) => i.title), ['feyer one']);
});

test("a worker's pull request is its own repository's, though another one on the floor has the same number", () => {
  const pulls = [pull(7, 'MERGED', 'fix-x'), pull(7, 'OPEN', 'office/cody', 'feyer-app')];
  // Hired in feyer-app: its #7 is still open there.
  assert.deepEqual(workerPr(worker('cody', { checkout: 'feyer-app', pr: { number: 7, url: '' } }), pulls, []), { state: 'open', number: 7 });
  // Hired in the floor's own checkout: its #7 is the merged one.
  assert.deepEqual(workerPr(worker('pip', { pr: { number: 7, url: '' } }), pulls, []), { state: 'merged', number: 7 });
});

test('a worker across repositories that has one of its own floor’s linked checkouts goes home once that one merged too', () => {
  const w = worker('cody', { repos: [{ floor: 'feyer', checkout: 'feyer-app', name: 'feyer-app', dir: '/p/feyer-app', path: '.agent-office/worktrees/cody/feyer-app', branch: 'office/cody', base: 'abc' }] });
  const own = [pull(3, 'MERGED', 'office/cody')];
  const lists: Record<string, GhPull[]> = { 'feyer:feyer-app': [pull(9, 'OPEN', 'office/cody', 'feyer-app')] };
  assert.deepEqual(landedWorkers([w], own, [], (key) => lists[key]), [], "feyer-app's is still open");
  lists['feyer:feyer-app'] = [pull(9, 'MERGED', 'office/cody', 'feyer-app')];
  const [landed] = landedWorkers([w], own, [], (key) => lists[key]);
  assert.deepEqual(landed.prs, ['cody #3', 'feyer-app #9']);
  assert.deepEqual(Object.keys(landed.heads ?? {}), ['feyer:feyer-app']);
});

test('a repoKey names a floor’s own checkout by its id, and a linked one after it', () => {
  assert.equal(repoKey({ floor: 'feyer' }), 'feyer');
  assert.equal(repoKey({ floor: 'feyer', checkout: 'feyer-app' }), 'feyer:feyer-app');
  assert.deepEqual(splitRepoKey('feyer'), { floor: 'feyer' });
  assert.deepEqual(splitRepoKey('feyer:feyer-app'), { floor: 'feyer', checkout: 'feyer-app' });
});

test("every board that changes in one go is told about once, a moment later, with each thing that changed", async () => {
  const flushed: Record<string, boolean | undefined>[] = [];
  const b = batched<{ issues?: boolean; pulls?: boolean; settled?: boolean }>((due) => flushed.push(due));
  // Three repositories' refreshes landing one after another.
  b.add({ issues: true });
  b.add({ pulls: true });
  b.add({ pulls: true, settled: true });
  assert.deepEqual(flushed, [], 'not yet');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(flushed, [{ issues: true, pulls: true, settled: true }]);

  // With a wait, each change puts it off again, so a burst of repositories is told about once.
  const later: Record<string, boolean | undefined>[] = [];
  const w = batched<{ issues?: boolean; pulls?: boolean }>((due) => later.push(due), 40);
  w.add({ issues: true });
  await new Promise((r) => setTimeout(r, 25));
  w.add({ pulls: true });
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(later, [], 'still waiting for the second one to settle');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(later, [{ issues: true, pulls: true }]);
  w.stop();
  b.add({ issues: true });
  b.stop();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(flushed.length, 1, 'nothing once stopped');
});
