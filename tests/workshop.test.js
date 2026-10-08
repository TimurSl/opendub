import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseIni, parseWorkshopPack, discoverPacks } from '../server/index.js';
import { makeFixture, fixtureLines } from './helpers.js';

test('INI subset preserves UTF-8 strings, quoted escapes, arrays, and comments', () => {
  const data = parseIni('[data]\n\ncaption="Наказато: \\"quoted\\"; not a comment"\ndub_timestamps=[61.352, 70.1]\ndub_ends=[64.240, 72]\ndub_characters=["Наказато", "Наказато"]\n');
  assert.equal(data.caption, 'Наказато: "quoted"; not a comment');
  assert.deepEqual(data.dub_timestamps, [61.352, 70.1]);
  assert.deepEqual(data.dub_ends, [64.24, 72]);
  assert.deepEqual(data.dub_characters, ['Наказато', 'Наказато']);
});

test('parser discovers metadata, characters, optional reference, and chronological line envelopes', async (t) => {
  const fixture = await makeFixture(t);
  const pack = await parseWorkshopPack(fixture.packDir, { id: 'fixture' });
  assert.equal(pack.metadata.title, 'Synthetic pack – тест');
  assert.deepEqual(pack.metadata.authors, ['Runtime tests', 'Second author']);
  assert.equal(pack.metadata.language, 'RUS');
  assert.deepEqual(pack.characters, ['Alice', 'Bob', 'Cara', 'Narrator']);
  assert.deepEqual(pack.characterLineCounts, [2, 2, 2, 1]);
  assert.deepEqual(pack.lines.map((line) => line.id), fixtureLines.map((line) => line.id));
  assert.equal(pack.lines[0].character, 'Alice');
  assert.ok(Math.abs(pack.lines[0].duration - 0.4) < 1e-9);
  assert.equal(pack.lines[0].caption, 'Caption for 01_alice: "quoted"');
  assert.equal(pack.lines[1].startTime, 0.2); // Overlap is valid.
  assert.ok(pack.lines[0].referenceAudio);
});

test('multi-entry arrays are retained; one character spans a single task envelope', async (t) => {
  const fixture = await makeFixture(t, { lines: [] });
  await writeFile(path.join(fixture.packDir, '01_segments.ini'), '[data]\ncaption="Two parts"\ndub_timestamps=[3, 8]\ndub_ends=[4, 10]\ndub_characters=["Actor", "Actor"]\n');
  const pack = await parseWorkshopPack(fixture.packDir);
  assert.equal(pack.lines.length, 1);
  assert.deepEqual(pack.lines[0].segments, [
    { startTime: 3, endTime: 4, character: 'Actor' },
    { startTime: 8, endTime: 10, character: 'Actor' },
  ]);
  assert.equal(pack.lines[0].startTime, 3);
  assert.equal(pack.lines[0].endTime, 10);
  assert.equal(pack.lines[0].duration, 7);
  assert.equal(pack.lines[0].referenceAudio, null);
});

test('malformed task arrays, invalid ranges, mixed characters, and expressions are rejected', async (t) => {
  const fixture = await makeFixture(t, { lines: [] });
  for (const fields of [
    'dub_timestamps=[1,2]\ndub_ends=[3]\ndub_characters=["Actor"]',
    'dub_timestamps=[-1]\ndub_ends=[3]\ndub_characters=["Actor"]',
    'dub_timestamps=[3]\ndub_ends=[3]\ndub_characters=["Actor"]',
    'dub_timestamps=[NaN]\ndub_ends=[3]\ndub_characters=["Actor"]',
    'dub_timestamps=[1,3]\ndub_ends=[2,4]\ndub_characters=["Actor", "Other"]',
    'dub_timestamps=[process.exit()]\ndub_ends=[3]\ndub_characters=["Actor"]',
  ]) {
    await writeFile(path.join(fixture.packDir, '01_invalid.ini'), `[data]\ncaption="Invalid"\n${fields}\n`);
    await assert.rejects(async () => parseWorkshopPack(fixture.packDir));
  }
});

test('pack discovery reports bad packs without hiding usable packs', async (t) => {
  const fixture = await makeFixture(t);
  const invalidDir = path.join(fixture.workshopDir, 'broken-pack');
  await mkdir(invalidDir);
  await writeFile(path.join(invalidDir, '_pack_info.ini'), '[data]\ntitle="Broken"\n');
  const found = await discoverPacks(fixture.workshopDir);
  assert.equal(found.packs.length, 1);
  assert.ok(found.errors.some((entry) => entry.name === 'broken-pack'));
  const single = await discoverPacks(fixture.packDir);
  assert.equal(single.packs.length, 1);
});

test('pack icon traversal and symlink media escapes are rejected', async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(path.join(fixture.packDir, '_pack_info.ini'), '[data]\ntitle="Unsafe"\nicon="../../secret.png"\nauthors=[]\nlanguage="ENG"\n');
  await assert.rejects(async () => parseWorkshopPack(fixture.packDir));
  await writeFile(path.join(fixture.packDir, '_pack_info.ini'), '[data]\ntitle="Unsafe"\nicon="Linked.png"\nauthors=[]\nlanguage="ENG"\n');
  await writeFile(path.join(fixture.root, 'secret.png'), 'private host file');
  await symlink(path.join(fixture.root, 'secret.png'), path.join(fixture.packDir, 'Linked.png'));
  await assert.rejects(async () => parseWorkshopPack(fixture.packDir));
});
