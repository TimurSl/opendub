import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { parseWorkshopPack } from './parser.js';

export const DUB_TOGETHER_APP_ID = '5020310';

export function workshopAppId(value = DUB_TOGETHER_APP_ID) {
  const id = String(value);
  if (!/^[1-9][0-9]{0,9}$/.test(id) || Number(id) > 0xFFFFFFFF)
    throw new Error('WORKSHOP_APP_ID must be a positive numeric Steam app ID');
  return id;
}

export function steamUsername(value = 'anonymous') {
  if (typeof value !== 'string' || !/^(?:anonymous|[A-Za-z0-9_.-]{3,64})$/.test(value))
    throw new Error('STEAMCMD_USERNAME must be a Steam login name (never a password)');
  return value;
}

export function workshopItemId(value) {
  if (typeof value !== 'string' || value.length > 300) throw new Error('Enter a Workshop item ID or Steam Workshop URL');
  const trimmed = value.trim();
  if (/^[1-9][0-9]{5,19}$/.test(trimmed)) return trimmed;
  let url;
  try { url = new URL(trimmed); } catch { throw new Error('Invalid Workshop URL or ID'); }
  if (url.protocol !== 'https:' || !['steamcommunity.com', 'www.steamcommunity.com'].includes(url.hostname) ||
    !['/sharedfiles/filedetails/', '/sharedfiles/filedetails', '/workshop/filedetails/', '/workshop/filedetails'].includes(url.pathname) ||
    !/^[1-9][0-9]{5,19}$/.test(url.searchParams.get('id') ?? '')) throw new Error('Only Steam Workshop item links or numeric IDs are supported');
  return url.searchParams.get('id');
}

// Never expose SteamCMD's interactive login to a web request. A Steam account
// must be authorized in advance with `sudo -u opendub -H opendub-steam login ...`.
// SteamCMD sometimes returns status 0 even when workshop_download_item fails.
export function runSteamcmd(executable, args, { timeoutMs = 300000, spawnProcess = spawn, cwd, homeDir } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'], cwd,
      env: { ...process.env, HOME: homeDir ?? process.env.HOME ?? os.homedir(),
        XDG_DATA_HOME: path.join(homeDir ?? process.env.HOME ?? os.homedir(), '.local', 'share') },
    });
    let output = '';
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const collect = data => { output = (output + data.toString()).slice(-8192); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('SteamCMD timed out; check connectivity or reauthenticate interactively using opendub-steam'));
    }, timeoutMs);
    child.on('error', error => finish(new Error('SteamCMD could not start: ' + error.message)));
    child.on('close', code => {
      if (/No subscription/i.test(output))
        return finish(new Error('Steam account has no Workshop access for this game (No subscription)'));
      if (/Login Failure|Invalid Password|Steam Guard|two-factor|not logged on/i.test(output))
        return finish(new Error('SteamCMD authentication required: run opendub-steam login as the opendub user'));
      if (/ERROR!\s*(?:Download item|Failed to download|Failed to install)/i.test(output))
        return finish(new Error('SteamCMD failed to download this Workshop item; check its availability and SteamCMD logs'));
      if (code !== 0) return finish(new Error(`SteamCMD exited with status ${code}; check SteamCMD logs and reauthenticate if necessary`));
      finish();
    });
  });
}

async function checkTree(root) {
  let bytes = 0, files = 0;
  async function visit(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const name = path.join(directory, item.name);
      if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) throw new Error('Workshop pack contains unsupported links or file types');
      if (item.isDirectory()) await visit(name);
      else {
        files++;
        bytes += (await fs.stat(name)).size;
        if (files > 500 || bytes > 1500 * 1024 * 1024) throw new Error('Workshop pack exceeds safe file or size limits');
      }
    }
  }
  await visit(root);
}

export async function downloadWorkshopItem({
  itemId, steamcmdPath = 'steamcmd', steamcmdDir, workshopDir,
  appId = DUB_TOGETHER_APP_ID, username = 'anonymous',
  homeDir = process.env.HOME ?? os.homedir(),
  run = runSteamcmd, beforePublish = () => {},
}) {
  const id = workshopItemId(itemId);
  const gameAppId = workshopAppId(appId);
  const account = steamUsername(username);
  const steamRoot = path.resolve(steamcmdDir);
  const packs = path.resolve(workshopDir);
  await fs.mkdir(steamRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(packs, { recursive: true, mode: 0o700 });
  // SteamCMD is noninteractive inside the service. The password and Steam Guard
  // code are NEVER supplied as process arguments, from HTTP or from Nix config.
  await run(steamcmdPath, [
    '+@NoPromptForPassword', '1', '+@ShutdownOnFailedCommand', '1',
    '+force_install_dir', steamRoot, '+login', account,
    '+workshop_download_item', gameAppId, id, '+quit',
  ], { cwd: steamRoot, homeDir });

  // On some SteamCMD builds Workshop files ignore force_install_dir and land
  // under the launch directory or Steam's persistent data directory instead.
  const candidates = [
    path.join(steamRoot, 'steamapps', 'workshop', 'content', gameAppId, id),
    path.join(homeDir, '.local', 'share', 'Steam', 'steamcmd', 'steamapps', 'workshop', 'content', gameAppId, id),
    path.join(homeDir, '.steam', 'steamcmd', 'steamapps', 'workshop', 'content', gameAppId, id),
    path.join(homeDir, 'Steam', 'steamapps', 'workshop', 'content', gameAppId, id),
    path.join(homeDir, '.local', 'share', 'Steam', 'steamapps', 'workshop', 'content', gameAppId, id),
  ];
  let source;
  for (const candidate of candidates) {
    try { if ((await fs.lstat(candidate)).isDirectory()) { source = candidate; break; } } catch {}
  }
  if (!source) throw new Error(`SteamCMD did not provide Workshop item ${id} for app ${gameAppId}; check Steam account, Workshop access and logs`);
  await checkTree(source);
  const target = path.join(packs, `workshop-${id}`);
  // Parse BEFORE publishing the pack to avoid exposing incomplete/malformed media.
  const staging = path.join(packs, `.workshop-${id}-${process.pid}-${Date.now()}`);
  const backup = path.join(packs, `.workshop-${id}-backup-${process.pid}-${Date.now()}`);
  let hasBackup = false;
  try {
    await fs.cp(source, staging, { recursive: true, dereference: false, errorOnExist: true, force: false });
    await parseWorkshopPack(staging);
    await beforePublish(target);
    try { await fs.rename(target, backup); hasBackup = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(staging, target); }
    catch (error) { if (hasBackup) await fs.rename(backup, target); hasBackup = false; throw error; }
    if (hasBackup) await fs.rm(backup, { recursive: true, force: true });
    return { id, pack: await parseWorkshopPack(target) };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
