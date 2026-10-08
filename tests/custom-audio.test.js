import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CustomAudioError, parseCustomAudioArgs, runCustomAudio } from '../server/custom-audio.js';

test('Custom recognizes only supported FFmpeg -af flags and normalizes numbers', () => {
  assert.equal(parseCustomAudioArgs('-af highpass=f=250,acrusher=bits=6:mix=0.8'), 'highpass=f=250,acrusher=bits=6:mix=0.8');
  assert.equal(parseCustomAudioArgs(' -filter:a "volume=1.20,lowpass=f=3000" '), 'volume=1.2,lowpass=f=3000');
  assert.equal(parseCustomAudioArgs('-af atempo=1.2,vibrato=d=0.7:f=6'), 'atempo=1.2,vibrato=f=6:d=0.7');
  assert.equal(parseCustomAudioArgs('-af aecho=in_gain=0.8:out_gain=0.9:delays=200:decays=0.5'), 'aecho=in_gain=0.8:out_gain=0.9:delays=200:decays=0.5');
});

test('Custom rejects injected argv, filtergraph instructions, file access, and unbounded input', () => {
  const invalid = [
    '', '-i /etc/passwd', '-af', '-af volume=2 -y /tmp/oops',
    '-af "volume=1;amovie=/etc/passwd"', '-af amovie=secret',
    '-af aeval=sin(1)', '-af aevalsrc=1', '-af movie=http://example.com/a',
    '-af asendcmd=c=0\ foo', '-filter_complex [0]volume=1[out]',
    '-af volume=1|ls', '-af volume=1 && id', '-af volume=1\n-i /etc/passwd',
    '-af volume=1,', '-af volume=1,pan=mono|c0=c0',
    '-af volume=Infinity', '-af volume=NaN', '-af volume=-2',
    '-af volume=9', '-af highpass=f=0', '-af lowpass=f=300000',
    '-af vibrato=f=6:d=4', '-af vibrato=f=6',
    '-af tremolo=f=4:d=0.5:evil=1', '-af acrusher=bits=2:mix=0.5:mix=0.5',
    '-af volume=1,'.repeat(20), '-af volume=1,'.repeat(6) + 'volume=1',
    '-af volume=1"', '-af "volume=1" -c:a copy',
  ];
  for (const value of invalid) assert.throws(() => parseCustomAudioArgs(value), CustomAudioError, JSON.stringify(value));
  assert.throws(() => parseCustomAudioArgs({ argv: ['-i', '/etc/passwd'] }), CustomAudioError);
});

test('Custom FFmpeg processing generates a playable WebM audio file', async t => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) return t.skip('FFmpeg not installed');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'open-dub-custom-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'test.webm');
  const output = path.join(directory, 'processed.webm');
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.7', '-c:a', 'libopus', '-y', input], { stdio: 'pipe' });
  assert.equal(generated.status, 0, generated.stderr?.toString());
  await runCustomAudio('ffmpeg', input, output, parseCustomAudioArgs('-af tremolo=f=5:d=0.8,highpass=f=150'), 1);
  assert.ok((await stat(output)).size > 200);
  assert.deepEqual((await readFile(output)).subarray(0, 4), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-'], { stdio: 'pipe' });
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
});
