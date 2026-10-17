import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm, writeFile, readdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeAdminToken, readAdminToken, rotateAdminToken, parseWireGuardCidrs, wireGuardAddressAllowed, secureEquals } from '../server/admin-auth.js';
import { downloadWorkshopItem, workshopItemId, workshopAppId, workshopLimits, steamUsername, runSteamcmd } from '../server/workshop/downloader.js';
import { createRuntime } from '../server/index.js';
import { startFixtureRuntime } from './helpers.js';
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
  assert.deepEqual(argsSeen.slice(1), ['+@NoPromptForPassword', '1', '+@ShutdownOnFailedCommand', '1', '+force_install_dir', steamcmdDir, '+login', 'anonymous', '+workshop_download_item', '5020310', '1234567890', '+quit']);
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

test('Workshop packs with more than 500 files import with default limits', async t => {
  const dir = await root(t), steamcmdDir = path.join(dir, 'steam'), workshopDir = path.join(dir, 'packs');
  const source = path.join(steamcmdDir, 'steamapps/workshop/content/5020310/3819916508');
  await writePack(source);
  const line = await readFile(path.join(source, 'line.ini'));
  for (let i = 0; i < 250; i++) {
    await writeFile(path.join(source, `line-${i}.ini`), line);
    await writeFile(path.join(source, `line-${i}.mp3`), 'ID3 reference');
  }
  const downloaded = await downloadWorkshopItem({ itemId: '3819916508', steamcmdDir, workshopDir, run: async () => {} });
  assert.equal(downloaded.pack.lines.length, 251);
  assert.equal((await readdir(downloaded.pack.directory)).length, 505);
});

test('Workshop limits accept exact boundaries and reject excess before replacing a pack', async t => {
  const dir = await root(t), steamcmdDir = path.join(dir, 'steam'), workshopDir = path.join(dir, 'packs');
  const source = path.join(steamcmdDir, 'steamapps/workshop/content/5020310/1234567890');
  await writePack(source);
  const sizes = await Promise.all((await readdir(source)).map(async name => (await stat(path.join(source, name))).size));
  const maxBytes = sizes.reduce((sum, size) => sum + size, 0);
  const opts = { itemId: '1234567890', steamcmdDir, workshopDir, maxFiles: 5, maxBytes, run: async () => {} };
  const imported = await downloadWorkshopItem(opts);
  const marker = path.join(imported.pack.directory, 'keep.txt');
  await writeFile(marker, 'previous pack');
  await assert.rejects(downloadWorkshopItem({ ...opts, maxFiles: 4 }), /file limit: found at least 5 files, limit 4.*WORKSHOP_MAX_FILES/);
  await assert.rejects(downloadWorkshopItem({ ...opts, maxBytes: maxBytes - 1 }), /size limit:.*bytes.*WORKSHOP_MAX_BYTES/);
  await mkdir(path.join(source, 'nested'));
  await writeFile(path.join(source, 'nested', 'extra'), 'extra');
  await assert.rejects(downloadWorkshopItem({ ...opts, maxBytes: maxBytes + 100 }), /file limit: found at least 6 files, limit 5/);
  assert.equal(await readFile(marker, 'utf8'), 'previous pack');
  assert.deepEqual(await readdir(workshopDir), ['workshop-1234567890']);
});

test('Workshop tree validation still rejects links with higher limits', async t => {
  const dir = await root(t), steamcmdDir = path.join(dir, 'steam'), workshopDir = path.join(dir, 'packs');
  const source = path.join(steamcmdDir, 'steamapps/workshop/content/5020310/1234567890');
  await writePack(source);
  await symlink(dir, path.join(source, 'linked-directory'));
  await assert.rejects(downloadWorkshopItem({ itemId: '1234567890', steamcmdDir, workshopDir, run: async () => {} }), /unsupported links/);
  assert.deepEqual(await readdir(workshopDir), []);
});

test('Workshop limits are finite positive integers, validated before download or runtime startup', async () => {
  assert.deepEqual(workshopLimits(), { maxFiles: 10000, maxBytes: 10 * 1024 ** 3 });
  assert.deepEqual(workshopLimits({ maxFiles: '20000', maxBytes: '21474836480' }), { maxFiles: 20000, maxBytes: 20 * 1024 ** 3 });
  for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '', 'bad', true, null]) {
    assert.throws(() => workshopLimits({ maxFiles: value }), /WORKSHOP_MAX_FILES/);
    assert.throws(() => workshopLimits({ maxBytes: value }), /WORKSHOP_MAX_BYTES/);
  }
  let ran = false;
  await assert.rejects(downloadWorkshopItem({ itemId: '1234567890', maxFiles: 0, run: async () => { ran = true; } }), /WORKSHOP_MAX_FILES/);
  assert.equal(ran, false);
  await assert.rejects(createRuntime({ workshopMaxBytes: 0 }), /WORKSHOP_MAX_BYTES/);
});

test('Workshop HTTP downloads enforce configured limits from environment and runtime options', async t => {
  const dir = await root(t), steamcmdDir = path.join(dir, 'steam');
  await writePack(path.join(steamcmdDir, 'steamapps/workshop/content/5020310/1234567890'));
  const fake = path.join(dir, 'steamcmd');
  await writeFile(fake, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const previous = process.env.WORKSHOP_MAX_FILES;
  process.env.WORKSHOP_MAX_FILES = '4';
  t.after(() => { if (previous === undefined) delete process.env.WORKSHOP_MAX_FILES; else process.env.WORKSHOP_MAX_FILES = previous; });
  for (const [overrides, message] of [
    [{}, /file limit:.*WORKSHOP_MAX_FILES/],
    [{ workshopMaxFiles: 5, workshopMaxBytes: 1 }, /size limit:.*WORKSHOP_MAX_BYTES/],
  ]) {
    const host = await startFixtureRuntime(t, { steamcmdDir, steamcmdPath: fake, ...overrides });
    assert.equal((await host.admin('/api/admin/workshop/download', { item: '1234567890' })).status, 202);
    let job;
    for (let i = 0; i < 100; i++) {
      job = (await host.admin('/api/admin/workshop/status')).data.job;
      if (job.status !== 'running') break;
      await delay(20);
    }
    assert.equal(job.status, 'error');
    assert.match(job.error, message);
    await host.stop();
  }
});


test('Steam app ID and login name are strict, numeric/fixed SteamCMD arguments', async t => {
  const dir = await root(t);
  const steamcmdDir = path.join(dir, 'steam-cache');
  const workshopDir = path.join(dir, 'packs-imported');
  const homeDir = path.join(dir, 'home');
  const invoked = [];
  const result = await downloadWorkshopItem({
    itemId: '1234567890', steamcmdDir, workshopDir, homeDir, appId: '480', username: 'owned_account',
    run: async (binary, args, opts) => {
      invoked.push({ binary, args, opts });
      await writePack(path.join(steamcmdDir, 'steamapps/workshop/content/480/1234567890'));
    },
  });
  assert.equal(result.pack.metadata.title, 'Test');
  assert.deepEqual(invoked[0].opts, { cwd: steamcmdDir, homeDir });
  assert.deepEqual(invoked[0].args.slice(-6), ['+login', 'owned_account', '+workshop_download_item', '480', '1234567890', '+quit']);
  assert.equal(await readFile(path.join(workshopDir, 'workshop-1234567890/_pack_info.ini'), 'utf8').then(x => x.includes('Test')), true);
  for (const bad of ['0', '01', '-1', '+quit', '480 +quit', '4294967296', '1e3', ''])
    assert.throws(() => workshopAppId(bad), /app ID/);
  assert.equal(workshopAppId(5020310), '5020310');
  for (const bad of ['a +quit', 'bad\nlogin', '--', 'x', ''])
    assert.throws(() => steamUsername(bad), /login name/);
});

function fakeSteamcmd(output, exitCode = 0) {
  return (_exe, _args, _options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.write(output);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', exitCode);
    });
    return child;
  };
}

test('SteamCMD fails closed for login errors and Workshop errors even with exit code 0', async () => {
  const opts = { timeoutMs: 1000 };
  await assert.rejects(runSteamcmd('steamcmd', [], { ...opts, spawnProcess: fakeSteamcmd('ERROR! Download item 123 failed (No Connection).') }), /failed to download/);
  await assert.rejects(runSteamcmd('steamcmd', [], { ...opts, spawnProcess: fakeSteamcmd('ERROR! Download item 123 failed (No subscription).') }), /No subscription/);
  await assert.rejects(runSteamcmd('steamcmd', [], { ...opts, spawnProcess: fakeSteamcmd('Login Failure: Steam Guard') }), /opendub-steam login/);
  await assert.rejects(runSteamcmd('steamcmd', [], { ...opts, spawnProcess: fakeSteamcmd('ok', 7) }), /status 7/);
  await runSteamcmd('steamcmd', [], { ...opts, spawnProcess: fakeSteamcmd('Success. Downloaded item') });
});

test('opendub-steam logs in with the same HOME and working directory, without password CLI arguments', async t => {
  const home = await root(t);
  const steamcmdDir = path.join(home, 'my-steam');
  const output = path.join(home, 'called.json');
  const fake = path.join(home, 'steamcmd-fake');
  await writeFile(fake, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.env.TEST_STEAM_OUT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME, xdg: process.env.XDG_DATA_HOME }));
`, { mode: 0o700 });
  execFileSync(process.execPath, [new URL('../bin/opendub-steam', import.meta.url).pathname, 'login', 'owned_account'], {
    env: { ...process.env, HOME: home, STEAMCMD_DIR: steamcmdDir, STEAMCMD_PATH: fake, TEST_STEAM_OUT: output },
    cwd: home,
  });
  const called = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(called.args, ['+force_install_dir', steamcmdDir, '+login', 'owned_account', '+quit']);
  assert.equal(called.cwd, steamcmdDir);
  assert.equal(called.home, home);
  assert.equal(called.xdg, path.join(home, '.local', 'share'));
  const extra = path.join(home, 'other-steam');
  execFileSync(process.execPath, [new URL('../bin/opendub-steam', import.meta.url).pathname, 'login', 'owned_account', '--steamcmd-dir', extra], {
    env: { ...process.env, HOME: home, STEAMCMD_DIR: steamcmdDir, STEAMCMD_PATH: fake, TEST_STEAM_OUT: output },
  });
  const override = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(override.cwd, extra);
  assert.equal(override.args[1], extra);
  assert.throws(() => execFileSync(process.execPath, [new URL('../bin/opendub-steam', import.meta.url).pathname, 'login', 'x;quit'], {
    env: { ...process.env, HOME: home, STEAMCMD_DIR: steamcmdDir, STEAMCMD_PATH: fake }, stdio: 'pipe',
  }), /Command failed/);
});
