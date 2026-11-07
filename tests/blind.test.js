import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startFixtureRuntime } from './helpers.js';
import { redactFor, hiddenReferenceAssets } from '../server/session/redact.js';

const LINES = ['01_alice', '02_bob', '03_cara', '04_alice', '05_bob', '06_cara', '07_narrator'];
const settings = (rules, extra = {}) => ({
  gameMode: 'character', freeRolePicking: true, allowMultipleRoles: true, maxRolesPerPlayer: 0, autoBalanceSuggestions: true,
  lockRolesWhenReady: true, referencePlaybackEnabled: true, voiceEffectsEnabled: true, compactMobilePreferred: false, rules, ...extra,
});
const captionOf = id => `Caption for ${id}: "quoted"`;

async function start(t, blind, { record = false } = {}) {
  const host = await startFixtureRuntime(t);
  const { session } = await host.select();
  const ada = await host.join(session, 'Ada');
  const bo = await host.join(session, 'Bo');
  const saved = await host.admin('/api/admin/settings', settings({ blind }));
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  await host.admin('/api/admin/open-lobby', {});
  for (const [character, player] of [['Alice', ada], ['Narrator', ada], ['Bob', bo], ['Cara', bo]]) await host.admin('/api/admin/assign', { character, playerId: player.id });
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  const owner = { '01_alice': ada, '04_alice': ada, '07_narrator': ada, '02_bob': bo, '05_bob': bo, '03_cara': bo, '06_cara': bo };
  if (record) for (const line of LINES) {
    const up = await host.upload(owner[line], line);
    assert.equal((await host.accept(owner[line], line, up.data.session.lineTakes[line].id)).status, 200);
  }
  return { host, ada, bo, owner };
}
const playerState = (host, player) => host.request('/api/state', { token: player.token });

test('redactFor is pure and only touches blind lines for players', () => {
  const session = { pack: { id: 'p', lines: [{ id: 'a', caption: 'secret a', referenceAudio: '/media/p/ref-a' }, { id: 'b', caption: 'open b', referenceAudio: '/media/p/ref-b' }] } };
  const frozen = structuredClone(session);
  const blindLines = { a: { caption: true, reference: true, scene: false } };
  const player = redactFor({ kind: 'player', playerId: 'x' }, session, { blindLines });
  assert.deepEqual(session, frozen, 'input is not mutated');
  assert.equal(player.pack.lines[0].caption, '');
  assert.equal(player.pack.lines[0].referenceAudio, null);
  assert.equal(player.pack.lines[0].captionHidden, true);
  assert.equal(player.pack.lines[1].caption, 'open b');
  assert.equal(JSON.stringify(player).includes('secret a'), false);
  assert.equal(JSON.stringify(player).includes('ref-a'), false);
  const admin = redactFor({ kind: 'admin' }, session, { blindLines });
  assert.equal(admin.pack.lines[0].caption, 'secret a');
  assert.deepEqual(admin.blindLines, blindLines);
  const revealed = redactFor({ kind: 'player', playerId: 'x' }, session, { blindLines, revealed: true });
  assert.equal(revealed.pack.lines[0].caption, 'secret a');
  assert.deepEqual(revealed.pack.lines[0].blind, blindLines.a, 'the reveal still says which lines were blind');
  assert.equal(redactFor({ kind: 'player' }, session, {}), session, 'no blind lines: the snapshot is untouched');
  assert.deepEqual([...hiddenReferenceAssets(session.pack, blindLines, false)], ['ref-a']);
  assert.equal(hiddenReferenceAssets(session.pack, blindLines, true).size, 0);
});

test('no player snapshot, WebSocket message or media response leaks a blind caption or reference before the reveal', async (t) => {
  const { host, ada, bo } = await start(t, { caption: true, reference: true, share: 1 });
  const admin = (await host.admin('/api/state')).data.session;
  const referenceUrls = admin.pack.lines.map(line => line.referenceAudio);
  assert.ok(referenceUrls.every(Boolean));
  assert.equal(Object.keys(admin.blindLines).length, 7);
  for (const player of [ada, bo]) {
    const state = (await playerState(host, player)).data;
    const text = JSON.stringify(state);
    for (const line of LINES) assert.equal(text.includes(captionOf(line)), false, `caption of ${line} leaked`);
    assert.equal(text.includes('Caption for'), false);
    for (const url of referenceUrls) {
      assert.equal(text.includes(url), false, 'reference URL leaked');
      assert.equal(text.includes(url.split('/').pop()), false, 'reference asset id leaked');
      assert.equal((await host.request(url, { token: player.token })).status, 403, 'reference audio is not served to players');
      assert.equal((await host.request(url, { token: host.adminToken })).status, 200, 'the host still hears it');
    }
    assert.equal(state.session.pack.lines[0].captionHidden, true);
    assert.equal(Object.hasOwn(state.session, 'blindLines'), false, 'the blind map is host-only');
  }
  // The same redaction applies to pushed WebSocket snapshots.
  const socket = new WebSocket(host.base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: ada.cookie } });
  const message = await new Promise((resolve, reject) => { socket.once('message', raw => resolve(raw.toString())); socket.once('error', reject); });
  socket.close();
  assert.equal(message.includes('Caption for'), false);
  assert.equal(message.includes(referenceUrls[0]), false);
});

test('the reveal unlocks everything for players, and final playback needs it', async (t) => {
  const { host, ada } = await start(t, { caption: true, reference: true, share: 1 }, { record: true });
  assert.equal((await host.admin('/api/state')).data.session.state, 'review');
  assert.equal((await playerState(host, ada)).data.session.secretsActive, true);
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 409, 'playback is gated on the reveal');
  assert.equal((await host.request('/api/admin/reveal', { method: 'POST', token: ada.token, body: {} })).status, 403, 'players cannot reveal');
  const revealed = await host.admin('/api/admin/reveal', {});
  assert.equal(revealed.status, 200, JSON.stringify(revealed.data));
  assert.equal(revealed.data.session.state, 'reveal');
  const after = (await playerState(host, ada)).data;
  const alice = after.session.pack.lines.find(line => line.id === '01_alice');
  assert.equal(alice.caption, captionOf('01_alice'));
  assert.ok(alice.referenceAudio);
  assert.equal(alice.blind.caption, true);
  assert.equal(after.session.secretsActive, false);
  assert.equal((await host.request(alice.referenceAudio, { token: ada.token })).status, 200);
  assert.equal((await host.admin('/api/admin/reveal', {})).status, 409, 'already revealed');
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 200);
  await host.admin('/api/admin/stop-playback', {});
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 200, 'replaying after a reveal needs no second reveal');
});

test('with no secret rules the reveal step is skipped: playback starts straight from review', async (t) => {
  const { host } = await start(t, { caption: false, reference: false, scene: false, share: 1 }, { record: true });
  assert.equal((await host.admin('/api/state')).data.session.secretsActive, false);
  assert.equal((await host.admin('/api/admin/reveal', {})).status, 409);
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 200);
});

test('share picks the expected number of lines and the selection is stable across snapshots and restarts of recording', async (t) => {
  for (const [share, expected] of [[1, 7], [0.5, 4], [0.01, 1], [0.3, 2], [0, 0]]) {
    const { host } = await start(t, { caption: true, share });
    const first = (await host.admin('/api/state')).data.session.blindLines ?? {};
    assert.equal(Object.keys(first).length, expected, `share ${share}`);
    const again = (await host.admin('/api/state')).data.session.blindLines ?? {};
    assert.deepEqual(again, first);
    await host.admin('/api/admin/reopen-roles', {});
    await host.admin('/api/admin/start', {});
    assert.deepEqual((await host.admin('/api/state')).data.session.blindLines ?? {}, first, 'restarting recording does not re-roll');
  }
});

test('blind flags per line follow the enabled options; a player only loses what the rule hides', async (t) => {
  const { host, ada } = await start(t, { scene: true, share: 1 });
  const state = (await playerState(host, ada)).data.session;
  const line = state.pack.lines[0];
  assert.deepEqual(line.blind, { caption: false, reference: false, scene: true });
  assert.equal(line.caption, captionOf(line.id), 'scene-only blindness keeps the caption');
  assert.ok(line.referenceAudio);
});

test('a host retake after the reveal makes the lines blind again until revealed again', async (t) => {
  const { host, ada, owner } = await start(t, { caption: true, share: 1 }, { record: true });
  await host.admin('/api/admin/reveal', {});
  assert.equal((await host.admin('/api/admin/retake', { lineId: '01_alice' })).status, 200);
  const state = (await playerState(host, ada)).data.session;
  assert.equal(state.state, 'recording');
  assert.equal(state.pack.lines[0].caption, '');
  assert.equal(state.revealed, false);
  const up = await host.upload(owner['01_alice'], '01_alice');
  await host.accept(owner['01_alice'], '01_alice', up.data.session.lineTakes['01_alice'].id);
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 409);
  assert.equal((await host.admin('/api/admin/reveal', {})).status, 200);
});

test('blind rules lock when role selection opens, and invalid blind values are rejected', async (t) => {
  const { host } = await start(t, { caption: true, share: 1 });
  assert.equal((await host.admin('/api/admin/settings', settings({ blind: { caption: false } }))).status, 409);
  const fresh = await startFixtureRuntime(t);
  await fresh.select();
  for (const blind of [{ share: 3 }, { caption: 'x' }, { nope: 1 }]) assert.equal((await fresh.admin('/api/admin/settings', settings({ blind }))).status, 400);
});

test('the live match\'s library entry is hidden from players until the reveal', async (t) => {
  const { host, ada } = await start(t, { caption: true, share: 1 }, { record: true });
  await host.admin('/api/admin/settings', settings(undefined, { libraryVisibleToPlayers: true }));
  const [entry] = (await host.admin('/api/library')).data.entries;
  assert.ok(entry);
  assert.deepEqual((await host.request('/api/library', { token: ada.token })).data.entries, []);
  assert.equal((await host.request('/api/library/' + entry.id, { token: ada.token })).status, 403);
  await host.admin('/api/admin/reveal', {});
  assert.equal((await host.request('/api/library/' + entry.id, { token: ada.token })).status, 200);
});
