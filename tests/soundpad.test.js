import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { soundpadFormat, soundpadMagicValid, checkSoundpadFile, runSoundpadAudio } from '../server/soundpad-audio.js';
import { RuntimeClient } from '../web/shared/api.js';

const wavHeader = Buffer.from('RIFF0000WAVE');

test('soundpad only accepts known audio formats whose signatures match the declared format', () => {
  assert.equal(soundpadFormat('text/plain'), null);
  assert.equal(soundpadFormat('audio/wav'), 'wav');
  assert.equal(soundpadMagicValid('audio/wav', wavHeader), true);
  assert.equal(soundpadMagicValid('audio/wav', Buffer.from('RIFF0000EVIL')), false);
  assert.equal(soundpadMagicValid('audio/mpeg', Buffer.from('ID3\x04\0\0\0\0\0\0\0\0')), true);
  assert.equal(soundpadMagicValid('audio/ogg', Buffer.from('OggS00000000')), true);
  assert.equal(soundpadMagicValid('audio/flac', Buffer.from('fLaC00000000')), true);
  assert.equal(soundpadMagicValid('audio/webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8)])), true);
  assert.equal(soundpadMagicValid('audio/mp4', Buffer.from('0000ftyp0000')), true);
  assert.equal(soundpadMagicValid('audio/mpeg', Buffer.from('#EXTM3U playlist')), false);
  assert.equal(soundpadMagicValid('audio/wav', Buffer.from('<script>evil</script>')), false);
});

test('soundpad client sends only the audio bytes, match ID and retake ID, not raw FFmpeg flags', async t => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const client = new RuntimeClient('player');
  client.state = { session: { matchId: 'm1' } };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/takes/line%2Fa/soundpad');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['X-Match-ID'], 'm1');
    assert.equal(options.headers['X-Retake-ID'], 'r1');
    assert.equal(options.body.get('args'), null);
    assert.equal(options.body.get('take').name, 'sound.wav');
    return new Response(new Blob(['encoded'], { type: 'audio/webm' }), { headers: { 'Content-Type': 'audio/webm' } });
  };
  assert.equal(await (await client.processSoundpadAudio('line/a', new File(['RIFF'], 'sound.wav', { type: 'audio/wav' }), 'r1')).text(), 'encoded');
});

test('HTTP soundpad import converts WAV to WebM and the output uses the ordinary take upload', async t => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) return t.skip('FFmpeg unavailable');
  try { await import('express'); } catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return t.skip('server dependencies not installed'); throw error; }
  const { startFixtureRuntime } = await import('./helpers.js');
  const host = await startFixtureRuntime(t);
  const selected = await host.select();
  await host.admin('/api/admin/open-lobby', {});
  const player = await host.join(selected.session, 'Soundpad');
  assert.equal((await host.admin('/api/admin/distribute', {})).status, 200);
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  const state = (await host.admin('/api/state')).data;
  const matchId = state.session.matchId;
  const lineId = state.queue?.pendingLines?.[0] || '01_alice';
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.1', '-c:a', 'pcm_s16le', '-f', 'wav', '-'], { maxBuffer: 2 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr?.toString());
  function form(bytes, type, name = 'sound.wav') {
    const value = new FormData(); value.append('take', new Blob([bytes], { type }), name); return value;
  }
  async function send(bytes, type = 'audio/wav', headers = {}, name) {
    const result = await fetch(host.base + `/api/takes/${lineId}/soundpad`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${player.token}`, 'X-Match-ID': matchId, ...headers,
      }, body: form(bytes, type, name),
    });
    return { status: result.status, contentType: result.headers.get('content-type'), bytes: Buffer.from(await result.arrayBuffer()) };
  }
  assert.equal((await send(generated.stdout, 'text/plain')).status, 415);
  assert.equal((await send(Buffer.from('RIFF0000BAD!'), 'audio/wav')).status, 415);
  assert.equal((await send(generated.stdout, 'audio/wav', { 'X-Match-ID': 'wrong' })).status, 409);
  const badAuth = await fetch(host.base + `/api/takes/${lineId}/soundpad`, { method: 'POST', body: form(generated.stdout, 'audio/wav') });
  assert.equal(badAuth.status, 401);
  const converted = await send(generated.stdout, 'audio/wav', {}, '$(touch hacked).wav');
  assert.equal(converted.status, 200, converted.bytes.toString('utf8', 0, 300));
  assert.match(converted.contentType, /^audio\/webm/);
  assert.deepEqual(converted.bytes.subarray(0, 4), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-f', 'matroska', '-i', 'pipe:0', '-f', 'null', '-'], { input: converted.bytes });
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
  assert.equal((await host.admin('/api/state')).data.session.lineTakes[lineId], undefined, 'conversion alone must not change the accepted take');
  const uploaded = await host.upload(player, lineId, { bytes: converted.bytes, type: 'audio/webm' });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  assert.equal(uploaded.data.session.lineTakes[lineId].status, 'recorded');
});

test('server soundpad converter safely processes an actual WAV and rejects forged headers', async t => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) return t.skip('FFmpeg unavailable');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soundpad-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.wav'); const output = path.join(dir, 'output.webm');
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=1.1', '-c:a', 'pcm_s16le', '-y', input]);
  assert.equal(generated.status, 0);
  await checkSoundpadFile(input, 'audio/wav');
  await assert.rejects(checkSoundpadFile(input, 'audio/ogg'), /Unsupported audio file/);
  await runSoundpadAudio('ffmpeg', input, output, 'audio/wav', 0.4);
  assert.ok((await stat(output)).size > 200);
  const webm = await readFile(output);
  assert.deepEqual(webm.subarray(0, 4), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'matroska', '-i', output, '-f', 'null', '-']);
  assert.equal(decoded.status, 0);
});

test('soundpad converter trims longer MP3 clips to the cue plus the allowed two-second tail', async t => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0 ||
      spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status !== 0) return t.skip('FFmpeg tools unavailable');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soundpad-mp3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'source.mp3'); const output = path.join(dir, 'result.webm');
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6', '-c:a', 'libmp3lame', '-y', input]);
  assert.equal(generated.status, 0);
  await checkSoundpadFile(input, 'audio/mpeg');
  await runSoundpadAudio('ffmpeg', input, output, 'audio/mpeg', 0.5);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', output]);
  assert.equal(probe.status, 0);
  const duration = Number(probe.stdout.toString().trim());
  assert.ok(duration >= 2.4 && duration <= 2.55, `unexpected duration ${duration}`);
});
