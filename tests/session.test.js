import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { createRuntime } from '../server/index.js';
import { startFixtureRuntime, playerProgress, webmBytes } from './helpers.js';

async function setupThree(t, options = {}) {
  const host = await startFixtureRuntime(t, options);
  const selected = await host.select();
  const players = await Promise.all(['Melvi', 'Mahito', 'Senya'].map((nickname) => host.join(selected.session, nickname)));
  for (const [character, player] of [['Alice', players[0]], ['Narrator', players[0]], ['Bob', players[1]], ['Cara', players[2]]]) {
    const result = await host.admin('/api/admin/assign', { character, playerId: player.id });
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
  const started = await host.admin('/api/admin/start', {});
  assert.equal(started.status, 200, JSON.stringify(started.data));
  return { ...host, players };
}

async function uploadAccepted(host, player, lineId) {
  const uploaded = await host.upload(player, lineId);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  const candidate = uploaded.data.session.lineTakes[lineId];
  assert.equal(candidate.status, 'recorded');
  const accepted = await host.accept(player, lineId, candidate.id);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.session.lineTakes[lineId].status, 'accepted');
  return accepted.data;
}

async function finish(host) {
  const assignments = { '01_alice': 0, '04_alice': 0, '07_narrator': 0, '02_bob': 1, '05_bob': 1, '03_cara': 2, '06_cara': 2 };
  await Promise.all(Object.entries(assignments).map(([id, index]) => uploadAccepted(host, host.players[index], id)));
  return (await host.admin('/api/state')).data;
}

test('three players upload shuffled independent queues concurrently, then final playback uses source timestamps', async (t) => {
  const host = await setupThree(t);
  const [melvi, mahito, senya] = host.players;
  const ownState = await host.request('/api/state', { token: melvi.token });
  assert.deepEqual(ownState.data.queue.lines, ['01_alice', '04_alice', '07_narrator']);
  assert.deepEqual(new Set(ownState.data.queue.assignedCharacters), new Set(['Alice', 'Narrator']));
  assert.equal(ownState.data.session.joinToken, undefined);
  assert.equal(Object.hasOwn(ownState.data.session, 'currentLineId'), false);

  // A later Alice line is accepted while other players are recording earlier
  // lines. These requests intentionally have no ordering dependency.
  await Promise.all([
    uploadAccepted(host, melvi, '04_alice'),
    uploadAccepted(host, mahito, '02_bob'),
    uploadAccepted(host, senya, '03_cara'),
  ]);
  const partial = (await host.admin('/api/state')).data;
  assert.equal(partial.session.completedLineCount, 3);
  assert.equal(playerProgress(partial, melvi.id).completedLines, 1);
  assert.equal(playerProgress(partial, mahito.id).completedLines, 1);
  assert.equal(playerProgress(partial, senya.id).completedLines, 1);
  assert.equal(playerProgress(partial, melvi.id).pendingLines, 2);
  assert.equal(playerProgress(partial, melvi.id).currentQueueIndex, 0);

  await Promise.all([
    uploadAccepted(host, senya, '06_cara'),
    uploadAccepted(host, melvi, '01_alice'),
    uploadAccepted(host, mahito, '05_bob'),
    uploadAccepted(host, melvi, '07_narrator'),
  ]);
  const complete = (await host.admin('/api/state')).data;
  assert.equal(complete.session.state, 'review');
  assert.equal(complete.session.completedLineCount, 7);
  assert.equal(playerProgress(complete, melvi.id).completedLines, 3);
  assert.equal(playerProgress(complete, mahito.id).completedLines, 2);
  assert.equal(playerProgress(complete, senya.id).completedLines, 2);
  assert.equal(complete.session.lineTakes['03_cara'].startTime, 0.3);
  assert.equal(complete.session.lineTakes['04_alice'].startTime, 1);
  assert.equal(complete.session.lineTakes['04_alice'].playerId, melvi.id);
  assert.equal(complete.session.lineTakes['04_alice'].character, 'Alice');

  const playback = await host.admin('/api/admin/playback', { allowMissing: false });
  assert.equal(playback.status, 200);
  assert.equal(playback.data.session.state, 'playback');
  assert.ok(playback.data.session.playback.startsAt >= Date.now() - 1000);
  assert.ok(playback.data.session.playback.id);
  const audio = await fetch(host.base + complete.session.lineTakes['04_alice'].url, { headers: { Authorization: `Bearer ${senya.token}` } });
  assert.equal(audio.status, 200);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), webmBytes);
});

test('ownership, retakes, and reassignment preserve accepted takes and remove stale candidates', async (t) => {
  const host = await setupThree(t);
  const [melvi, mahito] = host.players;
  const wrongOwner = await host.upload(melvi, '02_bob');
  assert.equal(wrongOwner.status, 403);
  const accepted = await uploadAccepted(host, mahito, '02_bob');
  const acceptedId = accepted.session.lineTakes['02_bob'].id;
  const candidate = await host.upload(mahito, '05_bob');
  assert.equal(candidate.status, 200);
  const staleId = candidate.data.session.lineTakes['05_bob'].id;

  const reassigned = await host.admin('/api/admin/assign', { character: 'Bob', playerId: melvi.id });
  assert.equal(reassigned.status, 200);
  assert.equal(reassigned.data.session.lineTakes['02_bob'].id, acceptedId);
  assert.equal(reassigned.data.session.lineTakes['02_bob'].playerId, mahito.id);
  assert.equal(reassigned.data.session.lineTakes['05_bob'], undefined);
  await access(path.join(host.dataDir, 'takes', acceptedId + '.media'));
  await assert.rejects(access(path.join(host.dataDir, 'takes', staleId + '.media')), { code: 'ENOENT' });
  assert.equal((await host.upload(mahito, '05_bob')).status, 403);
  assert.ok([403, 404, 409].includes((await host.accept(mahito, '05_bob', staleId)).status));
  const moved = await host.request('/api/state', { token: melvi.token });
  assert.deepEqual(moved.data.queue.lines, ['01_alice', '02_bob', '04_alice', '05_bob', '07_narrator']);
  assert.ok(moved.data.queue.completedLines.includes('02_bob'));
  assert.ok(moved.data.queue.pendingLines.includes('05_bob'));

  const newTake = await uploadAccepted(host, melvi, '05_bob');
  const beforeRetake = newTake.session.completedLineCount;
  const retake = await host.admin('/api/admin/retake', { lineId: '02_bob' });
  assert.equal(retake.status, 200);
  assert.equal(retake.data.session.completedLineCount, beforeRetake - 1);
  assert.equal(retake.data.session.lineTakes['02_bob'], undefined);
  await assert.rejects(access(path.join(host.dataDir, 'takes', acceptedId + '.media')), { code: 'ENOENT' });
  const reRecorded = await uploadAccepted(host, melvi, '02_bob');
  assert.equal(reRecorded.session.lineTakes['02_bob'].playerId, melvi.id);
  assert.notEqual(reRecorded.session.lineTakes['02_bob'].id, acceptedId);
});

test('candidate acceptance checks take identity and host may accept a reviewed candidate', async (t) => {
  const host = await setupThree(t);
  const player = host.players[0];
  const first = await host.upload(player, '01_alice');
  const firstId = first.data.session.lineTakes['01_alice'].id;
  const second = await host.upload(player, '01_alice');
  assert.equal(second.status, 200);
  const secondId = second.data.session.lineTakes['01_alice'].id;
  assert.notEqual(firstId, secondId);
  await assert.rejects(access(path.join(host.dataDir, 'takes', firstId + '.media')), { code: 'ENOENT' });
  assert.ok([400, 404, 409].includes((await host.accept(player, '01_alice', firstId)).status));
  const state = (await host.admin('/api/state')).data;
  assert.equal(state.session.lineTakes['01_alice'].id, secondId);
  assert.equal(state.session.completedLineCount, 0);
  const accepted = await host.admin('/api/admin/accept', { lineId: '01_alice' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.session.completedLineCount, 1);
});

test('start requires assignments and playback requires accepted takes unless host explicitly allows missing lines', async (t) => {
  const host = await startFixtureRuntime(t);
  const selected = await host.select();
  const player = await host.join(selected.session, 'Only player');
  assert.ok([400, 409].includes((await host.admin('/api/admin/start', {})).status));
  const distributed = await host.admin('/api/admin/distribute', {});
  assert.equal(distributed.status, 200);
  assert.equal(Object.keys(distributed.data.session.roleAssignments).length, 4);
  assert.ok(Object.values(distributed.data.session.roleAssignments).every((id) => id === player.id));
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  const pendingCandidate = await host.upload(player, '01_alice');
  assert.equal(pendingCandidate.status, 200);
  assert.equal(pendingCandidate.data.session.completedLineCount, 0);
  assert.ok([400, 409].includes((await host.admin('/api/admin/playback', { allowMissing: false })).status));
  const forced = await host.admin('/api/admin/playback', { allowMissing: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.data.session.state, 'playback');
  const stopped = await host.admin('/api/admin/stop-playback', {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.session.state, 'recording');
});

test('more than eight players can join and character distribution works with extra players', async (t) => {
  const host = await startFixtureRuntime(t);
  const selected = await host.select();
  const players = await Promise.all(Array.from({ length: 12 }, (_, index) => host.join(selected.session, `Player ${index + 1}`)));
  assert.equal(new Set(players.map((player) => player.id)).size, 12);
  const assigned = await host.admin('/api/admin/distribute', {});
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.session.players.length, 12);
  assert.equal(Object.keys(assigned.data.session.roleAssignments).length, 4);
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
});

test('server restart starts a fresh room and deletes the previous session takes', async (t) => {
  const host = await setupThree(t);
  const complete = await finish(host);
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 200);
  const oldSessionId = complete.session.id;
  const takeId = complete.session.lineTakes['03_cara'].id;
  await host.stop();
  const restarted = await createRuntime(host.runtimeOptions);
  const address = await restarted.start();
  t.after(() => restarted.close());
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${host.adminToken}` } });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.revision, 0);
  assert.notEqual(state.session.id, oldSessionId);
  assert.equal(state.session.pack, null);
  assert.equal(state.session.players.length, 0);
  assert.deepEqual(state.session.roleAssignments, {});
  assert.deepEqual(state.session.lineTakes, {});
  assert.equal(state.session.completedLineCount, 0);
  assert.equal(state.session.state, 'lobby');
  assert.equal(state.session.playback, null);
  assert.deepEqual(await readdir(path.join(host.dataDir, 'takes')), []);
  await assert.rejects(access(path.join(host.dataDir, 'takes', takeId + '.media')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(host.dataDir, 'session.json')), { code: 'ENOENT' });
});

test('WebSocket reconnect yields authoritative personal state and disconnect leaves tasks pending', async (t) => {
  const host = await setupThree(t);
  const player = host.players[0];
  const socket = new WebSocket(host.base.replace('http:', 'ws:') + '/ws?viewer=player', { headers: { Cookie: player.cookie } });
  t.after(() => socket.close());
  const snapshot = await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
  assert.equal(snapshot.type, 'state');
  assert.equal(snapshot.viewer.playerId, player.id);
  assert.deepEqual(snapshot.queue.pendingLines, ['01_alice', '04_alice', '07_narrator']);
  assert.equal(snapshot.session.joinToken, undefined);
  assert.ok(!JSON.stringify(snapshot).includes(host.root));
  const pongPromise = new Promise((resolve, reject) => {
    socket.once('error', reject);
    const listener = (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'pong') { socket.off('message', listener); resolve(message); }
    };
    socket.on('message', listener);
  });
  socket.send(JSON.stringify({ type: 'ping' }));
  assert.equal((await pongPromise).type, 'pong');
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.close();
  await closed;
  const state = await host.request('/api/state', { token: player.token });
  assert.equal(state.data.session.roleAssignments.Alice, player.id);
  assert.equal(state.data.session.players.find((entry) => entry.id === player.id).connected, false);
  assert.equal(state.data.queue.pendingLines.length, 3);
  await uploadAccepted(host, player, '01_alice'); // HTTP recording works without a live socket.
});
