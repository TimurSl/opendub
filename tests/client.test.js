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
