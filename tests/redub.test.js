import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureRuntime, matchSettings, playerPost, fixtureLines } from './helpers.js';
import { REDUB_VOTE_LIMIT } from '../server/session/store.js';

async function startReview(t, { accept = true } = {}) {
  const host = await startFixtureRuntime(t);
  const { session } = await host.select();
  const ada = await host.join(session, 'Ada'); const bo = await host.join(session, 'Bo');
  await host.admin('/api/admin/settings', matchSettings());
  await host.admin('/api/admin/open-lobby', {});
  for (const [character, player] of [['Alice', ada], ['Narrator', ada], ['Bob', bo], ['Cara', bo]]) await host.admin('/api/admin/assign', { character, playerId: player.id });
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  const owner = { '01_alice': ada, '04_alice': ada, '07_narrator': ada, '02_bob': bo, '05_bob': bo, '03_cara': bo, '06_cara': bo };
  if (accept) for (const line of fixtureLines) {
    const up = await host.upload(owner[line.id], line.id);
    assert.equal((await host.accept(owner[line.id], line.id, up.data.session.lineTakes[line.id].id)).status, 200);
  }
  return { host, ada, bo, owner };
}
const vote = (host, player, lineId, on = true) => playerPost(host, player, '/api/player/redub-vote', { lineId, vote: on });

test('players ask to redub accepted clips and the host sees who asked, in order', async t => {
  const { host, ada, bo } = await startReview(t);
  assert.equal((await host.admin('/api/state')).data.session.state, 'review');
  assert.deepEqual((await host.admin('/api/state')).data.session.redubVotes, {});

  assert.equal((await vote(host, ada, '03_cara')).status, 200);
  assert.equal((await vote(host, bo, '03_cara')).status, 200);
  assert.equal((await vote(host, bo, '01_alice')).status, 200);
  assert.equal((await vote(host, bo, '01_alice')).status, 200, 'repeating the same vote is harmless');

  const admin = (await host.admin('/api/state')).data.session.redubVotes;
  assert.deepEqual(admin['03_cara'], { count: 2, voters: [ada.id, bo.id] });
  assert.deepEqual(admin['01_alice'], { count: 1, voters: [bo.id] });
  const asAda = (await host.request('/api/state', { token: ada.token })).data.session.redubVotes;
  assert.deepEqual(asAda['03_cara'], { count: 2, mine: true });
  assert.deepEqual(asAda['01_alice'], { count: 1, mine: false });
  assert.equal(JSON.stringify(asAda).includes(bo.id), false, 'players see counts, not who asked');

  const taken = await vote(host, bo, '03_cara', false);
  assert.deepEqual(taken.data.session.redubVotes['03_cara'], { count: 1, mine: false });
  await vote(host, ada, '03_cara', false);
  assert.equal((await host.admin('/api/state')).data.session.redubVotes['03_cara'], undefined, 'a clip without requests disappears from the table');
});

test('redub requests are limited to accepted clips, known lines and a handful per player', async t => {
  const { host, ada } = await startReview(t);
  assert.equal((await vote(host, ada, 'no_such_line')).status, 404);
  assert.equal((await playerPost(host, ada, '/api/player/redub-vote', { lineId: '01_alice', vote: 'yes' })).status, 400);
  assert.equal((await host.request('/api/player/redub-vote', { method: 'POST', token: host.adminToken, body: { lineId: '01_alice', vote: true, matchId: 'x' } })).status, 403, 'the host is not a voter');
  assert.equal((await host.request('/api/player/redub-vote', { method: 'POST', body: { lineId: '01_alice', vote: true, matchId: 'x' } })).status, 401);
  const ids = fixtureLines.map(line => line.id);
  for (const id of ids.slice(0, REDUB_VOTE_LIMIT)) assert.equal((await vote(host, ada, id)).status, 200);
  const over = await vote(host, ada, ids[REDUB_VOTE_LIMIT]);
  assert.equal(over.status, 409); assert.match(over.data.error, /at most/i);
  await vote(host, ada, ids[0], false);
  assert.equal((await vote(host, ada, ids[REDUB_VOTE_LIMIT])).status, 200, 'taking a request back frees a slot');
});

test('a clip that has no accepted take cannot be voted for, and voting closes with final playback', async t => {
  const { host, ada } = await startReview(t, { accept: false });
  assert.equal((await vote(host, ada, '01_alice')).status, 409);
  const done = await startReview(t);
  await vote(done.host, done.ada, '01_alice');
  assert.equal((await done.host.admin('/api/admin/playback', { allowMissing: false })).status, 200);
  assert.equal((await vote(done.host, done.ada, '02_bob')).status, 409, 'no requests during playback');
});

test('votes clear when the host asks for a retake or dismisses them, and when a replacement is accepted', async t => {
  const { host, ada, bo, owner } = await startReview(t);
  await vote(host, ada, '02_bob'); await vote(host, bo, '02_bob'); await vote(host, ada, '05_bob'); await vote(host, ada, '07_narrator');
  const dismissed = await host.admin('/api/admin/clear-redub', { lineId: '05_bob' });
  assert.equal(dismissed.data.session.redubVotes['05_bob'], undefined);
  assert.equal(dismissed.data.session.redubVotes['02_bob'].count, 2, 'other clips keep their requests');
  const retake = await host.admin('/api/admin/retake', { lineId: '02_bob' });
  assert.equal(retake.data.session.redubVotes['02_bob'], undefined, 'the clip is being redubbed: the requests are answered');
  assert.equal(retake.data.session.state, 'recording');
  assert.equal((await vote(host, ada, '02_bob')).status, 409, 'the clip has no accepted take until it is recorded again');
  assert.equal(retake.data.session.redubVotes['07_narrator'].count, 1);

  // A player retake answers the requests too (it needs recording to be open, which the host's retake reopened).
  const started = await playerPost(host, ada, '/api/takes/07_narrator/retake', {});
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const replacement = await host.upload(ada, '07_narrator', { retakeId: started.data.retakeId });
  const accepted = await host.accept(ada, '07_narrator', replacement.data.session.replacementTakes['07_narrator'].id, { retakeId: started.data.retakeId });
  assert.equal(accepted.status, 200);
  assert.equal((await host.admin('/api/state')).data.session.redubVotes['07_narrator'], undefined);
  const up = await host.upload(owner['02_bob'], '02_bob');
  await host.accept(owner['02_bob'], '02_bob', up.data.session.lineTakes['02_bob'].id);
  assert.equal((await host.admin('/api/admin/clear-redub', { lineId: 'nope' })).status, 404);
});

test('redub requests are not carried into the next match', async t => {
  const { host, ada } = await startReview(t);
  await vote(host, ada, '01_alice');
  await host.admin('/api/admin/playback', { allowMissing: false });
  await host.admin('/api/admin/next-match', {});
  assert.deepEqual((await host.admin('/api/state')).data.session.redubVotes, {});
});
