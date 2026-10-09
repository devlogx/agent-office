import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MergeWatch, closesOwn } from '../src/server/github.js';
import type { GhPull } from '../src/shared/protocol.js';

const pull = (number: number, state: string): GhPull => ({
  number, title: `PR ${number}`, state, isDraft: false, url: '', author: '', labels: [], reviewDecision: '',
  headRefName: `b${number}`, baseRefName: 'main', createdAt: '', updatedAt: '', additions: 0, deletions: 0,
  checks: 'none', body: '', closes: [],
});
const numbers = (ps: GhPull[]) => ps.map((p) => p.number);

test('a pull request that was open at the last look and is merged now rings once', () => {
  const w = new MergeWatch();
  assert.deepEqual(numbers(w.look([pull(1, 'OPEN'), pull(2, 'MERGED'), pull(3, 'OPEN')])), [], 'nothing rings on the first look');
  assert.deepEqual(numbers(w.look([pull(1, 'MERGED'), pull(2, 'MERGED'), pull(3, 'CLOSED')])), [1]);
  assert.deepEqual(numbers(w.look([pull(1, 'MERGED'), pull(2, 'MERGED')])), []);
});

test('a merge from the PR window rings right away, and not again when GitHub catches up', () => {
  const w = new MergeWatch();
  w.look([pull(5, 'OPEN'), pull(6, 'OPEN')]);
  assert.equal(w.ring(5), true);
  assert.equal(w.ring(5), false);
  // A look that started before the merge still says open; the next one says merged.
  assert.deepEqual(numbers(w.look([pull(5, 'OPEN'), pull(6, 'OPEN')])), []);
  assert.deepEqual(numbers(w.look([pull(5, 'MERGED'), pull(6, 'MERGED')])), [6]);
});

test("a pull request only closes its own repository's issues on the board, not another one's with the same number", () => {
  const ref = (number: number, owner: string, name: string) => ({ number, url: `https://github.com/${owner}/${name}/issues/${number}`, repository: { name, owner: { login: owner } } });
  const p = { url: 'https://github.com/acme/feyer/pull/3', closingIssuesReferences: [ref(12, 'acme', 'feyer'), ref(7, 'acme', 'feyer-app'), { number: 9, url: 'https://github.com/Acme/Feyer/issues/9' }] };
  assert.deepEqual(closesOwn(p), [12, 9]);
  assert.deepEqual(closesOwn({ url: '', closingIssuesReferences: [{ number: 4 }] }), [4], "nothing to tell by: the PR's own");
  assert.deepEqual(closesOwn({ url: 'https://github.com/acme/feyer/pull/3' }), []);
});
