import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeClient } from '../web/shared/api.js';

const snapshot = (serverId, revision, id, matchId) => ({
  type: 'state', serverId, revision, serverTime: Date.now(),
  session: { id, matchId },
});

test('client ignores late snapshots from previous matches and party replacements but accepts a restarted server', () => {
  const client = new RuntimeClient('admin');
  client.receive(snapshot('server-a', 8, 'party-current', 'match-two'));
  client.receive(snapshot('server-a', 7, 'party-current', 'match-one'));
  assert.equal(client.state.session.matchId, 'match-two');
  client.receive(snapshot('server-a', 6, 'party-replaced', null));
  assert.equal(client.state.session.id, 'party-current');
  client.receive(snapshot('server-b', 0, 'party-after-restart', null));
  assert.equal(client.state.session.id, 'party-after-restart');
});

test('a state broadcast wins over an older action response that completes afterward', async t => {
  const client = new RuntimeClient('admin');
  client.receive(snapshot('server-a', 10, 'party', 'match-one'));
  const originalFetch = globalThis.fetch;
  let resolveFetch; let requestOptions;
  globalThis.fetch = async (_url, options) => {
    requestOptions = options;
    return new Promise(resolve => { resolveFetch = resolve; });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const action = client.request('/api/admin/assign', { character: 'Alice', playerId: 'player' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(requestOptions.body).matchId, 'match-one');
  client.receive(snapshot('server-a', 12, 'party', 'match-two'));
  resolveFetch({ ok: true, json: async () => snapshot('server-a', 11, 'party', 'match-one') });
  await action;
  assert.equal(client.state.session.matchId, 'match-two');
});

test('state refreshes are coalesced and cannot overwrite a newer WebSocket broadcast', async t => {
  const client = new RuntimeClient('player');
  client.receive(snapshot('server-a', 4, 'party', 'match-a'));
  const originalFetch = globalThis.fetch;
  let completeFetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; return new Promise(resolve => { completeFetch = resolve; }); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const first = client.refresh();
  const second = client.refresh();
  assert.equal(calls, 1);
  assert.strictEqual(first, second);
  client.receive(snapshot('server-a', 6, 'party', 'match-b'));
  completeFetch({ ok: true, json: async () => snapshot('server-a', 5, 'party', 'match-a') });
  await Promise.all([first, second]);
  assert.equal(client.state.session.matchId, 'match-b');
  await new Promise(resolve => setImmediate(resolve));
  const third = client.refresh();
  assert.equal(calls, 2, 'completed refresh allows the next reconciliation');
  completeFetch({ ok: true, json: async () => snapshot('server-a', 7, 'party', 'match-c') });
  await third;
  assert.equal(client.state.session.matchId, 'match-c');
});
