import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureRuntime, addFixturePack, matchSettings, fixtureLines } from './helpers.js';

async function startParty(t) {
  const host = await startFixtureRuntime(t);
  await addFixturePack(host.workshopDir, 'second-pack', fixtureLines.slice(0, 3));
  await addFixturePack(host.workshopDir, 'third-pack', fixtureLines.slice(0, 2));
  const party = await host.admin('/api/admin/create-party', {});
  await host.admin('/api/admin/packs'); // rescans the workshop folder
  const session = party.data.session;
  const ada = await host.join(session, 'Ada', { avatar: 'fox' }); const bo = await host.join(session, 'Bo', { avatar: 'robot' });
  const packs = (await host.admin('/api/admin/packs')).data.packs.map(pack => pack.id);
  return { host, session, ada, bo, packs };
}
const vote = (host, player, packId, on = true) => host.request('/api/player/pack-vote', { method: 'POST', token: player.token, body: { packId, vote: on } });
const asPlayer = (host, player) => host.request('/api/state', { token: player.token });

test('players see the installed packs while the host is choosing, and the host sees who voted for which', async t => {
  const { host, ada, bo, packs } = await startParty(t);
  assert.equal(packs.length, 3);
  const view = (await asPlayer(host, ada)).data.session;
  assert.equal(view.packChoices.length, 3);
  assert.ok(view.packChoices.every(pack => pack.title && Number.isInteger(pack.lineCount) && Array.isArray(pack.characters)));
  assert.deepEqual(view.packVotes, {});

  assert.equal((await vote(host, ada, packs[1])).status, 200);
  assert.equal((await vote(host, bo, packs[1])).status, 200);
  const admin = (await host.admin('/api/state')).data.session;
  assert.deepEqual(admin.packVotes[packs[1]].voters, [ada.id, bo.id]);
  assert.equal(admin.packVotes[packs[1]].count, 2);
  const mine = (await asPlayer(host, ada)).data.session.packVotes[packs[1]];
  assert.equal(mine.count, 2); assert.equal(mine.mine, true);
});

test('each player has one vote: choosing another pack moves it, and it can be withdrawn', async t => {
  const { host, ada, bo, packs } = await startParty(t);
  await vote(host, ada, packs[0]); await vote(host, bo, packs[0]);
  await vote(host, ada, packs[2]);
  const moved = (await host.admin('/api/state')).data.session.packVotes;
  assert.equal(moved[packs[0]].count, 1); assert.deepEqual(moved[packs[0]].voters, [bo.id]);
  assert.deepEqual(moved[packs[2]].voters, [ada.id]);
  await vote(host, bo, packs[0], false);
  assert.equal((await host.admin('/api/state')).data.session.packVotes[packs[0]], undefined, 'a pack without votes disappears from the table');
});

test('votes are validated and limited to players in the lobby', async t => {
  const { host, ada, packs, session } = await startParty(t);
  assert.equal((await vote(host, ada, 'no-such-pack')).status, 404);
  assert.equal((await host.request('/api/player/pack-vote', { method: 'POST', token: ada.token, body: { packId: packs[0], vote: 'yes' } })).status, 400);
  assert.equal((await host.request('/api/player/pack-vote', { method: 'POST', token: ada.token, body: { packId: packs[0], vote: true, extra: 1 } })).status, 400);
  assert.equal((await host.request('/api/player/pack-vote', { method: 'POST', token: host.adminToken, body: { packId: packs[0], vote: true } })).status, 403, 'the host is not a voter');
  assert.equal((await host.request('/api/player/pack-vote', { method: 'POST', body: { packId: packs[0], vote: true } })).status, 401);
  await vote(host, ada, packs[0]);
  await host.admin('/api/admin/select', { packId: packs[0], partyId: session.id });
  const chosen = (await host.admin('/api/state')).data.session;
  assert.deepEqual(chosen.packVotes, {}, 'choosing a pack uses up the votes');
  await host.admin('/api/admin/settings', matchSettings());
  await host.admin('/api/admin/open-lobby', {});
  assert.deepEqual((await asPlayer(host, ada)).data.session.packChoices, [], 'the list closes once the match is set up');
  assert.equal((await vote(host, ada, packs[1])).status, 409);
});

test('voting also works before and after a match: votes start fresh for the next one', async t => {
  const { host, ada, packs, session } = await startParty(t);
  await host.admin('/api/admin/select', { packId: packs[0], partyId: session.id });
  assert.equal((await vote(host, ada, packs[1])).status, 200, 'the host may still be changing the pack');
  assert.equal((await asPlayer(host, ada)).data.session.packChoices.length, 3);
});

test('any party member can load pack icons, strangers cannot', async t => {
  const { host, ada, packs } = await startParty(t);
  const withIcon = (await host.admin('/api/admin/packs')).data.packs.find(pack => pack.iconUrl)?.id;
  assert.ok(withIcon, 'the fixture pack has an icon');
  assert.equal((await host.request(`/api/packs/${withIcon}/icon`, { token: ada.token })).status, 200);
  assert.equal((await host.request(`/api/packs/${withIcon}/icon`)).status, 401);
  assert.equal((await host.request(`/api/packs/${packs[0] === withIcon ? packs[1] : packs[0]}/icon`, { token: ada.token })).status, 404, 'a pack without an icon');
});
