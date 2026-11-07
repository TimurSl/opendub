import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRules, validateRules } from '../server/session/rules.js';
import { startFixtureRuntime } from './helpers.js';

const settings = (extra = {}) => ({
  gameMode: 'character', freeRolePicking: true, allowMultipleRoles: true, maxRolesPerPlayer: 0, autoBalanceSuggestions: true,
  lockRolesWhenReady: true, referencePlaybackEnabled: true, voiceEffectsEnabled: true, compactMobilePreferred: false, ...extra,
});

test('validateRules accepts defaults and rejects unknown keys, bad modes and out-of-range values', () => {
  assert.deepEqual(validateRules({}), defaultRules());
  assert.deepEqual(validateRules({ takeLimit: 2, mode: 'line' }), { mode: 'line', takeLimit: 2, allowPlayerRetakes: true, blind: { caption: false, reference: false, scene: false, share: 1 } });
  assert.deepEqual(validateRules({ blind: { caption: true, share: 0.5 } }).blind, { caption: true, reference: false, scene: false, share: 0.5 });
  for (const bad of [{ mode: 'duet' }, { takeLimit: -1 }, { takeLimit: 21 }, { takeLimit: 1.5 }, { takeLimit: '1' }, { allowPlayerRetakes: 1 }, { blind: null }, { blind: [] }, { blind: { caption: 'yes' } }, { blind: { share: 2 } }, { blind: { share: -0.1 } }, { blind: { share: NaN } }, { blind: { share: '1' } }, { blind: { surprise: true } }, { cards: {} }]) {
    assert.throws(() => validateRules(bad), { status: 400 }, JSON.stringify(bad));
  }
  assert.throws(() => validateRules(null), { status: 400 });
  assert.throws(() => validateRules([]), { status: 400 });
});

async function startMatch(t, rules) {
  const host = await startFixtureRuntime(t);
  const { session } = await host.select();
  const player = await host.join(session, 'Solo');
  const saved = await host.admin('/api/admin/settings', settings({ rules }));
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  await host.admin('/api/admin/open-lobby', {});
  for (const character of ['Alice', 'Bob', 'Cara', 'Narrator']) await host.admin('/api/admin/assign', { character, playerId: player.id });
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  return { host, player, session: saved.data.session };
}

test('rules are part of the snapshot, gameMode mirrors rules.mode, and setup locks when roles open', async (t) => {
  const host = await startFixtureRuntime(t);
  await host.select();
  let result = await host.admin('/api/admin/settings', settings({ gameMode: 'character', rules: { mode: 'line', takeLimit: 3 } }));
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.session.rules.mode, 'line');
  assert.equal(result.data.session.settings.gameMode, 'line', 'rules.mode wins and gameMode is its alias');
  result = await host.admin('/api/admin/settings', settings({ gameMode: 'character' }));
  assert.equal(result.data.session.rules.mode, 'character');
  assert.equal(result.data.session.rules.takeLimit, 3, 'omitting rules keeps them');
  assert.equal((await host.admin('/api/admin/settings', settings({ rules: { takeLimit: 99 } }))).status, 400);
  assert.equal((await host.admin('/api/admin/settings', settings({ rules: { surprise: true } }))).status, 400);
  await host.admin('/api/admin/open-lobby', {});
  const locked = await host.admin('/api/admin/settings', settings({ rules: { takeLimit: 1 } }));
  assert.equal(locked.status, 409);
});

test('take limit is enforced by the server for direct API uploads, and a host retake starts a fresh count', async (t) => {
  const { host, player } = await startMatch(t, { takeLimit: 1 });
  const first = await host.upload(player, '01_alice');
  assert.equal(first.status, 200);
  assert.equal(first.data.session.takesUsed['01_alice'], 1);
  const second = await host.upload(player, '01_alice', { matchId: undefined });
  assert.equal(second.status, 409);
  assert.match(second.data.error, /take limit/i);
  const take = first.data.session.lineTakes['01_alice'];
  const discard = await host.request('/api/takes/01_alice/discard', { method: 'POST', token: player.token, body: { takeId: take.id, matchId: first.data.session.matchId } });
  assert.equal(discard.status, 409, 'discarding cannot be used to dodge the limit');
  assert.equal((await host.accept(player, '01_alice', take.id)).status, 200);
  const retake = await host.request('/api/takes/01_alice/retake', { method: 'POST', token: player.token, body: { matchId: first.data.session.matchId } });
  assert.equal(retake.status, 409);
  // Other lines have their own budget.
  assert.equal((await host.upload(player, '02_bob')).status, 200);
  // The host can grant a fresh take.
  assert.equal((await host.admin('/api/admin/retake', { lineId: '01_alice' })).status, 200);
  assert.equal((await host.upload(player, '01_alice')).status, 200);
});

test('unlimited take limit allows re-recording, and a limit of 2 allows exactly two uploads', async (t) => {
  const unlimited = await startMatch(t, { takeLimit: 0 });
  for (let index = 0; index < 4; index++) assert.equal((await unlimited.host.upload(unlimited.player, '01_alice')).status, 200);
  const two = await startMatch(t, { takeLimit: 2 });
  assert.equal((await two.host.upload(two.player, '01_alice')).status, 200);
  assert.equal((await two.host.upload(two.player, '01_alice')).status, 200);
  assert.equal((await two.host.upload(two.player, '01_alice')).status, 409);
});

test('allowPlayerRetakes=false blocks player retakes but not host retakes', async (t) => {
  const { host, player } = await startMatch(t, { allowPlayerRetakes: false });
  const up = await host.upload(player, '01_alice');
  const take = up.data.session.lineTakes['01_alice'];
  assert.equal((await host.accept(player, '01_alice', take.id)).status, 200);
  const retake = await host.request('/api/takes/01_alice/retake', { method: 'POST', token: player.token, body: { matchId: up.data.session.matchId } });
  assert.equal(retake.status, 403);
  assert.equal((await host.admin('/api/admin/retake', { lineId: '01_alice' })).status, 200);
});
