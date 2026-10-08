import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseWorkshopPack } from './parser.js';

export const DUB_TOGETHER_APP_ID = '5020310';
export function workshopItemId(value) {
  if (typeof value !== 'string' || value.length > 300) throw new Error('Enter a Workshop item ID or Steam Workshop URL');
  const trimmed = value.trim();
  if (/^[1-9][0-9]{5,19}$/.test(trimmed)) return trimmed;
  let url;
  try { url = new URL(trimmed); } catch { throw new Error('Invalid Workshop URL or ID'); }
  if (url.protocol !== 'https:' || !['steamcommunity.com', 'www.steamcommunity.com'].includes(url.hostname) ||
    !['/sharedfiles/filedetails/', '/sharedfiles/filedetails', '/workshop/filedetails/', '/workshop/filedetails'].includes(url.pathname) ||
    !/^[1-9][0-9]{5,19}$/.test(url.searchParams.get('id') ?? '')) throw new Error('Only Dub Together Workshop item links or numeric IDs are supported');
  return url.searchParams.get('id');
}

function runSteamcmd(executable, args, { timeoutMs = 300000, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: process.env.HOME || '/tmp' } });
    let log = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('SteamCMD timed out')); }, timeoutMs);
    child.stderr?.on('data', data => { log = (log + data.toString()).slice(-3000); });
    child.on('error', error => { clearTimeout(timer); reject(new Error('SteamCMD could not start: ' + error.message)); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('SteamCMD exited with ' + code + ': ' + log.slice(-1000)));
      else resolve();
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

export async function downloadWorkshopItem({ itemId, steamcmdPath = 'steamcmd', steamcmdDir, workshopDir, run = runSteamcmd, username = 'anonymous', beforePublish = () => {} }) {
  const id = workshopItemId(itemId);
  if (!/^(?:anonymous|[A-Za-z0-9_.-]{3,64})$/.test(username)) throw new Error('Invalid SteamCMD username');
  const steamRoot = path.resolve(steamcmdDir);
  const packs = path.resolve(workshopDir);
  await fs.mkdir(steamRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(packs, { recursive: true, mode: 0o700 });
  // A Steam account is NOT supplied via the API. Some games reject anonymous
  // downloads; use a locally authenticated SteamCMD installation if required.
  await run(steamcmdPath, ['+force_install_dir', steamRoot, '+login', username, '+workshop_download_item', DUB_TOGETHER_APP_ID, id, '+quit']);
  const home = process.env.HOME ?? '';
  const candidates = [
    path.join(steamRoot, 'steamapps', 'workshop', 'content', DUB_TOGETHER_APP_ID, id),
    path.join(steamRoot, 'steamapps', 'workshop', 'content', id),
    ...(home ? [
      path.join(home, '.local', 'share', 'Steam', 'steamcmd', 'steamapps', 'workshop', 'content', DUB_TOGETHER_APP_ID, id),
      path.join(home, '.steam', 'steamcmd', 'steamapps', 'workshop', 'content', DUB_TOGETHER_APP_ID, id),
    ] : []),
  ];
  let source;
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate)).isDirectory()) { source = candidate; break; } } catch {}
  }
  if (!source) throw new Error('SteamCMD finished, but pack files were not found. Check SteamCMD logs and anonymous Workshop access.');
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
