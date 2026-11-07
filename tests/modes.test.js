import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureRuntime, matchSettings, connectPlayer, playerPost, fixtureLines } from './helpers.js';
import { compileAssignments } from '../server/session/modes.js';

const pack = lines => ({ characters: [...new Set(lines.map(line => line.character))], lines: lines.map(line => ({ id: line.id, character: line.character })) });
const FIXTURE = pack(fixtureLines.map(line => ({ id: line.id, character: line.character })));
const counts = (assignments, ids) => ids.map(id => Object.values(assignments).filter(owner => owner === id).length);
const bigPack = pack(Array.from({ length: 60 }, (_, index) => ({ id: `l${String(index).padStart(2, '0')}`, character: ['Ann', 'Ben', 'Cy', 'Di', 'Eve'][index % 5] })));

test('compileAssignments gives every line an owner for every mode and keeps load balanced', () => {
  const ids = ['a', 'b', 'c'];
  for (const [mode, settings] of [['line', { random: () => 0.3 }], ['duet', {}], ['relay', { relayEvery: 2 }]]) {
    for (const source of [FIXTURE, bigPack]) {
      const result = compileAssignments(mode, source, ids, settings);
      assert.equal(Object.keys(result).length, source.lines.length, mode);
      assert.ok(Object.values(result).every(owner => ids.includes(owner)), mode);
    }
  }
  const line = compileAssignments('line', bigPack, ids, { random: () => 0.5 });
  const spread = counts(line, ids); assert.ok(Math.max(...spread) - Math.min(...spread) <= 1, 'line: counts differ by at most one');
  const relay = compileAssignments('relay', bigPack, ids, { relayEvery: 3 });
  const relaySpread = counts(relay, ids); assert.ok(Math.max(...relaySpread) - Math.min(...relaySpread) <= 3, 'relay: totals stay within one hand-over');
  assert.throws(() => compileAssignments('line', FIXTURE, []), { status: 409 });
  assert.throws(() => compileAssignments('character', FIXTURE, ids), { status: 409 });
  assert.throws(() => compileAssignments('relay', FIXTURE, ids, { relayEvery: 0 }), { status: 400 });
});

test('duet pairs every character with two players whose lines alternate', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const result = compileAssignments('duet', bigPack, ids);
  for (const character of bigPack.characters) {
    const owners = bigPack.lines.filter(line => line.character === character).map(line => result[line.id]);
    assert.equal(new Set(owners).size, 2, `${character} has exactly two players`);
    owners.forEach((owner, index) => assert.equal(owner, owners[index % 2], `${character} alternates`));
  }
  const spread = counts(result, ids);
  // Whole pairs are the unit, so the gap is at most half of one character's lines (12 / 2).
  assert.ok(Math.max(...spread) - Math.min(...spread) <= 6, 'players share the work');
  // One player alone still plays both halves of every duet.
  assert.deepEqual(new Set(Object.values(compileAssignments('duet', FIXTURE, ['solo']))), new Set(['solo']));
});

test('relay rotates a character through the players every N lines and never repeats a hand-over', () => {
  const ids = ['a', 'b', 'c'];
  for (const every of [1, 2, 3]) {
    const result = compileAssignments('relay', bigPack, ids, { relayEvery: every });
    for (const character of bigPack.characters) {
      const owners = bigPack.lines.filter(line => line.character === character).map(line => result[line.id]);
      const chunks = [];
      for (let index = 0; index < owners.length; index += every) {
        const chunk = owners.slice(index, index + every);
        assert.equal(new Set(chunk).size, 1, `${character}: a hand-over block has one owner`);
        chunks.push(chunk[0]);
      }
      chunks.forEach((owner, index) => { if (index) assert.notEqual(owner, chunks[index - 1], `${character}: the next block goes to someone else`); });
      if (chunks.length >= ids.length) assert.equal(new Set(chunks).size, ids.length, `${character}: everyone voices it`);
    }
  }
});

async function startLineMatch(t, rules, { players = ['Ada', 'Bo'], deal = true, start = true } = {}) {
  const host = await startFixtureRuntime(t);
  const { session } = await host.select();
  const saved = await host.admin('/api/admin/settings', matchSettings(rules));
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  await host.admin('/api/admin/open-lobby', {});
  const joined = [];
  for (const name of players) { const player = await host.join(session, name); await connectPlayer(host, player, t); joined.push(player); }
  if (deal) assert.equal((await host.admin('/api/admin/deal-lines', {})).status, 200);
  if (start) assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  return { host, players: joined, session: (await host.admin('/api/state')).data.session };
}
const lineOwner = (session, lineId) => session.lineAssignments[lineId];

test('duet and relay deal through deal-lines, show the table, and stay editable', async t => {
  const duet = await startLineMatch(t, { mode: 'duet' }, { start: false });
  assert.equal(duet.session.settings.assignmentStyle, 'line');
  const alice = ['01_alice', '04_alice'].map(id => lineOwner(duet.session, id));
  assert.notEqual(alice[0], alice[1], 'the two Alice lines are voiced by two players');
  const [, second] = duet.players;
  const moved = await duet.host.admin('/api/admin/assign-line', { lineId: '01_alice', playerId: second.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.session.lineAssignments['01_alice'], second.id);
  assert.equal((await duet.host.admin('/api/admin/start', {})).status, 200);

  const relay = await startLineMatch(t, { mode: 'relay', relayEvery: 1 });
  assert.equal(relay.session.rules.relayEvery, 1);
  const owners = ['02_bob', '05_bob'].map(id => lineOwner(relay.session, id));
  assert.notEqual(owners[0], owners[1], 'relay hands the character over after every line');
  const state = await relay.host.request('/api/state', { token: relay.players[0].token });
  assert.deepEqual(state.data.queue.lines, [...state.data.queue.lines].sort((a, b) => fixtureLines.findIndex(line => line.id === a) - fixtureLines.findIndex(line => line.id === b)), 'queues stay chronological');
  // Ownership is enforced per line exactly like Line mode.
  const stranger = relay.players[1];
  const myLine = state.data.queue.lines[0];
  assert.equal((await relay.host.upload(stranger, myLine)).status, 403);
  assert.equal((await relay.host.upload(relay.players[0], myLine)).status, 200);
});

test('character assignment is unavailable in duet and relay', async t => {
  const { host, players } = await startLineMatch(t, { mode: 'duet' }, { start: false });
  assert.equal((await host.admin('/api/admin/assign', { character: 'Alice', playerId: players[0].id })).status, 409);
  assert.equal((await host.admin('/api/admin/distribute', {})).status, 409);
});

test('switching modes clears the compiled table', async t => {
  const { host } = await startLineMatch(t, { mode: 'duet' }, { start: false });
  const before = (await host.admin('/api/state')).data.session;
  assert.ok(Object.keys(before.lineAssignments).length > 0);
  // Setup is closed once roles open, so the table cannot be silently replaced.
  assert.equal((await host.admin('/api/admin/settings', matchSettings({ mode: 'relay' }))).status, 409);
});

test('speed rounds force one take, no retakes, and the server owns the clock', async t => {
  const { host, players, session } = await startLineMatch(t, { mode: 'line', speed: { enabled: true, lineTimeLimitSec: 5 } });
  assert.equal(session.rules.takeLimit, 1); assert.equal(session.rules.allowPlayerRetakes, false);
  const [ada, bo] = players;
  const mine = lineId => lineOwner(session, lineId) === ada.id;
  const adaLine = fixtureLines.find(line => mine(line.id)).id;
  const boLine = fixtureLines.find(line => lineOwner(session, line.id) === bo.id).id;

  assert.equal((await host.upload(ada, adaLine)).status, 409, 'recording before pressing START is refused');
  assert.equal((await playerPost(host, ada, '/api/player/open-line', { lineId: boLine })).status, 403, 'a player cannot open someone else\'s line');
  const opened = await playerPost(host, ada, '/api/player/open-line', { lineId: adaLine });
  assert.equal(opened.status, 200);
  const clock = opened.data.session.lineClocks[adaLine];
  assert.ok(clock.deadline > clock.openedAt);
  const again = await playerPost(host, ada, '/api/player/open-line', { lineId: adaLine });
  assert.equal(again.data.session.lineClocks[adaLine].openedAt, clock.openedAt, 'reopening never resets the clock');
  const other = await host.request('/api/state', { token: bo.token });
  assert.equal(other.data.session.lineClocks[adaLine], undefined, 'other players do not see this clock');
  const admin = await host.admin('/api/state');
  assert.equal(admin.data.session.lineClocks[adaLine].playerId, ada.id);

  const up = await host.upload(ada, adaLine);
  assert.equal(up.status, 200);
  assert.equal((await host.upload(ada, adaLine, { })).status, 409, 'one take per line');
  assert.equal((await host.accept(ada, adaLine, up.data.session.lineTakes[adaLine].id)).status, 200);
  assert.equal((await playerPost(host, ada, '/api/takes/' + adaLine + '/retake', {})).status, 403, 'no player retakes in speed rounds');

  // A late take is refused, and the host can reopen the line.
  const late = fixtureLines.filter(line => lineOwner(session, line.id) === ada.id && line.id !== adaLine)[0]?.id;
  if (late) {
    assert.equal((await playerPost(host, ada, '/api/player/open-line', { lineId: late })).status, 200);
    host.runtime.sessionStore.data.lineClocks[late].deadline = Date.now() - 1;
    const refused = await host.upload(ada, late);
    assert.equal(refused.status, 409); assert.match(refused.data.error, /time is up/i);
    assert.equal((await host.admin('/api/admin/retake', { lineId: late })).status, 200);
    const reopened = await playerPost(host, ada, '/api/player/open-line', { lineId: late });
    assert.equal(reopened.status, 200);
    assert.equal((await host.upload(ada, late)).status, 200);
  }
});

test('open-line is refused when speed rounds are off', async t => {
  const { host, players, session } = await startLineMatch(t, { mode: 'line' });
  const line = fixtureLines.find(item => lineOwner(session, item.id) === players[0].id).id;
  assert.equal((await playerPost(host, players[0], '/api/player/open-line', { lineId: line })).status, 409);
  assert.deepEqual((await host.request('/api/state', { token: players[0].token })).data.session.lineClocks, {});
});

test('mystery hides characters and owners from other players until the reveal', async t => {
  const { host, players, session } = await startLineMatch(t, { mode: 'line', mystery: true });
  const [ada, bo] = players;
  const adaLines = fixtureLines.filter(line => lineOwner(session, line.id) === ada.id).map(line => line.id);
  const boLines = fixtureLines.filter(line => lineOwner(session, line.id) === bo.id).map(line => line.id);
  assert.ok(adaLines.length && boLines.length);
  for (const id of adaLines) { const up = await host.upload(ada, id); assert.equal((await host.accept(ada, id, up.data.session.lineTakes[id].id)).status, 200); }
  for (const id of boLines) { const up = await host.upload(bo, id); assert.equal((await host.accept(bo, id, up.data.session.lineTakes[id].id)).status, 200); }

  const view = (await host.request('/api/state', { token: ada.token })).data;
  const seen = view.session;
  assert.deepEqual(Object.keys(seen.lineAssignments).sort(), [...adaLines].sort(), 'only my own assignments');
  for (const line of seen.pack.lines) {
    if (adaLines.includes(line.id)) assert.notEqual(line.character, '???');
    else { assert.equal(line.character, '???'); assert.ok(line.segments.every(segment => segment.character === '???')); }
  }
  for (const id of boLines) { const take = seen.lineTakes[id]; assert.equal(take.playerId, null); assert.equal(take.recorder, null); assert.equal(take.character, '???'); }
  for (const id of adaLines) assert.equal(seen.lineTakes[id].playerId, ada.id);
  assert.ok(seen.players.every(player => player.assignedCharacters.length === 0));
  assert.deepEqual(seen.roleAssignments, {});
  const text = JSON.stringify(seen);
  for (const line of fixtureLines.filter(item => boLines.includes(item.id))) assert.equal(text.includes(`"character":"${line.character}"`) && !adaLines.some(id => fixtureLines.find(item => item.id === id).character === line.character), false, 'no hidden character name appears');
  assert.equal(seen.secretsActive, true);

  const admin = (await host.admin('/api/state')).data.session;
  assert.equal(admin.lineAssignments[boLines[0]], bo.id, 'the host sees everything');

  assert.equal((await host.admin('/api/admin/review', {})).status, 200);
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 409, 'playback waits for the reveal');
  host.runtime.sessionStore.data.options.exportAccess = 'players';
  assert.equal((await host.request('/exports/takes.zip', { token: ada.token })).status, 403, 'file names would give the owners away');
  assert.equal((await host.admin('/api/admin/reveal', {})).status, 200);
  const revealed = (await host.request('/api/state', { token: ada.token })).data.session;
  assert.equal(revealed.lineAssignments[boLines[0]], bo.id);
  assert.notEqual(revealed.pack.lines.find(line => line.id === boLines[0]).character, '???');
  assert.equal(revealed.lineTakes[boLines[0]].playerId, bo.id);
  assert.equal(revealed.lineTakes[boLines[0]].recorder.id, bo.id);
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 200);
});

test('mystery needs a line-based mode', async t => {
  const host = await startFixtureRuntime(t);
  await host.select();
  const result = await host.admin('/api/admin/settings', matchSettings({ mode: 'character', mystery: true }));
  assert.equal(result.status, 400);
});
