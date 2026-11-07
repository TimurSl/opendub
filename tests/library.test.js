import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createRuntime } from '../server/index.js';
import { Library, validateManifest } from '../server/library.js';
import { startFixtureRuntime, webmBytes } from './helpers.js';

const LINES = ['01_alice', '02_bob', '03_cara', '04_alice', '05_bob', '06_cara', '07_narrator'];
const settings = (extra = {}) => ({
  gameMode: 'character', freeRolePicking: true, allowMultipleRoles: true, maxRolesPerPlayer: 0, autoBalanceSuggestions: true,
  lockRolesWhenReady: true, referencePlaybackEnabled: true, voiceEffectsEnabled: true, compactMobilePreferred: false, ...extra,
});

async function recordAll(host, player, lines = LINES) {
  for (const line of lines) {
    const up = await host.upload(player, line);
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal((await host.accept(player, line, up.data.session.lineTakes[line].id)).status, 200);
  }
}
async function setup(t, options = {}) {
  const host = await startFixtureRuntime(t, options);
  const { session } = await host.select();
  const player = await host.join(session, 'Solo', { color: 'blue', avatar: 'owl' });
  await host.admin('/api/admin/open-lobby', {});
  for (const character of ['Alice', 'Bob', 'Cara', 'Narrator']) await host.admin('/api/admin/assign', { character, playerId: player.id });
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  return { host, player };
}
const waitFor = async (check, label) => {
  for (let index = 0; index < 100; index++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('timed out waiting for ' + label);
};
async function reopen(host, t, extra = {}) {
  await host.stop();
  const runtime = await createRuntime({ ...host.runtimeOptions, ...extra });
  const address = await runtime.start();
  const base = `http://127.0.0.1:${(typeof address === 'object' && address ? address : runtime.server.address()).port}`;
  t.after(() => runtime.close());
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${host.adminToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const textBody = await response.text(); let data; try { data = JSON.parse(textBody); } catch { data = textBody; }
    return { status: response.status, data, response };
  };
  return { runtime, request, base };
}

test('a match is saved to the library automatically when it reaches review, with the recorder profile and no credentials', async (t) => {
  const { host, player } = await setup(t);
  assert.deepEqual((await host.admin('/api/library')).data.entries, []);
  await recordAll(host, player);
  const { entries } = (await host.admin('/api/library')).data;
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.takeCount, 7);
  assert.equal(entry.incomplete, false);
  assert.match(entry.title, /^Synthetic pack – тест · \d{4}-\d{2}-\d{2}$/);
  const full = (await host.admin('/api/library/' + entry.id)).data;
  assert.equal(full.version, 1);
  assert.equal(full.lines.length, 7);
  assert.deepEqual(full.players, [{ id: player.id, nickname: 'Solo', color: 'blue', avatar: 'owl' }]);
  assert.equal(full.lines[0].take.recorder.nickname, 'Solo');
  assert.ok(full.replay.replayable);
  assert.equal(JSON.stringify(full).includes(player.token), false, 'no player credentials in the manifest');
  assert.equal(JSON.stringify(full).includes(host.dataDir), false, 'no disk paths in API output');
  const take = await host.request(full.lines[0].take.url, { token: host.adminToken });
  assert.equal(take.status, 200);
  assert.equal(Buffer.from(take.data).length > 0 || typeof take.data === 'string', true);
});

test('partial matches abandoned during recording are not saved', async (t) => {
  const { host, player } = await setup(t);
  await recordAll(host, player, LINES.slice(0, 3));
  assert.deepEqual((await host.admin('/api/library')).data.entries, []);
});

test('the library survives a restart while live takes are still wiped', async (t) => {
  const { host, player } = await setup(t);
  await recordAll(host, player);
  const [entry] = (await host.admin('/api/library')).data.entries;
  const liveTakes = await readdir(path.join(host.dataDir, 'takes'));
  assert.equal(liveTakes.length, 7);
  const next = await reopen(host, t);
  assert.deepEqual(await readdir(path.join(host.dataDir, 'takes')), []);
  const listed = await next.request('/api/library');
  assert.equal(listed.data.entries.length, 1);
  assert.equal(listed.data.entries[0].id, entry.id);
  const full = await next.request('/api/library/' + entry.id);
  const media = await fetch(next.base + full.data.lines[0].take.url, { headers: { Authorization: `Bearer ${host.adminToken}` } });
  assert.equal(media.status, 200);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), webmBytes);
});

test('Next match keeps the saved dub and its takes even though the live takes are deleted', async (t) => {
  const { host, player } = await setup(t);
  await recordAll(host, player);
  const [entry] = (await host.admin('/api/library')).data.entries;
  assert.equal((await host.admin('/api/admin/next-match', {})).status, 200);
  assert.deepEqual(await readdir(path.join(host.dataDir, 'takes')), []);
  const full = (await host.admin('/api/library/' + entry.id)).data;
  const media = await host.request(full.lines[3].take.url, { token: host.adminToken });
  assert.equal(media.status, 200);
  assert.equal((await host.admin('/api/library')).data.entries.length, 1);
});

test('replacing a take after the first save updates the same entry (and not a duplicate)', async (t) => {
  const { host, player } = await setup(t);
  await recordAll(host, player);
  const [entry] = (await host.admin('/api/library')).data.entries;
  const before = (await host.admin('/api/library/' + entry.id)).data.lines[0].take.srcId;
  // Host retake sends the match back to recording; the new take must replace the saved one.
  assert.equal((await host.admin('/api/admin/retake', { lineId: '01_alice' })).status, 200);
  await recordAll(host, player, ['01_alice']);
  const entries = (await waitFor(async () => { const data = (await host.admin('/api/library')).data; return data.entries[0]?.updatedAt > entry.updatedAt && data; }, 'library update')).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, entry.id);
  const after = (await host.admin('/api/library/' + entry.id)).data.lines[0].take.srcId;
  assert.notEqual(after, before);
});

test('rename, star and delete are admin-only; players are blocked unless the host shares the library', async (t) => {
  const { host, player } = await setup(t);
  await recordAll(host, player);
  const [entry] = (await host.admin('/api/library')).data.entries;
  const patch = (token, body) => host.request('/api/library/' + entry.id, { method: 'PATCH', token, body });
  assert.equal((await patch(player.token, { title: 'Hacked' })).status, 403);
  assert.equal((await host.request('/api/library', { token: player.token })).status, 403);
  assert.equal((await patch(host.adminToken, { title: '   ' })).status, 400);
  assert.equal((await patch(host.adminToken, { title: 'x'.repeat(201) })).status, 400);
  assert.equal((await patch(host.adminToken, { surprise: 1 })).status, 400);
  const renamed = await patch(host.adminToken, { title: 'Movie night', starred: true });
  assert.equal(renamed.status, 200);
  assert.deepEqual([renamed.data.title, renamed.data.starred], ['Movie night', true]);
  // Sharing can be switched on mid-match, even though the rest of setup is locked.
  assert.equal((await host.admin('/api/admin/settings', settings({ libraryVisibleToPlayers: true }))).status, 200);
  assert.equal((await host.admin('/api/admin/settings', settings({ maxRolesPerPlayer: 2, libraryVisibleToPlayers: true }))).status, 409, 'other settings stay locked');
  const shared = await host.request('/api/library', { token: player.token });
  assert.equal(shared.status, 200);
  assert.equal(shared.data.entries.length, 1);
  assert.equal((await host.request('/api/library/' + entry.id, { token: player.token })).status, 200);
  assert.equal((await host.request('/library-media/' + entry.id + '/line-0.media', { token: player.token })).status, 200);
  assert.equal((await host.request('/api/library/' + entry.id, { method: 'DELETE', token: player.token })).status, 403);
  assert.equal((await host.request('/api/library/' + entry.id, { method: 'DELETE', token: host.adminToken })).status, 200);
  assert.equal((await host.admin('/api/library')).data.entries.length, 0);
  assert.equal((await host.admin('/api/library/' + entry.id)).status, 404);
});

test('library media only serves manifest-listed files and rejects traversal', async (t) => {
  const { host, player } = await setup(t);
  await recordAll(host, player);
  const [entry] = (await host.admin('/api/library')).data.entries;
  const full = (await host.admin('/api/library/' + entry.id)).data;
  for (const bad of ['manifest.json', '..%2Fmanifest.json', '..%2F..%2Fadmin-token', '%2e%2e%2fmanifest.json', 'line-99.media', 'takes%2Fline-0.media', 'thumb.jpg', 'export.mp4']) {
    const result = await host.request(`/library-media/${entry.id}/${bad}`, { token: host.adminToken });
    assert.ok([400, 404].includes(result.status), `${bad} -> ${result.status}`);
  }
  assert.equal((await host.request('/library-media/..%2F..%2F/x', { token: host.adminToken })).status, 404);
  assert.equal((await host.request('/api/library/..%2Fetc', { token: host.adminToken })).status, 404);
  assert.equal((await host.request(full.lines[0].take.url)).status, 401);
  assert.equal((await host.request(full.lines[0].take.url, { token: player.token })).status, 403);
  const ranged = await fetch(host.base + full.lines[0].take.url, { headers: { Authorization: `Bearer ${host.adminToken}`, Range: 'bytes=0-3' } });
  assert.equal(ranged.status, 206, 'range requests are supported');
});

test('a pack that was changed or removed blocks replay but keeps the takes downloadable', async (t) => {
  const { host, player } = await setup(t);
  await recordAll(host, player);
  const [entry] = (await host.admin('/api/library')).data.entries;
  assert.equal((await host.admin('/api/library/' + entry.id)).data.replay.replayable, true);
  await writeFile(path.join(host.packDir, '01_alice.ini'), '[data]\ncaption="Changed caption"\ndub_timestamps=[0.1]\ndub_ends=[0.5]\ndub_characters=["Alice"]\n');
  await host.admin('/api/admin/packs'); // rediscover the pack
  const changed = (await host.admin('/api/library/' + entry.id)).data;
  assert.equal(changed.replay.replayable, false);
  assert.match(changed.replay.reason, /differs/);
  assert.equal((await host.request(changed.replay.videoUrl, { token: host.adminToken })).status, 409);
  assert.equal((await host.request(changed.lines[0].take.url, { token: host.adminToken })).status, 200);
  await rm(host.packDir, { recursive: true, force: true });
  await host.admin('/api/admin/packs');
  const missing = (await host.admin('/api/library/' + entry.id)).data;
  assert.match(missing.replay.reason, /missing/i);
});

test('damaged and malicious manifests are listed as damaged and never served', async (t) => {
  const { host, player } = await setup(t);
  await recordAll(host, player);
  const [entry] = (await host.admin('/api/library')).data.entries;
  const libraryDir = path.join(host.dataDir, 'library');
  const manifestPath = path.join(libraryDir, entry.id, 'manifest.json');
  const good = JSON.parse(await readFile(manifestPath, 'utf8'));
  // A hand-edited manifest naming a path outside the entry.
  const evil = structuredClone(good); evil.lines[0].take.file = '../../manifest.json';
  await writeFile(manifestPath, JSON.stringify(evil));
  await mkdir(path.join(libraryDir, 'brokenentry1'), { recursive: true });
  await writeFile(path.join(libraryDir, 'brokenentry1', 'manifest.json'), '{not json');
  await mkdir(path.join(libraryDir, 'not a valid id'), { recursive: true });
  const next = await reopen(host, t);
  const listed = (await next.request('/api/library')).data.entries;
  assert.equal(listed.length, 2);
  assert.ok(listed.every(item => item.damaged));
  assert.equal((await next.request('/api/library/' + entry.id)).status, 409);
  assert.equal((await next.request(`/library-media/${entry.id}/line-0.media`)).status, 404);
  assert.throws(() => validateManifest(evil, entry.id), /take/);
  assert.throws(() => validateManifest({ ...good, id: 'other-id-1234' }, entry.id), /id/);
  assert.throws(() => validateManifest({ ...good, version: 2 }, entry.id), /version/);
  assert.throws(() => validateManifest({ ...good, lines: 'x' }, entry.id), /lines/);
  assert.doesNotThrow(() => validateManifest(good, entry.id));
});

test('a missing take file marks an entry damaged instead of serving a broken dub', async (t) => {
  const { host, player } = await setup(t);
  await recordAll(host, player);
  const [entry] = (await host.admin('/api/library')).data.entries;
  await rm(path.join(host.dataDir, 'library', entry.id, 'takes', 'line-2.media'));
  const next = await reopen(host, t);
  assert.equal((await next.request('/api/library')).data.entries[0].damaged, true);
});

test('retention prunes the oldest unstarred entries and never starred ones', async (t) => {
  const dir = path.join(path.dirname(await (async () => { const h = await startFixtureRuntime(t); return h.dataDir; })()), 'retention');
  const library = await new Library({ dir, enabled: true, maxEntries: 2, maxBytes: Infinity }).init();
  const make = async (index, starred) => {
    const id = `entry-${String(index).padStart(8, '0')}`;
    const directory = path.join(dir, id, 'takes'); await mkdir(directory, { recursive: true });
    const manifest = { id, version: 1, createdAt: index, updatedAt: index, title: 'T' + index, pack: { id: 'p', title: 't', language: 'ENG', fingerprint: 'f' }, rules: {}, players: [], lines: [], starred };
    await writeFile(path.join(dir, id, 'manifest.json'), JSON.stringify(manifest));
    library.entries.set(id, { manifest, damaged: false, size: 10 });
    return id;
  };
  const first = await make(1, true);
  await make(2, false); await make(3, false); await make(4, false);
  await library.prune();
  const remaining = library.list().map(entry => entry.title).sort();
  assert.deepEqual(remaining, ['T1', 'T4'], 'starred T1 stays; the oldest unstarred go first');
  await assert.rejects(access(path.join(dir, 'entry-00000002')), { code: 'ENOENT' });
  await access(path.join(dir, first));
  // The byte limit works the same way, and an all-starred library may exceed it.
  library.maxEntries = 100; library.maxBytes = 5;
  await library.prune();
  assert.deepEqual(library.list().map(entry => entry.title), ['T1']);
});

test('LIBRARY=off disables saving entirely', async (t) => {
  const { host, player } = await setup(t, { library: 'off' });
  await recordAll(host, player);
  const result = await host.admin('/api/library');
  assert.equal(result.status, 404);
  await assert.rejects(access(path.join(host.dataDir, 'library', 'x')), { code: 'ENOENT' });
});

test('symlinked take files inside an entry cannot escape the entry directory', async (t) => {
  const { host, player } = await setup(t);
  await recordAll(host, player);
  const [entry] = (await host.admin('/api/library')).data.entries;
  const secret = path.join(host.root, 'secret.txt'); await writeFile(secret, 'top secret');
  const takePath = path.join(host.dataDir, 'library', entry.id, 'takes', 'line-0.media');
  await rm(takePath); await symlink(secret, takePath);
  const full = (await host.admin('/api/library/' + entry.id)).data;
  const result = await host.request(full.lines[0].take.url, { token: host.adminToken });
  assert.equal(result.status, 404);
});
