import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../server/session/store.js';
import { roleView } from '../web/player/view-state.js';
import { currentStage, reconcileStage } from '../web/admin/stage.js';

const pack = {
  id: 'pack-one', metadata: { title: 'Example' },
  characters: ['Alice', 'Bob'], characterLineCounts: [1, 1],
  lines: [{ id: 'line-a', character: 'Alice' }, { id: 'line-b', character: 'Bob' }],
};

function view(state, overrides = {}) {
  return roleView({ state, hasPack: true, lineMode: false, hasTasks: false,
    prepared: false, incomplete: true, rolesLocked: false, ...overrides });
}

test('clients can see and take roles immediately after pack selection, without host distribution', async () => {
  const store = new SessionStore({ packs: [pack], dataDir: '/unused' });
  await store.mutate(() => store.createParty());
  const partyId = store.data.id, joinToken = store.data.joinToken;
  const player = await store.mutate(() => store.join({ roomId: partyId, joinToken, nickname: 'Tester' }));
  assert.equal(view('lobby', { hasPack: false }).showRoles, false);
  await store.mutate(() => store.select(pack.id, partyId));
  const snapshot = store.snapshot({ kind: 'player', playerId: player.id });
  assert.equal(snapshot.session.state, 'lobby');
  assert.equal(view('lobby').showRoles, true);
  assert.equal(view('lobby').canPick, true);
  assert.equal(view('lobby').canReady, false);
  const revision = store.revision;
  await store.mutate(() => store.claimRole('Alice', player.id));
  assert.ok(store.revision > revision);
  assert.deepEqual(store.queue(player.id).assignedCharacters, ['Alice']);
  await store.mutate(() => store.releaseRole('Alice', player.id));
  assert.deepEqual(store.queue(player.id).assignedCharacters, []);
  await store.mutate(() => store.openLobby());
  assert.equal(view('assignment').showRoles, true, 'unassigned player must still see the choices');
  assert.equal(view('assignment').canPick, true);
  assert.equal(view('assignment').canReady, false);
  await store.mutate(() => store.claimRole('Bob', player.id));
  assert.equal(view('assignment', { hasTasks: true }).canReady, true);
});

test('host-controlled character picking and line mode respect visibility and permissions', async () => {
  const store = new SessionStore({ packs: [pack], dataDir: '/unused' });
  await store.mutate(() => store.createParty());
  const partyId = store.data.id, joinToken = store.data.joinToken;
  const player = await store.mutate(() => store.join({ roomId: partyId, joinToken, nickname: 'Tester' }));
  await store.mutate(() => store.select(pack.id, partyId));
  await store.mutate(() => store.configure({ ...store.data.options, freeRolePicking: false }));
  await assert.rejects(store.mutate(() => store.claimRole('Bob', player.id)), { status: 403 });
  await store.mutate(() => store.configure({ ...store.data.options, freeRolePicking: true }));
  await store.mutate(() => store.claimRole('Alice', player.id));
  await store.mutate(() => store.configure({ ...store.data.options, gameMode: 'line' }));
  assert.deepEqual(Object.keys(store.snapshot({ kind: 'admin' }).session.roleAssignments), []);
  assert.equal(view('lobby', { lineMode: true }).showRoles, false);
  assert.equal(view('assignment', { lineMode: true, hasTasks: false }).showRoles, false);
  assert.equal(view('assignment', { lineMode: true, hasTasks: true }).showRoles, true);
  await store.mutate(() => store.configure({ ...store.data.options, gameMode: 'character' }));
  assert.deepEqual(store.queue(player.id).assignedCharacters, []);
  assert.equal(view('assignment', { rolesLocked: true }).canPick, false);
});

test('admin moves with the phase while preserving manual navigation within a phase', () => {
  const party = { partyCreated: true, pack: null, state: 'lobby' };
  assert.equal(currentStage(party), 1);
  assert.equal(currentStage({ ...party, pack }), 2);
  assert.equal(currentStage({ ...party, pack, state: 'assignment' }), 3);
  assert.equal(currentStage({ ...party, pack, state: 'recording' }), 4);
  assert.equal(currentStage({ ...party, pack, state: 'review' }), 5);
  assert.equal(currentStage({ ...party, pack, state: 'playback' }), 6);
  assert.equal(reconcileStage(1, 2, 2, false), 1, 'manual back navigation stays put on player join');
  assert.equal(reconcileStage(1, 2, 3, false), null, 'open lobby advances host automatically');
  assert.equal(reconcileStage(3, 3, 4, false), null, 'start recording advances host automatically');
  assert.equal(reconcileStage(4, 4, 3, false), null, 'reopen roles sends host back');
  assert.equal(reconcileStage(2, 2, 2, true), null, 'a new match overrides remembered navigation');
  assert.equal(reconcileStage(6, 3, 3, false), null, 'future stages are never sticky');
});

test('presence updates advance revision before broadcasting to clients', async () => {
  const store = new SessionStore({ packs: [pack], dataDir: '/unused' });
  await store.mutate(() => store.createParty());
  const player = await store.mutate(() => store.join({ roomId: store.data.id, joinToken: store.data.joinToken, nickname: 'Tester' }));
  const revision = store.revision;
  let broadcasts = 0;
  store.on('change', () => broadcasts++);
  await store.presence(player.id, 1);
  assert.equal(store.revision, revision + 1);
  assert.equal(broadcasts, 1);
  assert.equal(store.snapshot({ kind: 'admin' }).session.players[0].connected, true);
});
