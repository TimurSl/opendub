import test from 'node:test';
import assert from 'node:assert/strict';
import { rankPacks } from '../web/shared/clips.js';
import { RuntimeClient } from '../web/shared/api.js';

const packs = ['a', 'b', 'c', 'd'].map(id => ({ id }));

test('packs with more votes rank first, ties and unvoted packs keep their order', () => {
  assert.deepEqual(rankPacks(packs).map(item => item.pack.id), ['a', 'b', 'c', 'd'], 'no votes: original order');
  const votes = { c: { count: 3 }, b: { count: 1 }, d: { count: 1 } };
  assert.deepEqual(rankPacks(packs, votes).map(item => `${item.pack.id}${item.count}`), ['c3', 'b1', 'd1', 'a0']);
  assert.equal(rankPacks(packs, { ...votes, a: { count: 4 } })[0].pack.id, 'a', 'a pack that gains votes moves to the top');
  assert.deepEqual(rankPacks([]), []);
});

test('card deck routes and the pack vote are not match-scoped, but dealing and vetoing are', async t => {
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
  await client.request('/api/player/pack-vote', { packId: 'a', vote: true });
  await client.request('/api/admin/cards/deal', {});
  await client.request('/api/admin/cards/veto', { key: 'player:1' });
  await client.request('/api/player/open-line', { lineId: 'a' });
  assert.deepEqual(seen.map(item => item.body.matchId), [undefined, undefined, undefined, undefined, undefined, 'm1', 'm1', 'm1']);
  assert.equal(seen[3].method, 'PATCH');
});
