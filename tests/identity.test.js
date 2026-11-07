import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { PALETTE, COLOR_IDS, AVATAR_IDS, initialsOf, colorHex } from '../web/shared/identity-data.js';
import { startFixtureRuntime } from './helpers.js';

const channel = value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

test('palette has 12 unique colors that keep 3:1 contrast on both the dark and light themes', () => {
  assert.equal(PALETTE.length, 12);
  assert.equal(new Set(COLOR_IDS).size, 12);
  assert.equal(new Set(PALETTE.map(color => color.hex)).size, 12);
  for (const { id, hex } of PALETTE) {
    assert.ok(contrast(luminance(hex), luminance('#121212')) >= 3, `${id} on dark`);
    assert.ok(contrast(luminance(hex), luminance('#ffffff')) >= 3, `${id} on light`);
  }
});

test('every allowlisted avatar has an SVG file and no stray files exist', async () => {
  const files = (await readdir(new URL('../web/shared/avatars/', import.meta.url))).sort();
  assert.deepEqual(files, AVATAR_IDS.map(id => id + '.svg').sort());
  assert.equal(AVATAR_IDS.length, 40);
  for (const file of files) assert.match(await readFile(new URL('../web/shared/avatars/' + file, import.meta.url), 'utf8'), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test('initials and unknown colors have safe fallbacks', () => {
  assert.equal(initialsOf('Ada Lovelace'), 'AL');
  assert.equal(initialsOf('melvi'), 'ME');
  assert.equal(initialsOf('  '), '?');
  assert.equal(colorHex('url(javascript:1)'), '#7a8794');
});

test('players are auto-assigned unique colors, and a taken color on join falls back to the first free one', async (t) => {
  const host = await startFixtureRuntime(t);
  const { session } = await host.select();
  const first = await host.join(session, 'One', { color: 'teal', avatar: 'cat' });
  const second = await host.join(session, 'Two', { color: 'teal' });
  const third = await host.join(session, 'Three');
  assert.equal(first.state.session.players[0].color, 'teal');
  assert.equal(first.state.session.players[0].avatar, 'cat');
  const players = (await host.admin('/api/state')).data.session.players;
  assert.deepEqual(players.map(player => player.color), ['teal', 'red', 'orange']);
  assert.equal(players[1].avatar, null);
  assert.equal(new Set(players.map(player => player.marker)).size, 1);
  assert.ok(second.id && third.id);
});

test('join and profile reject unknown colors and avatars, so no free text can reach CSS or URLs', async (t) => {
  const host = await startFixtureRuntime(t);
  const { session } = await host.select();
  for (const extra of [{ color: 'red; background:url(x)' }, { color: '#ff0000' }, { avatar: '../../etc/passwd' }, { avatar: 'unicorn' }]) {
    const result = await host.request('/api/join', { method: 'POST', body: { roomId: session.id, joinToken: session.joinToken, nickname: 'X', ...extra } });
    assert.equal(result.status, 400, JSON.stringify(extra));
  }
  const player = await host.join(session, 'Real');
  for (const body of [{ color: 'nope' }, { avatar: 'nope' }, { nickname: '' }, { nickname: 'x'.repeat(41) }, { matchId: 'm' }, { color: 5 }]) {
    const result = await host.request('/api/player/profile', { method: 'POST', token: player.token, body });
    assert.equal(result.status, 400, JSON.stringify(body));
  }
  const noAuth = await host.request('/api/player/profile', { method: 'POST', body: { color: 'red' } });
  assert.ok([401, 403].includes(noAuth.status));
  const admin = await host.request('/api/player/profile', { method: 'POST', token: host.adminToken, body: { color: 'red' } });
  assert.ok([401, 403].includes(admin.status));
});

test('profile changes: taken color answers 409 with the next free color; avatar and nickname update; clearing the avatar works', async (t) => {
  const host = await startFixtureRuntime(t);
  const { session } = await host.select();
  const a = await host.join(session, 'A', { color: 'red' });
  const b = await host.join(session, 'B', { color: 'blue' });
  const clash = await host.request('/api/player/profile', { method: 'POST', token: b.token, body: { color: 'red' } });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.suggestion, 'orange');
  const ok = await host.request('/api/player/profile', { method: 'POST', token: b.token, body: { color: clash.data.suggestion, avatar: 'fox', nickname: 'Bee' } });
  assert.equal(ok.status, 200);
  const me = ok.data.session.players.find(player => player.id === b.id);
  assert.deepEqual([me.color, me.avatar, me.nickname], ['orange', 'fox', 'Bee']);
  const cleared = await host.request('/api/player/profile', { method: 'POST', token: b.token, body: { avatar: '' } });
  assert.equal(cleared.data.session.players.find(player => player.id === b.id).avatar, null);
  const same = await host.request('/api/player/profile', { method: 'POST', token: a.token, body: { color: 'red' } });
  assert.equal(same.status, 200); // keeping your own color is never a conflict
});

test('after 12 players the palette is exhausted: colors repeat with a distinct pattern marker', async (t) => {
  const host = await startFixtureRuntime(t);
  const { session } = await host.select();
  const joined = [];
  for (let index = 0; index < 14; index++) joined.push(await host.join(session, `P${index}`));
  const players = (await host.admin('/api/state')).data.session.players;
  assert.equal(new Set(players.slice(0, 12).map(player => player.color)).size, 12);
  assert.ok(players.slice(0, 12).every(player => player.marker === 'none'));
  assert.deepEqual(players.slice(12).map(player => player.color), [COLOR_IDS[0], COLOR_IDS[1]]);
  assert.deepEqual(players.slice(12).map(player => player.marker), ['dot', 'dot']);
  const pairs = new Set(players.map(player => player.color + player.marker));
  assert.equal(pairs.size, players.length, 'color + marker identifies every player');
  // With no free color left, choosing someone else's color is allowed and just gains a marker.
  const shared = await host.request('/api/player/profile', { method: 'POST', token: joined[13].token, body: { color: players[5].color } });
  assert.equal(shared.status, 200);
  const updated = shared.data.session.players;
  assert.equal(updated[13].color, players[5].color);
  assert.equal(updated[13].marker, 'dot');
});

test('accepted takes keep the recorder profile from accept time after the player restyles', async (t) => {
  const host = await startFixtureRuntime(t);
  const { session } = await host.select();
  const player = await host.join(session, 'Recorder', { color: 'green', avatar: 'owl' });
  await host.admin('/api/admin/open-lobby', {});
  for (const character of ['Alice', 'Bob', 'Cara', 'Narrator']) assert.equal((await host.admin('/api/admin/assign', { character, playerId: player.id })).status, 200);
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  const uploaded = await host.upload(player, '01_alice');
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.data.session.lineTakes['01_alice'].recorder, null, 'unaccepted takes carry no recorder');
  const accepted = await host.accept(player, '01_alice', uploaded.data.session.lineTakes['01_alice'].id);
  assert.deepEqual(accepted.data.session.lineTakes['01_alice'].recorder, { id: player.id, nickname: 'Recorder', color: 'green', avatar: 'owl' });
  const restyle = await host.request('/api/player/profile', { method: 'POST', token: player.token, body: { color: 'pink', avatar: 'cat', nickname: 'Renamed' } });
  assert.equal(restyle.status, 200, 'profile edits are allowed during recording');
  const after = (await host.admin('/api/state')).data.session;
  assert.deepEqual(after.lineTakes['01_alice'].recorder, { id: player.id, nickname: 'Recorder', color: 'green', avatar: 'owl' });
  assert.equal(after.players[0].color, 'pink');
  // A take accepted afterwards captures the new profile.
  const second = await host.upload(player, '02_bob');
  const secondAccepted = await host.accept(player, '02_bob', second.data.session.lineTakes['02_bob'].id);
  assert.equal(secondAccepted.data.session.lineTakes['02_bob'].recorder.color, 'pink');
});

test('profiles cannot change during playback', async (t) => {
  const host = await startFixtureRuntime(t);
  const { session } = await host.select();
  const player = await host.join(session, 'Solo');
  await host.admin('/api/admin/open-lobby', {});
  for (const character of ['Alice', 'Bob', 'Cara', 'Narrator']) await host.admin('/api/admin/assign', { character, playerId: player.id });
  await host.admin('/api/admin/start', {});
  for (const line of ['01_alice', '02_bob', '03_cara', '04_alice', '05_bob', '06_cara', '07_narrator']) {
    const up = await host.upload(player, line);
    assert.equal((await host.accept(player, line, up.data.session.lineTakes[line].id)).status, 200);
  }
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 200);
  const blocked = await host.request('/api/player/profile', { method: 'POST', token: player.token, body: { color: 'pink' } });
  assert.equal(blocked.status, 409);
});
