import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { initializeAdminToken, readAdminToken, rotateAdminToken, parseWireGuardCidrs, wireGuardAddressAllowed, secureEquals } from '../server/admin-auth.js';
import { downloadWorkshopItem, workshopItemId } from '../server/workshop/downloader.js';
const root = async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opendub-standalone-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
test('admin token remains stable across runtime boots and rotates atomically', async t => {
  const dir = await root(t); const filename = path.join(dir, 'admin-token');
  const a = await initializeAdminToken(filename);
  assert.match(a, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(await initializeAdminToken(filename), a);
  assert.equal(readAdminToken(filename), a);
  const b = await rotateAdminToken(filename);
  assert.notEqual(b, a); assert.equal(readAdminToken(filename), b);
  assert.equal(secureEquals(a, b), false);
  assert.equal(secureEquals(b, b), true);
  const cli = execFileSync(process.execPath, [new URL('../bin/opendub-auth', import.meta.url).pathname, '--data-dir', dir], { encoding: 'utf8' }).trim();
  assert.equal(cli, b);
});
test('WireGuard access checks CIDR boundaries and forbids permissive/public ranges', () => {
  const cidrs = parseWireGuardCidrs('10.77.0.0/24,192.168.10.11/32');
  assert.ok(wireGuardAddressAllowed('10.77.0.12', cidrs));
  assert.ok(!wireGuardAddressAllowed('10.77.1.2', cidrs));
  assert.ok(!wireGuardAddressAllowed('203.0.113.3', cidrs));
  assert.ok(!wireGuardAddressAllowed('127.0.0.1', cidrs));
  assert.ok(wireGuardAddressAllowed('192.168.10.11', cidrs));
  for (const value of ['0.0.0.0/0', '10.0.0.0/8', '8.8.8.8/32', '192.168.0.0/15', '10.77.0.0/24,', '10.77.0.0/08']) {
    assert.throws(() => parseWireGuardCidrs(value), /WG_ADMIN_CIDRS/);
  }
});
test('Workshop links are reduced to a numeric ID, never a command/URL', () => {
  assert.equal(workshopItemId('1234567890'), '1234567890');
  assert.equal(workshopItemId('https://steamcommunity.com/sharedfiles/filedetails/?id=1234567890'), '1234567890');
  for (const bad of [ 'abc', '1;touch /tmp/pwn', 'https://evil.com/sharedfiles/filedetails/?id=1234567890',
    'http://steamcommunity.com/sharedfiles/filedetails/?id=1234567890', 'https://steamcommunity.com/sharedfiles/filedetails/?id=1%20%2Bquit',
    'https://steamcommunity.com/groups/test?id=1234567890' ]) assert.throws(() => workshopItemId(bad));
});
async function writePack(pack) {
  await mkdir(pack, { recursive: true });
  await writeFile(path.join(pack, '_pack_info.ini'), '[data]\ntitle="Test"\nauthors=["test"]\nlanguage="EN"\n');
  await writeFile(path.join(pack, 'dub_video.ogv'), 'OggS video');
  await writeFile(path.join(pack, '_backing_track.ogg'), 'OggS backing');
  await writeFile(path.join(pack, 'line.ini'), '[data]\ncaption="Hello"\ndub_timestamps=[0.1]\ndub_ends=[1.5]\ndub_characters=["Test"]\n');
  await writeFile(path.join(pack, 'line.mp3'), 'ID3 reference');
}
test('Workshop download runs fixed SteamCMD arguments, validates and publishes a pack', async t => {
  const dir = await root(t), steamcmdDir = path.join(dir, 'steam'), workshopDir = path.join(dir, 'packs');
  const argsSeen = [];
  const downloaded = await downloadWorkshopItem({ itemId: '1234567890', steamcmdDir, workshopDir, run: async (binary, args) => {
    argsSeen.push(binary, ...args);
    await writePack(path.join(steamcmdDir, 'steamapps/workshop/content/5020310/1234567890'));
  } });
  assert.equal(argsSeen[0], 'steamcmd');
  assert.deepEqual(argsSeen.slice(1), ['+force_install_dir', steamcmdDir, '+login', 'anonymous', '+workshop_download_item', '5020310', '1234567890', '+quit']);
  assert.equal(downloaded.id, '1234567890');
  assert.equal(downloaded.pack.metadata.title, 'Test');
  assert.equal((await readdir(workshopDir)).length, 1);
  assert.ok((await readFile(path.join(workshopDir, 'workshop-1234567890/_pack_info.ini'), 'utf8')).includes('Test'));
});
test('Malformed Workshop packs and refused publish leave old packs intact', async t => {
  const dir = await root(t), steamcmdDir = path.join(dir, 'steam'), workshopDir = path.join(dir, 'packs');
  const source = path.join(steamcmdDir, 'steamapps/workshop/content/5020310/1234567890');
  const target = path.join(workshopDir, 'workshop-1234567890');
  await writePack(target);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, '_pack_info.ini'), '[data]\ntitle="Bad pack"');
  const opts = { itemId: '1234567890', steamcmdDir, workshopDir, run: async () => {} };
  await assert.rejects(downloadWorkshopItem(opts));
  assert.equal((await readFile(path.join(target, '_pack_info.ini'), 'utf8')).includes('Test'), true);
  await rm(source, { recursive: true }); await writePack(source);
  await assert.rejects(downloadWorkshopItem({ ...opts, beforePublish: () => { throw new Error('Selected pack'); } }), /Selected pack/);
  assert.equal((await readdir(workshopDir)).length, 1);
});
