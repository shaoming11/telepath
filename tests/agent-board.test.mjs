import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addClaim, expandScopes, removeClaim, scopesOverlap, updateBoard } from '../scripts/agent-board.mjs';

function claim(id, owner, ...scopes) {
  return { id, owner, agent: owner + '-ui', branch: owner + '/ui', thread: 'https://github.com/fireheartjerry/telepathy/discussions/1',
    scopes, paths: expandScopes(scopes) };
}

test('claims compare directories, files, case, and separate screens', () => {
  const phone = claim('a', 'sam', '@phone-ui');
  const stage = claim('b', 'lee', '@stage-ui');
  assert.equal(addClaim([phone], stage).length, 2);
  assert.throws(() => addClaim([phone], claim('c', 'lee', 'PUBLIC/PHONE.CSS')), /@sam.*sam-ui/);
  assert.throws(() => addClaim([stage], claim('d', 'sam', 'public/')), /@lee.*lee-ui/);
  assert.throws(() => addClaim([stage], claim('e', 'sam', '@ui')), /@lee/);
  assert.equal(scopesOverlap('public/phone.css', 'public/phone-data.mjs'), false);
  assert.throws(() => expandScopes(['../secrets']), /repo-relative/);
});

test('a stale writer rereads and rejects a newly claimed overlapping UI scope', () => {
  const winner = claim('a', 'sam', '@phone-ui');
  let board = { sha: 'before', revision: 0, claims: [] };
  const api = {
    read: () => board,
    write: () => {
      board = { sha: 'after', revision: 1, claims: [winner] };
      return false;
    },
  };
  assert.throws(() => updateBoard(api, claims => addClaim(claims, claim('b', 'lee', 'public/phone.css'))),
    /Scope already claimed by @sam/);
  assert.deepEqual(board.claims, [winner]);
});

test('a stale writer retains another account’s disjoint claim after retrying', () => {
  const winner = claim('a', 'sam', '@phone-ui');
  const next = claim('b', 'lee', '@stage-ui');
  let board = { sha: 'before', revision: 0, claims: [] };
  const api = {
    read: () => board,
    write: (sha, updated) => {
      if (sha === 'before') {
        board = { sha: 'after', revision: 1, claims: [winner] };
        return false;
      }
      assert.equal(sha, 'after');
      board = { sha: 'latest', ...updated };
      return true;
    },
  };
  const result = updateBoard(api, claims => addClaim(claims, next));
  assert.deepEqual(result, { revision: 2, claims: [winner, next] });
});

test('only the account that claimed work can release it through the board tool', () => {
  const phone = claim('a', 'sam', '@phone-ui');
  assert.throws(() => removeClaim([phone], 'a', 'lee'), /Ask @sam/);
  assert.deepEqual(removeClaim([phone], 'a', 'SAM'), []);
});
