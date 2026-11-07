import test from 'node:test';
import assert from 'node:assert/strict';
import { rankClips, clipOrder, requestSummary } from '../web/shared/clips.js';
import { RuntimeClient } from '../web/shared/api.js';

const lines = ['a', 'b', 'c', 'd'].map(id => ({ id }));

test('clips with more redub requests rank first, ties keep the pack order', () => {
  assert.deepEqual(rankClips(lines).map(item => item.line.id), ['a', 'b', 'c', 'd'], 'no requests: pack order');
  const votes = { c: { count: 3, voters: ['x', 'y', 'z'] }, b: { count: 1, voters: ['x'] }, d: { count: 1, voters: ['y'] } };
  assert.deepEqual(rankClips(lines, votes).map(item => `${item.line.id}${item.count}`), ['c3', 'b1', 'd1', 'a0']);
  assert.deepEqual([...clipOrder(lines, votes)], [['c', 0], ['b', 1], ['d', 2], ['a', 3]]);
  const moved = { ...votes, a: { count: 4 } };
  assert.equal(rankClips(lines, moved)[0].line.id, 'a', 'a clip that gains requests moves to the top');
  assert.deepEqual(requestSummary(votes), { clips: 3, requests: 5 });
  assert.deepEqual(requestSummary(), { clips: 0, requests: 0 });
});

test('card deck routes are not match-scoped, but dealing and vetoing are', async t => {
  const client = new RuntimeClient('admin');
  client.receive({ type: 'state', serverId: 's', revision: 1, serverTime: Date.now(), session: { id: 'p', matchId: 'm1' } });
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { seen.push({ url, method: options.method, body: options.body && JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; };
  t.after(() => { globalThis.fetch = originalFetch; });
  await client.request('/api/admin/cards', { deckId: 'd', card: { title: 'x' } });
  await client.request('/api/admin/cards/batch', { format: 'text', content: 'x' });
  await client.request('/api/admin/decks', { name: 'x' });
  await client.request('/api/admin/cards/abc', { card: { text: 'y' } }, { method: 'PATCH' });
  await client.request('/api/admin/cards/deal', {});
  await client.request('/api/admin/cards/veto', { key: 'player:1' });
  await client.request('/api/player/redub-vote', { lineId: 'a', vote: true });
  assert.deepEqual(seen.map(item => item.body.matchId), [undefined, undefined, undefined, undefined, 'm1', 'm1', 'm1']);
  assert.equal(seen[3].method, 'PATCH');
});
