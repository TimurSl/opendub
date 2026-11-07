import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile, readdir } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { startFixtureRuntime, webmBytes } from './helpers.js';

const LINES = ['01_alice', '02_bob', '03_cara', '04_alice', '05_bob', '06_cara', '07_narrator'];
const settings = (extra = {}) => ({
  gameMode: 'character', freeRolePicking: true, allowMultipleRoles: true, maxRolesPerPlayer: 0, autoBalanceSuggestions: true,
  lockRolesWhenReady: true, referencePlaybackEnabled: true, voiceEffectsEnabled: true, compactMobilePreferred: false, ...extra,
});

async function fakeFfmpeg(t, { sleep = 0, fail = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'open-dub-ffmpeg-'));
  const log = path.join(dir, 'calls.log');
  const script = path.join(dir, 'ffmpeg');
  await writeFile(script, `#!/bin/sh\necho "$@" >> ${log}\n${sleep ? `sleep ${sleep}\n` : ''}${fail ? 'echo boom >&2\nexit 1\n' : ''}for output do :; done\nprintf "fake render" > "$output"\n`);
  await chmod(script, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { script, // Render calls only: the library also asks FFmpeg for a thumbnail.
    calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(line => line.includes('-progress')) };
}

// Two players: Alice+Narrator vs Bob+Cara, so "mine.zip" has a clear owner.
async function twoPlayerMatch(t, ffmpegOptions = {}, runtimeOptions = {}) {
  const ffmpeg = await fakeFfmpeg(t, ffmpegOptions);
  const host = await startFixtureRuntime(t, { ffmpegPath: ffmpeg.script, ...runtimeOptions });
  const { session } = await host.select();
  const ada = await host.join(session, 'Ada Lovelace', { color: 'red' });
  const bo = await host.join(session, 'Bo', { color: 'blue' });
  await host.admin('/api/admin/open-lobby', {});
  for (const [character, player] of [['Alice', ada], ['Narrator', ada], ['Bob', bo], ['Cara', bo]]) await host.admin('/api/admin/assign', { character, playerId: player.id });
  await host.admin('/api/admin/start', {});
  const owner = { '01_alice': ada, '04_alice': ada, '07_narrator': ada, '02_bob': bo, '05_bob': bo, '03_cara': bo, '06_cara': bo };
  for (const line of LINES) {
    const up = await host.upload(owner[line], line);
    assert.equal((await host.accept(owner[line], line, up.data.session.lineTakes[line].id)).status, 200);
  }
  return { host, ada, bo, ffmpeg };
}
const post = (host, token, route, body) => host.request(route, { method: 'POST', token, body });
const waitFor = async (check, label) => { for (let i = 0; i < 200; i++) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } assert.fail('timed out: ' + label); };

// Minimal ZIP reader (store method) used to verify what the server streams.
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory');
  const count = buffer.readUInt16LE(end + 10); let pointer = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(pointer), 0x02014b50);
    const crc = buffer.readUInt32LE(pointer + 16); const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28); const local = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    assert.equal(crc32(data) >>> 0, crc, `crc of ${name}`);
    files.set(name, data); pointer += 46 + nameLength;
  }
  return files;
}
const download = async (host, route, token) => {
  const response = await fetch(host.base + route, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
};

test('export jobs: the host can start, watch and download an MP4 without holding the request open', async (t) => {
  const { host, ffmpeg } = await twoPlayerMatch(t, { sleep: 0.2 });
  const started = await post(host, host.adminToken, '/api/exports', { format: 'mp4' });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.ok(['queued', 'rendering'].includes(started.data.job.status));
  const ready = await waitFor(async () => (await host.admin('/api/state')).data.session.exports.find(job => job.id === started.data.jobId && job.status === 'ready'), 'job ready');
  assert.equal(ready.url, '/exports/' + started.data.jobId);
  assert.match(ready.filename, /\.mp4$/);
  const file = await download(host, ready.url, host.adminToken);
  assert.equal(file.status, 200);
  assert.equal(file.body.toString(), 'fake render');
  assert.equal(file.headers.get('content-type'), 'video/mp4');
  const [call] = await ffmpeg.calls();
  assert.match(call, /-progress pipe:1/);
  assert.match(call, /libx264/);
});

test('an identical export is reused, and force renders again', async (t) => {
  const { host, ffmpeg } = await twoPlayerMatch(t);
  const first = await post(host, host.adminToken, '/api/exports', { format: 'm4a' });
  await waitFor(async () => (await host.admin('/api/state')).data.session.exports.find(job => job.id === first.data.jobId && job.status === 'ready'), 'first');
  const second = await post(host, host.adminToken, '/api/exports', { format: 'm4a' });
  assert.equal(second.data.jobId, first.data.jobId);
  const forced = await post(host, host.adminToken, '/api/exports', { format: 'm4a', force: true });
  assert.notEqual(forced.data.jobId, first.data.jobId);
  await waitFor(async () => (await ffmpeg.calls()).length === 2, 'two renders');
});

test('m4a is an audio-only mix: no video input, no video codec', async (t) => {
  const { host, ffmpeg } = await twoPlayerMatch(t);
  const job = await post(host, host.adminToken, '/api/exports', { format: 'm4a' });
  const ready = await waitFor(async () => (await host.admin('/api/state')).data.session.exports.find(item => item.id === job.data.jobId && item.status === 'ready'), 'm4a');
  const [call] = await ffmpeg.calls();
  assert.doesNotMatch(call, /dub_video|libx264|-map 0:v/);
  assert.match(call, /-vn/);
  assert.match(call, /\.m4a$/);
  assert.equal((await download(host, ready.url, host.adminToken)).headers.get('content-type'), 'audio/mp4');
});

test('renders run one at a time; the rest queue and everyone sees them', async (t) => {
  const { host, ffmpeg } = await twoPlayerMatch(t, { sleep: 0.4 });
  const mp4 = await post(host, host.adminToken, '/api/exports', { format: 'mp4' });
  const m4a = await post(host, host.adminToken, '/api/exports', { format: 'm4a' });
  const states = (await host.admin('/api/state')).data.session.exports.map(job => job.status);
  assert.deepEqual(states.sort(), ['queued', 'rendering'].sort());
  await waitFor(async () => (await host.admin('/api/state')).data.session.exports.every(job => job.status === 'ready'), 'both ready');
  assert.equal((await ffmpeg.calls()).length, 2);
  assert.ok(mp4.data.jobId && m4a.data.jobId);
});

test('players get 403 until the host shares exports; access modes control who may export and download', async (t) => {
  const { host, ada, bo } = await twoPlayerMatch(t);
  const started = await post(host, host.adminToken, '/api/exports', { format: 'mp4' });
  const ready = await waitFor(async () => (await host.admin('/api/state')).data.session.exports.find(job => job.id === started.data.jobId && job.status === 'ready'), 'ready');
  // Default: host only.
  assert.equal((await post(host, ada.token, '/api/exports', { format: 'mp4' })).status, 403);
  assert.equal((await download(host, ready.url, ada.token)).status, 403);
  assert.equal((await download(host, '/exports/takes.zip', ada.token)).status, 403);
  assert.equal((await download(host, '/exports/mine.zip', ada.token)).status, 403);
  assert.deepEqual((await host.request('/api/state', { token: ada.token })).data.session.exports, []);
  assert.equal((await host.request('/api/state', { token: ada.token })).data.session.exportsAllowed, false);
  assert.equal((await download(host, ready.url, '')).status, 401);
  // After playback only.
  assert.equal((await host.admin('/api/admin/settings', settings({ exportAccess: 'players-after-playback' }))).status, 200);
  assert.equal((await download(host, ready.url, ada.token)).status, 403, 'review is not playback yet');
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 200);
  assert.equal((await download(host, ready.url, ada.token)).status, 200);
  assert.equal((await host.request('/api/state', { token: bo.token })).data.session.exports.length, 1);
  // Back to review keeps access for this match.
  await host.admin('/api/admin/stop-playback', {});
  assert.equal((await download(host, ready.url, bo.token)).status, 200);
  // Hosts can turn sharing off again.
  await host.admin('/api/admin/settings', settings({ exportAccess: 'host' }));
  assert.equal((await download(host, ready.url, bo.token)).status, 403);
  assert.equal((await host.admin('/api/admin/settings', settings({ exportAccess: 'everyone' }))).status, 400);
});

test('a shared player can start an export; it appears in everyone\'s snapshot', async (t) => {
  const { host, ada, bo } = await twoPlayerMatch(t);
  await host.admin('/api/admin/settings', settings({ exportAccess: 'players' }));
  const started = await post(host, ada.token, '/api/exports', { format: 'm4a' });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  await waitFor(async () => (await host.request('/api/state', { token: bo.token })).data.session.exports.find(job => job.status === 'ready'), 'visible to bo');
  assert.equal((await post(host, bo.token, '/api/exports', { format: 'nope' })).status, 400);
  assert.equal((await post(host, ada.token, '/api/exports', { format: 'm4a', force: true })).data.jobId, started.data.jobId, 'players cannot force a rerender');
});

test('exports are refused until review, and need accepted takes', async (t) => {
  const ffmpeg = await fakeFfmpeg(t);
  const host = await startFixtureRuntime(t, { ffmpegPath: ffmpeg.script });
  const { session } = await host.select();
  await host.join(session, 'Solo');
  assert.equal((await post(host, host.adminToken, '/api/exports', { format: 'mp4' })).status, 409);
});

test('a failed render reports its error in the job list without leaking work files', async (t) => {
  const { host } = await twoPlayerMatch(t, { fail: true });
  const started = await post(host, host.adminToken, '/api/exports', { format: 'mp4' });
  const failed = await waitFor(async () => (await host.admin('/api/state')).data.session.exports.find(job => job.id === started.data.jobId && job.status === 'failed'), 'failed');
  assert.match(failed.error, /boom|Export failed/);
  assert.equal(failed.url, null);
  const files = await readdir(path.join(host.dataDir, 'exports'));
  assert.deepEqual(files, []);
  const retry = await post(host, host.adminToken, '/api/exports', { format: 'mp4' });
  assert.notEqual(retry.data.jobId, started.data.jobId, 'a failed job is never reused');
});

test('a match change during a render never attaches the result to the new match', async (t) => {
  const { host } = await twoPlayerMatch(t, { sleep: 0.5 });
  const started = await post(host, host.adminToken, '/api/exports', { format: 'mp4' });
  await waitFor(async () => (await host.admin('/api/state')).data.session.exports[0]?.status === 'rendering', 'rendering');
  assert.equal((await host.admin('/api/admin/next-match', {})).status, 200);
  const job = await waitFor(async () => (await host.admin('/api/state')).data.session.exports.find(item => item.id === started.data.jobId && item.status === 'failed'), 'discarded');
  assert.match(job.error, /match changed/i);
  assert.equal(job.url, null);
  assert.deepEqual(await readdir(path.join(host.dataDir, 'exports')), []);
});

test('takes.zip contains exactly the accepted takes plus credits, with safe names', async (t) => {
  const { host } = await twoPlayerMatch(t);
  const zip = await download(host, '/exports/takes.zip', host.adminToken);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const files = readZip(zip.body);
  assert.deepEqual([...files.keys()].sort(), [
    '01_Alice_Ada_Lovelace.webm', '02_Bob_Bo.webm', '03_Cara_Bo.webm', '04_Alice_Ada_Lovelace.webm', '05_Bob_Bo.webm', '06_Cara_Bo.webm', '07_Narrator_Ada_Lovelace.webm', 'credits.txt',
  ]);
  assert.deepEqual(files.get('01_Alice_Ada_Lovelace.webm'), webmBytes);
  assert.match(files.get('credits.txt').toString(), /01\. Alice — Ada Lovelace/);
  assert.equal(JSON.stringify([...files.keys()]).includes('..'), false);
});

test('mine.zip contains only the requesting player\'s takes', async (t) => {
  const { host, ada, bo } = await twoPlayerMatch(t);
  await host.admin('/api/admin/settings', settings({ exportAccess: 'players' }));
  const mine = readZip((await download(host, '/exports/mine.zip', ada.token)).body);
  assert.deepEqual([...mine.keys()].filter(name => name !== 'credits.txt').sort(), ['01_Alice_Ada_Lovelace.webm', '04_Alice_Ada_Lovelace.webm', '07_Narrator_Ada_Lovelace.webm']);
  assert.doesNotMatch(mine.get('credits.txt').toString(), /Bo/);
  const theirs = readZip((await download(host, '/exports/mine.zip', bo.token)).body);
  assert.equal([...theirs.keys()].filter(name => name !== 'credits.txt').length, 4);
  assert.equal((await download(host, '/exports/mine.zip', host.adminToken)).status, 403, 'hosts have no personal takes');
});

test('a match render is kept in the library and reused; library takes.zip works after Next match', async (t) => {
  const { host } = await twoPlayerMatch(t);
  const started = await post(host, host.adminToken, '/api/exports', { format: 'mp4' });
  await waitFor(async () => (await host.admin('/api/state')).data.session.exports.find(job => job.id === started.data.jobId && job.status === 'ready'), 'ready');
  const [entry] = (await host.admin('/api/library')).data.entries;
  const full = await waitFor(async () => { const data = (await host.admin('/api/library/' + entry.id)).data; return data.exports['export.mp4'] && data; }, 'stored in library');
  assert.ok(full.exports['export.mp4']);
  await host.admin('/api/admin/next-match', {});
  const reuse = await post(host, host.adminToken, `/api/library/${entry.id}/export`, { format: 'mp4' });
  assert.equal(reuse.status, 200);
  assert.equal(reuse.data.ready, true);
  assert.equal((await download(host, reuse.data.url, host.adminToken)).body.toString(), 'fake render');
  const zip = readZip((await download(host, `/library-media/${entry.id}/takes.zip`, host.adminToken)).body);
  assert.equal(zip.size, 8);
  // M4A has no cached render yet: the library schedules a job from the saved takes.
  const m4a = await post(host, host.adminToken, `/api/library/${entry.id}/export`, { format: 'm4a' });
  assert.equal(m4a.data.ready, false);
  await waitFor(async () => (await host.admin('/api/library/' + entry.id)).data.exports['export.m4a'], 'm4a stored');
  assert.equal((await post(host, host.adminToken, `/api/library/${entry.id}/export`, { format: 'exe' })).status, 400);
  assert.equal((await post(host, host.adminToken, `/api/library/nonexistent1/export`, { format: 'mp4' })).status, 404);
});

test('changing a take removes the library\'s cached render so it is re-exported', async (t) => {
  const { host, ada } = await twoPlayerMatch(t);
  const started = await post(host, host.adminToken, '/api/exports', { format: 'mp4' });
  await waitFor(async () => (await host.admin('/api/state')).data.session.exports.find(job => job.id === started.data.jobId && job.status === 'ready'), 'ready');
  const [entry] = (await host.admin('/api/library')).data.entries;
  await waitFor(async () => (await host.admin('/api/library/' + entry.id)).data.exports['export.mp4'], 'cached');
  await host.admin('/api/admin/retake', { lineId: '01_alice' });
  const up = await host.upload(ada, '01_alice');
  await host.accept(ada, '01_alice', up.data.session.lineTakes['01_alice'].id);
  await waitFor(async () => !(await host.admin('/api/library/' + entry.id)).data.exports['export.mp4'], 'cache dropped');
});
