import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';

export function validateAdminToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Invalid admin token');
  return token;
}
export function secureEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function tokenFile(dataDir) { return path.join(dataDir, 'admin-token'); }
export async function initializeAdminToken(filename) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(filename, 'wx', 0o600);
    try { await handle.writeFile(randomBytes(32).toString('base64url') + '\n'); }
    finally { await handle.close(); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readAdminToken(filename);
}
export function readAdminToken(filename) {
  const stat = readFileSync(filename, { encoding: 'utf8' });
  return validateAdminToken(stat.trim());
}
export async function rotateAdminToken(filename) {
  const temporary = `${filename}.${process.pid}.${randomBytes(6).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  try {
    await fs.writeFile(temporary, token + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
  return token;
}

function ipv4Number(value) {
  if (isIP(value) !== 4) return null;
  return value.split('.').reduce((acc, part) => ((acc * 256) + Number(part)) >>> 0, 0);
}
function privateV4(n) {
  return (n >>> 24) === 10 || (n >>> 20) === 0xac1 || (n >>> 16) === 0xc0a8 || (n >>> 22) === 0x191;
}
export function parseWireGuardCidrs(value = '') {
  if (!value || !value.trim()) return [];
  return value.split(',').map(entry => {
    const value = entry.trim();
    const parts = value.split('/');
    if (parts.length > 2) throw new Error('Invalid WG_ADMIN_CIDRS');
    const ip = ipv4Number(parts[0]);
    const bits = parts[1] === undefined ? 32 : Number(parts[1]);
    // Avoid accidentally removing admin authentication for public internet ranges.
    if (ip === null || !privateV4(ip) || !/^\d+$/.test(parts[1] ?? '32') || bits < 16 || bits > 32) throw new Error('WG_ADMIN_CIDRS must contain narrowly scoped private IPv4 networks');
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (!privateV4((ip & mask) >>> 0)) throw new Error('WG_ADMIN_CIDRS range must stay private');
    return { network: ip & mask, mask };
  });
}
export function wireGuardAddressAllowed(address, cidrs) {
  const ip = ipv4Number(address);
  return ip !== null && cidrs.some(({ network, mask }) => (ip & mask) === network);
}
