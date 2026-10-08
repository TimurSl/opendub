import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import WebSocket from 'ws';
import { createRuntime } from '../server/index.js';
import { startFixtureRuntime, playerProgress, webmBytes, addFixturePack } from './helpers.js';

function waitSocketState(socket, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Timed out waiting for party state')); }, timeout);
    const receive = raw => {
      const state = JSON.parse(raw.toString());
      if (!predicate(state)) return;
      clearTimeout(timer); socket.off('message', receive); resolve(state);
    };
    socket.on('message', receive);
  });
}

function beginSlowUpload(host, player, matchId, lineId, retakeId = '') {
  const boundary = '----open-dub-slow-upload';
  const request = http.request(new URL(`/api/takes/${encodeURIComponent(lineId)}`, host.base), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${player.token}`,
      'X-Match-ID': matchId,
      ...(retakeId ? { 'X-Retake-ID': retakeId } : {}),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
  });
  const response = new Promise((resolve, reject) => {
    request.on('error', reject);
    request.on('response', result => {
      const chunks = [];
      result.on('data', chunk => chunks.push(chunk));
      result.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: result.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: result.statusCode, data: text }); }
      });
    });
  });
  request.write(`--${boundary}\r\nContent-Disposition: form-data; name="take"; filename="voice.webm"\r\nContent-Type: audio/webm\r\n\r\n`);
  request.write(webmBytes.subarray(0, 4));
  return {
    request, response,
    finish() { request.end(Buffer.concat([webmBytes.subarray(4), Buffer.from(`\r\n--${boundary}--\r\n`)])); },
  };
}

async function connectPlayer(host, player, t) {
  const socket = new WebSocket(host.base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: player.cookie } });
  t.after(() => { if (socket.readyState !== WebSocket.CLOSED) socket.close(); });
  await waitSocketState(socket, state => state.viewer?.playerId === player.id);
  return socket;
}

async function setGameMode(host, gameMode, overrides = {}) {
  return host.admin('/api/admin/settings', {
    gameMode,
    freeRolePicking: true, allowMultipleRoles: true, maxRolesPerPlayer: 0,
    autoBalanceSuggestions: true, lockRolesWhenReady: true,
    referencePlaybackEnabled: true, voiceEffectsEnabled: true, compactMobilePreferred: false,
    ...overrides,
  });
}

async function beginPlayerRetake(host, player, lineId, matchId) {
  return host.request(`/api/takes/${encodeURIComponent(lineId)}/retake`, {
    method: 'POST', token: player.token, body: { matchId },
  });
}

async function waitForAdminState(host, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await host.admin('/api/state');
    if (predicate(snapshot.data)) return snapshot.data;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for admin snapshot');
}

async function closePlayerSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.close();
  await closed;
}

async function setupThree(t, options = {}) {
  const host = await startFixtureRuntime(t, options);
  const selected = await host.select();
  const players = await Promise.all(['Melvi', 'Mahito', 'Senya'].map((nickname) => host.join(selected.session, nickname)));
  assert.equal((await host.admin('/api/admin/open-lobby', {})).status, 200);
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
  assert.equal((await host.admin('/api/admin/open-lobby', {})).status, 200);
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
  assert.equal(stopped.data.session.state, 'review');
  const resumed = await host.admin('/api/admin/start', {});
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.session.state, 'recording');
});

test('more than eight players can join and character distribution works with extra players', async (t) => {
  const host = await startFixtureRuntime(t);
  const selected = await host.select();
  const players = await Promise.all(Array.from({ length: 12 }, (_, index) => host.join(selected.session, `Player ${index + 1}`)));
  assert.equal(new Set(players.map((player) => player.id)).size, 12);
  assert.equal((await host.admin('/api/admin/open-lobby', {})).status, 200);
  const assigned = await host.admin('/api/admin/distribute', {});
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.session.players.length, 12);
  assert.equal(Object.keys(assigned.data.session.roleAssignments).length, 4);
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
});

test('player role picking handles competing claims, limits, readiness, and locked roles', async t => {
  const host = await startFixtureRuntime(t);
  const selected = await host.select(); const first = await host.join(selected.session, 'First'); const second = await host.join(selected.session, 'Second');
  const configured = await host.admin('/api/admin/settings', {
    gameMode: 'character',
    freeRolePicking: true, allowMultipleRoles: true, maxRolesPerPlayer: 1,
    autoBalanceSuggestions: true, lockRolesWhenReady: false,
    referencePlaybackEnabled: true, voiceEffectsEnabled: true, compactMobilePreferred: false,
  });
  assert.equal(configured.status, 200);
  assert.equal((await host.admin('/api/admin/open-lobby', {})).status, 200);
  const claim = (player, character) => host.request('/api/player/claim', {
    method: 'POST', token: player.token, body: { character, matchId: selected.session.matchId },
  });
  const competing = await Promise.all([claim(first, 'Alice'), claim(second, 'Alice')]);
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
  const owner = competing[0].status === 200 ? first : second;
  const other = owner === first ? second : first;
  assert.equal((await host.request('/api/player/ready', { method: 'POST', token: other.token, body: { ready: true, matchId: selected.session.matchId } })).status, 409);
  assert.equal((await claim(owner, 'Bob')).status, 409, 'a player cannot exceed their role limit');
  assert.equal((await host.request('/api/player/release', { method: 'POST', token: owner.token, body: { character: 'Alice', matchId: selected.session.matchId } })).status, 200);
  assert.equal((await claim(owner, 'Alice')).status, 200);
  assert.equal((await host.request('/api/player/ready', { method: 'POST', token: owner.token, body: { ready: true, matchId: selected.session.matchId } })).status, 200);
  const released = await host.request('/api/player/release', { method: 'POST', token: owner.token, body: { character: 'Alice', matchId: selected.session.matchId } });
  assert.equal(released.status, 200);
  assert.equal(released.data.session.readyPlayers[owner.id], undefined, 'changing a role clears readiness');

  for (const [character, player] of [['Alice', owner], ['Bob', owner], ['Cara', other], ['Narrator', other]]) {
    const assigned = await host.admin('/api/admin/assign', { character, playerId: player.id });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  }
  assert.equal((await host.admin('/api/admin/lock-roles', {})).status, 200);
  assert.equal((await host.request('/api/player/release', { method: 'POST', token: owner.token, body: { character: 'Bob', matchId: selected.session.matchId } })).status, 409);
});

test('host assignment mode prevents players from claiming or releasing roles', async t => {
  const host = await startFixtureRuntime(t); const selected = await host.select(); const player = await host.join(selected.session, 'Player');
  const configured = await host.admin('/api/admin/settings', {
    gameMode: 'character',
    freeRolePicking: false, allowMultipleRoles: true, maxRolesPerPlayer: 0,
    autoBalanceSuggestions: true, lockRolesWhenReady: true,
    referencePlaybackEnabled: true, voiceEffectsEnabled: true, compactMobilePreferred: false,
  });
  assert.equal(configured.status, 200);
  await host.admin('/api/admin/open-lobby', {});
  const body = { character: 'Alice', matchId: selected.session.matchId };
  assert.equal((await host.request('/api/player/claim', { method: 'POST', token: player.token, body })).status, 403);
  const assigned = await host.admin('/api/admin/assign', { character: 'Alice', playerId: player.id });
  assert.equal(assigned.status, 200);
  assert.equal((await host.request('/api/player/release', { method: 'POST', token: player.token, body })).status, 403);
});

test('game mode defaults to Character, locks when assignment opens, and persists until changed for a next match', async t => {
  const host = await startFixtureRuntime(t);
  const initial = await host.request('/api/state', { token: host.adminToken });
  assert.equal(initial.data.session.settings.gameMode, 'character');
  const selected = await host.select();
  const player = await host.join(selected.session, 'Mode tester');
  assert.equal(selected.session.settings.gameMode, 'character');
  assert.equal((await host.admin('/api/admin/deal-lines', {})).status, 409);
  assert.equal((await host.admin('/api/admin/assign-line', { lineId: '01_alice', playerId: player.id })).status, 409);

  const lineMode = await setGameMode(host, 'line');
  assert.equal(lineMode.status, 200, JSON.stringify(lineMode.data));
  assert.equal(lineMode.data.session.settings.gameMode, 'line');
  assert.equal((await host.admin('/api/admin/open-lobby', {})).status, 200);
  assert.equal((await setGameMode(host, 'character')).status, 409, 'assignment opening locks game mode for this match');
  assert.equal((await host.request('/api/player/ready', {
    method: 'POST', token: player.token, body: { ready: true, matchId: selected.session.matchId },
  })).status, 409, 'a player with no line assignments does not need or set microphone readiness');
  assert.equal((await host.admin('/api/admin/assign', { character: 'Alice', playerId: player.id })).status, 409);
  assert.equal((await host.admin('/api/admin/unassign', { character: 'Alice' })).status, 409);
  assert.equal((await host.admin('/api/admin/distribute', {})).status, 409);
  assert.equal((await host.admin('/api/admin/fill-unassigned', {})).status, 409);
  const playerRoleBody = { character: 'Alice', matchId: selected.session.matchId };
  assert.equal((await host.request('/api/player/claim', { method: 'POST', token: player.token, body: playerRoleBody })).status, 409);
  assert.equal((await host.request('/api/player/release', { method: 'POST', token: player.token, body: playerRoleBody })).status, 409);
  assert.ok([400, 409].includes((await host.admin('/api/admin/start', {})).status), 'recording waits for every line to have an owner');
  for (const line of selected.session.pack.lines) {
    const assigned = await host.admin('/api/admin/assign-line', { lineId: line.id, playerId: player.id });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  }
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  assert.equal((await host.admin('/api/admin/review', {})).status, 200);
  const nextMatch = await host.admin('/api/admin/next-match', {});
  assert.equal(nextMatch.status, 200);
  assert.equal(nextMatch.data.session.settings.gameMode, 'line', 'the selected mode survives the match reset');
  const changedAfterNextMatch = await setGameMode(host, 'character');
  assert.equal(changedAfterNextMatch.status, 200);
  const selectedAgain = await host.admin('/api/admin/select', { packId: selected.session.pack.id, partyId: selected.session.id });
  assert.equal(selectedAgain.status, 200);
  assert.equal(selectedAgain.data.session.settings.gameMode, 'character');
});

test('line dealing uses connected players, shuffles tasks evenly, and redeal clears readiness and unlocks assignment', async t => {
  const host = await startFixtureRuntime(t);
  const selected = await host.select();
  await setGameMode(host, 'line');
  await host.admin('/api/admin/open-lobby', {});
  assert.equal((await host.admin('/api/admin/deal-lines', {})).status, 409, 'dealing requires at least one live player connection');

  const first = await host.join(selected.session, 'First');
  const second = await host.join(selected.session, 'Second');
  const offline = await host.join(selected.session, 'Offline');
  const firstSocket = await connectPlayer(host, first, t);
  const secondSocket = await connectPlayer(host, second, t);
  assert.equal(firstSocket.readyState, WebSocket.OPEN);
  assert.equal(secondSocket.readyState, WebSocket.OPEN);
  const deal = await host.admin('/api/admin/deal-lines', {});
  assert.equal(deal.status, 200, JSON.stringify(deal.data));
  const firstAssignments = deal.data.session.lineAssignments;
  const firstCounts = [first, second].map(player => Object.values(firstAssignments).filter(owner => owner === player.id).length);
  assert.deepEqual([...firstCounts].sort((a, b) => a - b), [3, 4], 'seven tasks differ by at most one across two connected players');
  assert.ok(Object.values(firstAssignments).every(owner => owner === first.id || owner === second.id), 'players without a live connection receive no lines');
  assert.deepEqual((await host.request('/api/state', { token: offline.token })).data.queue.lines, []);
  const disconnected = await host.join(selected.session, 'Late joiner');
  assert.deepEqual((await host.request('/api/state', { token: disconnected.token })).data.queue.lines, [], 'a later join waits for a host deal');
  assert.equal((await host.request('/api/player/ready', {
    method: 'POST', token: disconnected.token, body: { ready: true, matchId: selected.session.matchId },
  })).status, 409);

  const expectedQueue = (assignments, player) => selected.session.pack.lines.filter(line => assignments[line.id] === player.id).map(line => line.id);
  for (const player of [first, second]) {
    const state = await host.request('/api/state', { token: player.token });
    assert.deepEqual(state.data.queue.lines, expectedQueue(firstAssignments, player), 'queues stay chronological after the shuffled deal');
    assert.deepEqual(state.data.queue.assignedCharacters, [], 'characters are informational for line owners');
    assert.equal((await host.request('/api/player/ready', { method: 'POST', token: player.token, body: { ready: true, matchId: selected.session.matchId } })).status, 200);
  }
  const locked = (await host.admin('/api/state')).data.session;
  assert.equal(locked.rolesLocked, true);
  assert.ok(Object.keys(locked.readyPlayers).length);

  const lateSocket = await connectPlayer(host, disconnected, t);
  assert.equal(lateSocket.readyState, WebSocket.OPEN);
  const redealt = await host.admin('/api/admin/deal-lines', {});
  assert.equal(redealt.status, 200, JSON.stringify(redealt.data));
  assert.deepEqual(redealt.data.session.readyPlayers, {});
  assert.equal(redealt.data.session.rolesLocked, false);
  const assignments = redealt.data.session.lineAssignments;
  const counts = [first, second, disconnected].map(player => Object.values(assignments).filter(owner => owner === player.id).length);
  assert.deepEqual([...counts].sort((a, b) => a - b), [2, 2, 3], 'seven shuffled tasks differ by at most one across three connected players');
  assert.ok(Object.values(assignments).includes(disconnected.id), 'the late joiner receives lines after the next host deal');
  for (const player of [first, second, disconnected]) {
    const state = await host.request('/api/state', { token: player.token });
    assert.deepEqual(state.data.queue.lines, expectedQueue(assignments, player));
  }
});

test('line dealing balances divisible task counts and leaves extra players without lines', async t => {
  const evenLines = Array.from({ length: 6 }, (_, index) => ({ id: `line_${String(index + 1).padStart(2, '0')}`, character: 'Actor', start: index + 0.1, end: index + 0.4 }));
  const even = await startFixtureRuntime(t, { lines: evenLines });
  const evenSelected = await even.select();
  await setGameMode(even, 'line'); await even.admin('/api/admin/open-lobby', {});
  const evenPlayers = await Promise.all(['A', 'B', 'C'].map(name => even.join(evenSelected.session, name)));
  for (const player of evenPlayers) await connectPlayer(even, player, t);
  const evenDeal = await even.admin('/api/admin/deal-lines', {});
  assert.equal(evenDeal.status, 200);
  assert.deepEqual(evenPlayers.map(player => Object.values(evenDeal.data.session.lineAssignments).filter(owner => owner === player.id).length), [2, 2, 2]);

  const shortLines = evenLines.slice(0, 2);
  const short = await startFixtureRuntime(t, { lines: shortLines });
  const shortSelected = await short.select();
  await setGameMode(short, 'line'); await short.admin('/api/admin/open-lobby', {});
  const manyPlayers = await Promise.all(['A', 'B', 'C', 'D'].map(name => short.join(shortSelected.session, name)));
  for (const player of manyPlayers) await connectPlayer(short, player, t);
  const shortDeal = await short.admin('/api/admin/deal-lines', {});
  assert.equal(shortDeal.status, 200);
  assert.deepEqual(manyPlayers.map(player => Object.values(shortDeal.data.session.lineAssignments).filter(owner => owner === player.id).length).sort((a, b) => a - b), [0, 0, 1, 1]);
  assert.equal(Object.keys(shortDeal.data.session.lineAssignments).length, 2);
});

test('line queues authorize each task and manual moves preserve accepted provenance while clearing stale candidates and retakes', async t => {
  const lines = [
    { id: '01_actor_first', character: 'Actor', start: 0.1, end: 0.4 },
    { id: '02_actor_second', character: 'Actor', start: 0.5, end: 0.8 },
    { id: '03_actor_third', character: 'Actor', start: 0.9, end: 1.2 },
  ];
  const host = await startFixtureRuntime(t, { lines });
  const selected = await host.select();
  await setGameMode(host, 'line');
  const [first, second] = await Promise.all(['First voice', 'Second voice'].map(name => host.join(selected.session, name)));
  await host.admin('/api/admin/open-lobby', {});
  for (const lineId of ['01_actor_first', '02_actor_second']) await host.admin('/api/admin/assign-line', { lineId, playerId: first.id });
  await host.admin('/api/admin/assign-line', { lineId: '03_actor_third', playerId: second.id });
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  assert.equal((await host.upload(second, '01_actor_first')).status, 403, 'another line owner cannot upload the task');

  const firstAccepted = await uploadAccepted(host, first, '01_actor_first');
  const firstAcceptedTake = firstAccepted.session.lineTakes['01_actor_first'];
  const secondAccepted = await uploadAccepted(host, first, '02_actor_second');
  const secondAcceptedTake = secondAccepted.session.lineTakes['02_actor_second'];
  const unaccepted = await host.upload(second, '03_actor_third');
  const unacceptedId = unaccepted.data.session.lineTakes['03_actor_third'].id;
  const retakeStart = await beginPlayerRetake(host, first, '01_actor_first', selected.session.matchId);
  assert.equal(retakeStart.status, 200, JSON.stringify(retakeStart.data));
  const retakeId = retakeStart.data.retakeId;
  const replacement = await host.upload(first, '01_actor_first', { retakeId });
  assert.equal(replacement.status, 200, JSON.stringify(replacement.data));
  const replacementId = replacement.data.session.replacementTakes['01_actor_first'].id;
  assert.equal(replacement.data.session.lineTakes['01_actor_first'].id, firstAcceptedTake.id, 'the accepted take remains authoritative during a replacement');

  const staleUpload = beginSlowUpload(host, first, selected.session.matchId, '01_actor_first', retakeId);
  for (let attempt = 0; attempt < 40 && !(await readdir(path.join(host.dataDir, 'tmp'))).length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok((await readdir(path.join(host.dataDir, 'tmp'))).length, 'replacement upload is in progress before ownership changes');
  const moved = await host.admin('/api/admin/assign-line', { lineId: '01_actor_first', playerId: second.id });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  staleUpload.finish();
  assert.ok([403, 409].includes((await staleUpload.response).status), 'late replacement uploads fail after ownership changes');
  assert.equal(moved.data.session.lineTakes['01_actor_first'].id, firstAcceptedTake.id);
  assert.equal(moved.data.session.lineTakes['01_actor_first'].playerId, first.id, 'reassignment preserves the accepted recorder provenance');
  assert.equal(moved.data.session.replacementTakes['01_actor_first'], undefined);
  assert.equal(moved.data.session.activeRetakes.length, 0);
  await access(path.join(host.dataDir, 'takes', firstAcceptedTake.id + '.media'));
  await assert.rejects(access(path.join(host.dataDir, 'takes', replacementId + '.media')), { code: 'ENOENT' });

  assert.equal((await host.upload(first, '03_actor_third')).status, 403);
  await host.admin('/api/admin/pause', {});
  const reassignedWhilePaused = await host.admin('/api/admin/assign-line', { lineId: '03_actor_third', playerId: first.id });
  assert.equal(reassignedWhilePaused.status, 200, JSON.stringify(reassignedWhilePaused.data));
  assert.equal(reassignedWhilePaused.data.session.lineTakes['03_actor_third'], undefined, 'an unaccepted candidate does not follow a manual move');
  await assert.rejects(access(path.join(host.dataDir, 'takes', unacceptedId + '.media')), { code: 'ENOENT' });
  assert.equal((await host.admin('/api/admin/resume', {})).status, 200);
  const final = await uploadAccepted(host, first, '03_actor_third');
  assert.equal(final.session.state, 'review');
  assert.deepEqual(final.session.players.find(player => player.id === first.id).progress, {
    currentQueueIndex: 2, totalAssignedLines: 2, completedLines: 2, pendingLines: 0,
  });

  const movedAccepted = await host.admin('/api/admin/assign-line', { lineId: '02_actor_second', playerId: second.id });
  assert.equal(movedAccepted.status, 200, JSON.stringify(movedAccepted.data));
  assert.equal(movedAccepted.data.session.lineTakes['02_actor_second'].id, secondAcceptedTake.id);
  assert.equal(movedAccepted.data.session.lineTakes['02_actor_second'].playerId, first.id);
  assert.deepEqual((await host.request('/api/state', { token: second.token })).data.queue.lines, ['01_actor_first', '02_actor_second']);
  assert.deepEqual((await host.request('/api/state', { token: first.token })).data.queue.lines, ['03_actor_third']);
  assert.equal(playerProgress((await host.admin('/api/state')).data, second.id).completedLines, 2);
  assert.equal(playerProgress((await host.admin('/api/state')).data, first.id).totalAssignedLines, 1);
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 200);
  assert.equal((await host.admin('/api/admin/assign-line', { lineId: '02_actor_second', playerId: first.id })).status, 409, 'playback locks manual line moves');
});

test('replacement retakes are private, identity-bound, and hold review until accepted', async t => {
  const lines = Array.from({ length: 4 }, (_, index) => ({ id: `line_${index + 1}`, character: 'Actor', start: index + 0.1, end: index + 0.4 }));
  const host = await startFixtureRuntime(t, { lines });
  const selected = await host.select();
  await setGameMode(host, 'line');
  const [owner, other] = await Promise.all(['Owner', 'Other'].map(name => host.join(selected.session, name)));
  await host.admin('/api/admin/open-lobby', {});
  for (const lineId of ['line_1', 'line_2']) await host.admin('/api/admin/assign-line', { lineId, playerId: owner.id });
  for (const lineId of ['line_3', 'line_4']) await host.admin('/api/admin/assign-line', { lineId, playerId: other.id });
  await host.admin('/api/admin/start', {});
  const acceptedOne = await uploadAccepted(host, owner, 'line_1');
  const acceptedId = acceptedOne.session.lineTakes.line_1.id;
  await uploadAccepted(host, owner, 'line_2');

  const started = await beginPlayerRetake(host, owner, 'line_1', selected.session.matchId);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const retakeId = started.data.retakeId;
  assert.match(retakeId, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal((await host.request('/api/takes/line_1/retake', { method: 'POST', body: { matchId: selected.session.matchId } })).status, 401);
  assert.equal((await beginPlayerRetake(host, owner, 'line_1', selected.session.matchId)).status, 409, 'a second tab cannot take over the same active retake');
  assert.equal((await beginPlayerRetake(host, owner, 'line_2', selected.session.matchId)).status, 409, 'one player may hold only one active retake');
  assert.equal((await beginPlayerRetake(host, other, 'line_1', selected.session.matchId)).status, 403);
  assert.equal((await host.request('/api/takes/line_1/retake/cancel', {
    method: 'POST', token: other.token, body: { matchId: selected.session.matchId, retakeId },
  })).status, 409, 'another player cannot cancel the active retake');
  assert.equal((await beginPlayerRetake(host, owner, 'line_1', 'stale-match')).status, 409, 'retake starts are bound to their match');

  const invalid = await host.upload(owner, 'line_1', { retakeId, type: 'text/plain' });
  assert.ok([400, 415].includes(invalid.status));
  assert.equal((await host.admin('/api/state')).data.session.lineTakes.line_1.id, acceptedId, 'a failed replacement preserves the accepted take');
  const replacementSaved = await host.upload(owner, 'line_1', { retakeId });
  assert.equal(replacementSaved.status, 200, JSON.stringify(replacementSaved.data));
  const candidate = replacementSaved.data.session.replacementTakes.line_1;
  assert.equal(candidate.status, 'recorded');
  assert.equal(replacementSaved.data.session.lineTakes.line_1.id, acceptedId);
  assert.ok(replacementSaved.data.session.activeRetakes.some(retake => retake.lineId === 'line_1' && retake.playerId === owner.id));
  const ownerState = (await host.request('/api/state', { token: owner.token })).data;
  const otherState = (await host.request('/api/state', { token: other.token })).data;
  assert.equal(ownerState.session.replacementTakes.line_1.id, candidate.id);
  assert.equal(otherState.session.replacementTakes.line_1, undefined);
  assert.equal((await host.request(candidate.url, { token: other.token })).status, 403);
  assert.equal((await host.accept(owner, 'line_1', candidate.id, { retakeId: 'wrong-retake' })).status, 409);
  assert.equal((await host.admin('/api/admin/accept-all', {})).status, 200);
  assert.equal((await host.admin('/api/admin/review', {})).status, 409, 'explicit review cannot bypass a replacement in progress');
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: true })).status, 409, 'playback waits for replacement retakes even with missing lines allowed');
  assert.equal((await host.admin('/api/state')).data.session.lineTakes.line_1.id, acceptedId);

  const acceptedReplacement = await host.accept(owner, 'line_1', candidate.id, { retakeId });
  assert.equal(acceptedReplacement.status, 200, JSON.stringify(acceptedReplacement.data));
  assert.equal(acceptedReplacement.data.session.state, 'recording', 'other required lines are still pending');
  assert.equal(acceptedReplacement.data.session.lineTakes.line_1.id, candidate.id);
  assert.equal(acceptedReplacement.data.session.lineTakes.line_1.status, 'accepted');
  assert.equal(acceptedReplacement.data.session.replacementTakes.line_1, undefined);
  assert.equal(acceptedReplacement.data.session.activeRetakes.length, 0);
  await assert.rejects(access(path.join(host.dataDir, 'takes', acceptedId + '.media')), { code: 'ENOENT' });

  await uploadAccepted(host, other, 'line_3');
  const final = await uploadAccepted(host, other, 'line_4');
  assert.equal(final.session.state, 'review');
  assert.equal(final.session.completedLineCount, 4);
  assert.equal((await beginPlayerRetake(host, owner, 'line_1', selected.session.matchId)).status, 409, 'new retakes close after every required line is accepted');
});

test('players can cancel replacements, disconnect cancellation waits for the last socket, and host transitions cancel retakes', async t => {
  const lines = [
    { id: 'accepted_line', character: 'Actor', start: 0.1, end: 0.4 },
    { id: 'pending_line', character: 'Actor', start: 0.5, end: 0.8 },
  ];
  const host = await startFixtureRuntime(t, { lines });
  const selected = await host.select();
  await setGameMode(host, 'line');
  const player = await host.join(selected.session, 'Retaker');
  await host.admin('/api/admin/open-lobby', {});
  for (const line of lines) await host.admin('/api/admin/assign-line', { lineId: line.id, playerId: player.id });
  await host.admin('/api/admin/start', {});
  const socketOne = await connectPlayer(host, player, t);
  const original = await uploadAccepted(host, player, 'accepted_line');
  const originalId = original.session.lineTakes.accepted_line.id;

  const firstStart = await beginPlayerRetake(host, player, 'accepted_line', selected.session.matchId);
  const firstId = firstStart.data.retakeId;
  const firstCandidate = await host.upload(player, 'accepted_line', { retakeId: firstId });
  assert.equal(firstCandidate.status, 200);
  const firstCandidateId = firstCandidate.data.session.replacementTakes.accepted_line.id;
  const cancelled = await host.request('/api/takes/accepted_line/retake/cancel', {
    method: 'POST', token: player.token, body: { matchId: selected.session.matchId, retakeId: firstId },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.session.lineTakes.accepted_line.id, originalId);
  assert.equal(cancelled.data.session.replacementTakes.accepted_line, undefined);
  await assert.rejects(access(path.join(host.dataDir, 'takes', firstCandidateId + '.media')), { code: 'ENOENT' });
  assert.equal((await host.upload(player, 'accepted_line', { retakeId: firstId })).status, 409, 'cancelled retake IDs cannot upload late candidates');

  const secondStart = await beginPlayerRetake(host, player, 'accepted_line', selected.session.matchId);
  const secondId = secondStart.data.retakeId;
  const socketTwo = await connectPlayer(host, player, t);
  await closePlayerSocket(socketOne);
  assert.equal((await host.admin('/api/state')).data.session.activeRetakes.length, 1, 'one remaining connection keeps the retake alive');
  await closePlayerSocket(socketTwo);
  const afterDisconnect = await waitForAdminState(host, state => state.session.activeRetakes.length === 0);
  assert.equal(afterDisconnect.session.lineTakes.accepted_line.id, originalId, 'disconnect cancellation keeps the accepted take');
  assert.equal((await host.upload(player, 'accepted_line', { retakeId: secondId })).status, 409);

  const afterDisconnectSocket = await connectPlayer(host, player, t);
  const thirdStart = await beginPlayerRetake(host, player, 'accepted_line', selected.session.matchId);
  assert.equal(thirdStart.status, 200);
  const paused = await host.admin('/api/admin/pause', {});
  assert.equal(paused.status, 200);
  assert.equal(paused.data.session.activeRetakes.length, 0, 'host pause cancels in-flight replacements');
  assert.equal(paused.data.session.lineTakes.accepted_line.id, originalId);
  assert.equal((await host.admin('/api/admin/resume', {})).status, 200);

  const afterPause = await beginPlayerRetake(host, player, 'accepted_line', selected.session.matchId);
  assert.equal(afterPause.status, 200);
  const reopened = await host.admin('/api/admin/reopen-roles', {});
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.session.activeRetakes.length, 0, 'reopening assignment cancels active replacements');
  assert.equal(reopened.data.session.lineTakes.accepted_line.id, originalId);
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);

  const beforeHostRetake = await beginPlayerRetake(host, player, 'accepted_line', selected.session.matchId);
  assert.equal(beforeHostRetake.status, 200);
  const hostRetake = await host.admin('/api/admin/retake', { lineId: 'accepted_line' });
  assert.equal(hostRetake.status, 200);
  assert.equal(hostRetake.data.session.activeRetakes.length, 0, "a host-requested retake cancels the player's active replacement");
  assert.equal(hostRetake.data.session.lineTakes.accepted_line, undefined);
  await assert.rejects(access(path.join(host.dataDir, 'takes', originalId + '.media')), { code: 'ENOENT' });
  await closePlayerSocket(afterDisconnectSocket);
});

test('video export returns a file on success and removes failed export work', async t => {
  const toolDir = await mkdtemp(path.join(os.tmpdir(), 'open-dub-ffmpeg-test-'));
  const fakeFfmpeg = path.join(toolDir, 'ffmpeg');
  await writeFile(fakeFfmpeg, '#!/bin/sh\nfor output do :; done\nprintf "fake mp4" > "$output"\n');
  await chmod(fakeFfmpeg, 0o700);
  t.after(() => rm(toolDir, { recursive: true, force: true }));
  const host = await setupThree(t, { ffmpegPath: fakeFfmpeg });
  await finish(host);
  const success = await host.admin('/api/admin/export', {});
  assert.equal(success.status, 200, JSON.stringify(success.data));
  const downloaded = await host.request(success.data.url, { token: host.adminToken });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.data, 'fake mp4');

  await writeFile(fakeFfmpeg, '#!/bin/sh\nexit 1\n');
  await chmod(fakeFfmpeg, 0o700);
  const failure = await host.admin('/api/admin/export', {});
  assert.equal(failure.status, 422);
  const files = await readdir(path.join(host.dataDir, 'exports'));
  assert.equal(files.some(name => name.endsWith('.work')), false);
  assert.equal(files.filter(name => name.endsWith('.mp4')).length, 1);
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

test('party survives two packs and same-pack replay while match data resets and stale uploads are rejected', async t => {
  const host = await startFixtureRuntime(t);
  await addFixturePack(host.workshopDir, 'small-pack', [
    { id: '01_actor', character: 'Actor', start: 0.1, end: 0.4 },
    { id: '02_narrator', character: 'Narrator', start: 0.5, end: 0.8 },
  ]);
  const party = await host.admin('/api/admin/create-party', {});
  assert.equal(party.status, 200);
  assert.equal(party.data.session.partyCreated, true);
  assert.equal(party.data.session.pack, null);
  const partyId = party.data.session.id; const invite = party.data.session.joinToken;
  const configured = await host.admin('/api/admin/settings', {
    gameMode: 'character',
    freeRolePicking: true, allowMultipleRoles: true, maxRolesPerPlayer: 3,
    autoBalanceSuggestions: true, lockRolesWhenReady: true,
    referencePlaybackEnabled: true, voiceEffectsEnabled: true, compactMobilePreferred: false,
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.data));
  const player = await host.join(party.data.session, 'Kept player');
  const socket = new WebSocket(host.base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: player.cookie } });
  t.after(() => socket.close());
  await waitSocketState(socket, state => state.viewer.playerId === player.id);

  const listed = await host.admin('/api/admin/packs');
  const fullPack = listed.data.packs.find(pack => pack.metadata.title === 'Synthetic pack – тест');
  const smallPack = listed.data.packs.find(pack => pack.metadata.title === 'small-pack');
  assert.deepEqual(smallPack.characterLineCounts, [1, 1]);
  assert.equal(smallPack.characterLineCounts.reduce((sum, count) => sum + count, 0), smallPack.lineCount);
  const firstMatchState = waitSocketState(socket, state => !!state.session.matchId);
  const first = await host.admin('/api/admin/select', { packId: fullPack.id, partyId });
  const firstMatchId = first.data.session.matchId;
  assert.equal(first.data.session.id, partyId);
  assert.equal(first.data.session.settings.maxRolesPerPlayer, 3);
  await firstMatchState;
  await host.admin('/api/admin/open-lobby', {});
  for (const character of first.data.session.pack.characters) await host.admin('/api/admin/assign', { character, playerId: player.id });
  const ready = await host.request('/api/player/ready', { method: 'POST', token: player.token, body: { ready: true, matchId: firstMatchId } });
  assert.equal(ready.status, 200);
  assert.equal(ready.data.session.rolesLocked, true);
  await host.admin('/api/admin/start', {});
  const saved = await host.upload(player, '04_alice');
  assert.equal(saved.status, 200);
  const oldTakeId = saved.data.session.lineTakes['04_alice'].id;

  const staleUpload = beginSlowUpload(host, player, firstMatchId, '01_alice');
  for (let attempt = 0; attempt < 40 && !(await readdir(path.join(host.dataDir, 'tmp'))).length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok((await readdir(path.join(host.dataDir, 'tmp'))).length, 'upload should be in progress before the match changes');
  await host.admin('/api/admin/review', {});
  const returned = await host.admin('/api/admin/next-match', {});
  assert.equal(returned.data.session.id, partyId);
  assert.equal(returned.data.session.joinToken, invite);
  assert.equal(returned.data.session.matchId, null);
  assert.equal(returned.data.session.pack, null);
  assert.deepEqual(returned.data.session.roleAssignments, {});
  assert.deepEqual(returned.data.session.readyPlayers, {});
  assert.equal(returned.data.session.rolesLocked, false);
  assert.deepEqual(returned.data.session.lineTakes, {});
  assert.equal(returned.data.session.playback, null);
  assert.equal(returned.data.session.players[0].id, player.id);
  assert.equal(returned.data.session.players[0].connected, true);
  await assert.rejects(access(path.join(host.dataDir, 'takes', oldTakeId + '.media')), { code: 'ENOENT' });

  const secondMatchState = waitSocketState(socket, state => state.session.matchId && state.session.matchId !== firstMatchId);
  const second = await host.admin('/api/admin/select', { packId: smallPack.id, partyId });
  const secondMatchId = second.data.session.matchId;
  assert.notEqual(secondMatchId, firstMatchId);
  assert.equal(second.data.session.id, partyId);
  assert.equal(second.data.session.settings.maxRolesPerPlayer, 2);
  assert.equal(second.data.session.players[0].nickname, 'Kept player');
  assert.equal((await host.request('/api/state', { token: player.token })).data.viewer.playerId, player.id);
  await secondMatchState;
  await host.admin('/api/admin/open-lobby', {});
  for (const character of second.data.session.pack.characters) await host.admin('/api/admin/assign', { character, playerId: player.id });
  await host.admin('/api/admin/start', {});
  staleUpload.finish();
  assert.equal((await staleUpload.response).status, 409);
  assert.deepEqual((await host.admin('/api/state')).data.session.lineTakes, {});
  await host.admin('/api/admin/review', {});
  await host.admin('/api/admin/playback', { allowMissing: true });
  const between = await host.admin('/api/admin/next-match', {});
  assert.equal(between.data.session.players[0].connected, true);
  const replay = await host.admin('/api/admin/select', { packId: smallPack.id, partyId });
  assert.notEqual(replay.data.session.matchId, secondMatchId);
  assert.equal(replay.data.session.settings.maxRolesPerPlayer, 2);
  assert.equal(replay.data.session.players[0].id, player.id);

  const replacement = await host.admin('/api/admin/create-party', {});
  assert.notEqual(replacement.data.session.id, partyId);
  assert.notEqual(replacement.data.session.joinToken, invite);
  assert.deepEqual(replacement.data.session.players, []);
  assert.equal((await host.request('/api/state', { token: player.token })).status, 401);
  assert.ok([403, 409].includes((await host.request('/api/join', { method: 'POST', body: { roomId: partyId, joinToken: invite, nickname: 'Old invite' } })).status));
  if (socket.readyState !== WebSocket.CLOSED) await new Promise(resolve => socket.once('close', resolve));
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

test('WebSocket notifies existing players immediately when a pack is chosen and a role is claimed', async t => {
  const host = await startFixtureRuntime(t);
  const party = await host.admin('/api/admin/create-party', {});
  assert.equal(party.status, 200);
  const player = await host.join(party.data.session, 'Early arrival');
  const socket = new WebSocket(host.base.replace('http:', 'ws:') + '/ws?viewer=player', {
    headers: { Cookie: player.cookie },
  });
  t.after(() => { if (socket.readyState !== WebSocket.CLOSED) socket.close(); });
  const initial = await waitSocketState(socket, state => state.type === 'state' && state.viewer?.playerId === player.id);
  assert.equal(initial.session.pack, null);
  const packs = await host.admin('/api/admin/packs');
  const packId = packs.data.packs[0].id;
  const selectionUpdate = waitSocketState(socket, state => state.session?.pack?.id === packId);
  const chosen = await host.admin('/api/admin/select', { packId, partyId: party.data.session.id });
  assert.equal(chosen.status, 200);
  const selectedOnClient = await selectionUpdate;
  assert.equal(selectedOnClient.session.state, 'lobby');
  assert.equal(selectedOnClient.queue.lines.length, 0);
  const claimUpdate = waitSocketState(socket, state => state.session?.roleAssignments?.Alice === player.id);
  const claimed = await host.request('/api/player/claim', {
    method: 'POST', token: player.token,
    body: { matchId: chosen.data.session.matchId, character: 'Alice' },
  });
  assert.equal(claimed.status, 200);
  assert.deepEqual((await claimUpdate).queue.assignedCharacters, ['Alice']);
  assert.equal((await host.admin('/api/state')).data.session.roleAssignments.Alice, player.id);
});
