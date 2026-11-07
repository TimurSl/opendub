import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { createRuntime } from '../server/index.js';

export const fixtureLines = [
  { id: '01_alice', character: 'Alice', start: 0.1, end: 0.5 },
  { id: '02_bob', character: 'Bob', start: 0.2, end: 0.6 },
  { id: '03_cara', character: 'Cara', start: 0.3, end: 0.7 },
  { id: '04_alice', character: 'Alice', start: 1, end: 1.4 },
  { id: '05_bob', character: 'Bob', start: 1.1, end: 1.5 },
  { id: '06_cara', character: 'Cara', start: 1.2, end: 1.6 },
  { id: '07_narrator', character: 'Narrator', start: 2, end: 2.4 },
];

export async function makeFixture(t, { lines = fixtureLines } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'open-dub-test-'));
  const workshopDir = path.join(root, 'workshop');
  const packDir = path.join(workshopDir, 'synthetic-pack');
  const dataDir = path.join(root, 'data');
  await mkdir(packDir, { recursive: true });
  await writeFile(path.join(packDir, '_pack_info.ini'), '[data]\n\ntitle="Synthetic pack – тест"\nicon="Icon.png"\nauthors=["Runtime tests", "Second author"]\nlanguage="RUS"\n');
  await writeFile(path.join(packDir, 'dub_video.ogv'), Buffer.from('OggS synthetic video fixture'));
  await writeFile(path.join(packDir, '_backing_track.ogg'), Buffer.from('OggS synthetic backing fixture'));
  await writeFile(path.join(packDir, 'Icon.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  for (const line of [...lines].reverse()) {
    await writeFile(path.join(packDir, `${line.id}.ini`), `[data]\ncaption=${JSON.stringify(`Caption for ${line.id}: "quoted"`)}\ndub_timestamps=[${line.start}]\ndub_ends=[${line.end}]\ndub_characters=[${JSON.stringify(line.character)}]\n`);
    await writeFile(path.join(packDir, `${line.id}.mp3`), Buffer.from('ID3 synthetic reference fixture'));
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workshopDir, packDir, dataDir };
}

export async function addFixturePack(workshopDir, name, lines) {
  const packDir = path.join(workshopDir, name);
  await mkdir(packDir, { recursive: true });
  await writeFile(path.join(packDir, '_pack_info.ini'), `[data]\n\ntitle=${JSON.stringify(name)}\nauthors=["Runtime tests"]\nlanguage="ENG"\n`);
  await writeFile(path.join(packDir, 'dub_video.ogv'), Buffer.from('OggS synthetic video fixture'));
  await writeFile(path.join(packDir, '_backing_track.ogg'), Buffer.from('OggS synthetic backing fixture'));
  for (const line of lines) {
    await writeFile(path.join(packDir, `${line.id}.ini`), `[data]\ncaption=${JSON.stringify(`Caption for ${line.id}`)}\ndub_timestamps=[${line.start}]\ndub_ends=[${line.end}]\ndub_characters=[${JSON.stringify(line.character)}]\n`);
    await writeFile(path.join(packDir, `${line.id}.mp3`), Buffer.from('ID3 synthetic reference fixture'));
  }
  return packDir;
}

// The HTTP layer checks container signatures, not codec semantics. Browser media
// decoding is covered by browser validation; synthetic tests carry no pack media.
export const webmBytes = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.from('synthetic microphone take'),
]);

export async function startFixtureRuntime(t, options = {}) {
  const fixture = await makeFixture(t, options);
  const adminToken = 'test-admin-secret-which-is-not-a-join-token';
  const runtimeOptions = { ...fixture, adminToken, host: '127.0.0.1', port: 0, ...options };
  const runtime = await createRuntime(runtimeOptions);
  const address = await runtime.start();
  const bound = typeof address === 'object' && address !== null ? address : runtime.server.address();
  const base = `http://127.0.0.1:${bound.port}`;
  let closed = false;
  let currentMatchId = null;
  async function stop() {
    if (!closed) { closed = true; await runtime.close(); }
  }
  t.after(stop);

  async function request(route, { method = 'GET', token, body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { response, status: response.status, data };
  }
  const admin = async (route, body) => {
    const partyOnly = ['/api/admin/packs', '/api/admin/create-party', '/api/admin/next-match', '/api/admin/select', '/api/admin/settings'].includes(route);
    const payload = body === undefined ? undefined : !partyOnly && currentMatchId ? { ...body, matchId: body.matchId ?? currentMatchId } : body;
    const result = await request(route, { token: adminToken, ...(payload === undefined ? {} : { method: 'POST', body: payload }) });
    if (result.data?.session) currentMatchId = result.data.session.matchId;
    return result;
  };
  async function select() {
    const party = await admin('/api/admin/create-party', {});
    if (party.status !== 200) throw new Error(`Cannot create fixture party: ${JSON.stringify(party.data)}`);
    const result = await admin('/api/admin/packs');
    if (result.status !== 200) throw new Error(`Cannot list fixture packs: ${JSON.stringify(result.data)}`);
    const selected = await admin('/api/admin/select', { packId: result.data.packs[0].id, partyId: party.data.session.id });
    if (selected.status !== 200) throw new Error(`Cannot select fixture pack: ${JSON.stringify(selected.data)}`);
    return selected.data;
  }
  async function join(session, nickname, extra = {}) {
    const result = await request('/api/join', {
      method: 'POST', body: { roomId: session.id, joinToken: session.joinToken, nickname, ...extra },
    });
    if (result.status !== 200) throw new Error(`Cannot join fixture room: ${JSON.stringify(result.data)}`);
    const cookie = result.response.headers.get('set-cookie')?.split(';')[0];
    return { id: result.data.viewer.playerId, token: result.data.token, cookie, state: result.data };
  }
  async function upload(player, lineId, { bytes = webmBytes, type = 'audio/webm', matchId = currentMatchId, retakeId = '' } = {}) {
    const form = new FormData();
    form.append('take', new Blob([bytes], { type }), 'microphone.webm');
    return request(`/api/takes/${encodeURIComponent(lineId)}`, { method: 'POST', token: player.token, headers: {
      ...(matchId ? { 'X-Match-ID': matchId } : {}), ...(retakeId ? { 'X-Retake-ID': retakeId } : {}),
    }, body: form });
  }
  async function accept(player, lineId, takeId, { retakeId = '' } = {}) {
    return request(`/api/takes/${encodeURIComponent(lineId)}/accept`, { method: 'POST', token: player.token, body: {
      takeId, matchId: currentMatchId, ...(retakeId ? { retakeId } : {}),
    } });
  }
  return { ...fixture, runtime, runtimeOptions, base, adminToken, request, admin, select, join, upload, accept, stop };
}

export function playerProgress(snapshot, id) {
  return snapshot.session.players.find((player) => player.id === id).progress;
}

// Settings body for /api/admin/settings with sensible defaults; `rules` is the rules object.
export const matchSettings = (rules, extra = {}) => ({
  gameMode: 'character', freeRolePicking: true, allowMultipleRoles: true, maxRolesPerPlayer: 0, autoBalanceSuggestions: true,
  lockRolesWhenReady: true, referencePlaybackEnabled: true, voiceEffectsEnabled: true, compactMobilePreferred: false, ...(rules ? { rules } : {}), ...extra,
});

// Opens a player's WebSocket so the server counts them as connected (needed for dealing lines).
export async function connectPlayer(host, player, t) {
  const socket = new WebSocket(host.base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: player.cookie } });
  t.after(() => { if (socket.readyState !== WebSocket.CLOSED) socket.close(); });
  await new Promise((resolve, reject) => { socket.once('message', resolve); socket.once('error', reject); });
  return socket;
}

// A player-scoped POST that carries the current match id.
export async function playerPost(host, player, route, body = {}) {
  const state = await host.request('/api/state', { token: player.token });
  return host.request(route, { method: 'POST', token: player.token, body: { ...body, matchId: state.data.session.matchId } });
}
