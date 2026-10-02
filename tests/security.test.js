import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { startFixtureRuntime, webmBytes } from './helpers.js';

async function recordingHost(t, options = {}) {
  const host = await startFixtureRuntime(t, options);
  const selected = await host.select();
  const player = await host.join(selected.session, 'Recorder');
  assert.equal((await host.admin('/api/admin/distribute', {})).status, 200);
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  return { ...host, selected, player };
}

test('separate credentials protect admin, join secrets, assets, and uploaded takes', async (t) => {
  const host = await recordingHost(t);
  assert.equal((await host.request('/api/state')).status, 401);
  assert.equal((await host.request('/api/admin/packs')).status, 401);
  assert.ok([401, 403].includes((await host.request('/api/admin/packs', { token: host.player.token })).status));
  assert.ok([401, 403].includes((await host.request('/api/admin/start', { method: 'POST', token: host.player.token, body: {} })).status));
  const unauthorizedJoin = await host.request('/api/join', { method: 'POST', body: {
    roomId: host.selected.session.id, joinToken: 'wrong-token', nickname: 'Intruder',
  } });
  assert.ok([401, 403].includes(unauthorizedJoin.status));
  const snapshot = (await host.request('/api/state', { token: host.player.token })).data;
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.session.joinToken, undefined);
  assert.ok(!serialized.includes(host.adminToken));
  assert.ok(!serialized.includes(host.player.token));
  assert.ok(!serialized.includes(host.root));
  assert.ok(!serialized.includes(host.selected.session.joinToken));

  const media = snapshot.session.pack.videoUrl;
  assert.equal((await fetch(host.base + media)).status, 401);
  const authorizedMedia = await fetch(host.base + media, { headers: { Authorization: `Bearer ${host.player.token}`, Range: 'bytes=0-3' } });
  assert.equal(authorizedMedia.status, 206);
  assert.equal(Buffer.from(await authorizedMedia.arrayBuffer()).toString(), 'OggS');
  const uploaded = await host.upload(host.player, '01_alice');
  const take = uploaded.data.session.lineTakes['01_alice'];
  assert.equal((await fetch(host.base + take.url)).status, 401);

  const oldPlayerToken = host.player.token;
  await host.select();
  assert.equal((await host.request('/api/state', { token: oldPlayerToken })).status, 401);
  assert.ok([401, 403].includes((await host.request('/api/join', { method: 'POST', body: {
    roomId: host.selected.session.id, joinToken: host.selected.session.joinToken, nickname: 'Old room',
  } })).status));
});

test('login cookies carry HttpOnly and SameSite protection, and player cookies cannot call admin', async (t) => {
  const host = await recordingHost(t);
  const denied = await host.request('/api/admin/login', { method: 'POST', body: { token: 'incorrect' } });
  assert.ok([401, 403].includes(denied.status));
  const login = await host.request('/api/admin/login', { method: 'POST', body: { token: host.adminToken } });
  assert.equal(login.status, 200);
  const setCookie = login.response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(';')[0];
  assert.equal((await host.request('/api/admin/packs', { headers: { Cookie: cookie } })).status, 200);
  assert.ok([401, 403].includes((await host.request('/api/admin/packs', { headers: { Cookie: host.player.cookie } })).status));
  assert.equal((await host.request('/api/state?viewer=player', { headers: { Cookie: `${cookie}; ${host.player.cookie}` } })).data.viewer.kind, 'player');
});

test('admin pages and API enforce the host source-address allowlist, including encoded static routes', async (t) => {
  const host = await startFixtureRuntime(t);
  async function fromOtherAddress(route, body) {
    return new Promise((resolve, reject) => {
      const request = http.request(host.base + route, {
        localAddress: '127.0.0.2',
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${host.adminToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      }, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
      request.once('error', reject);
      request.end(body ? JSON.stringify(body) : undefined);
    });
  }
  // 127.0.0.2 exercises the source-address decision without depending on a LAN
  // interface in CI. The runtime's host allowlist is 127.0.0.1 / ::1 only.
  for (const route of ['/admin', '/admin.html', '/%61dmin.html', '/admin/app.js', '/%61dmin/app.js', '/api/admin/packs']) {
    assert.equal(await fromOtherAddress(route), 403, route);
  }
  assert.equal(await fromOtherAddress('/api/admin/login', { token: host.adminToken }), 403);
  assert.equal(await fromOtherAddress('/'), 200); // Player entry remains reachable.
});

test('nickname, assignment, and upload metadata are validated on the server', async (t) => {
  const host = await recordingHost(t);
  for (const nickname of ['', 'x'.repeat(256), 42, null, { html: '<script>' }]) {
    const result = await host.request('/api/join', { method: 'POST', body: {
      roomId: host.selected.session.id, joinToken: host.selected.session.joinToken, nickname,
    } });
    assert.equal(result.status, 400, JSON.stringify(result.data));
  }
  assert.ok([400, 404].includes((await host.admin('/api/admin/assign', { character: 'Unknown', playerId: host.player.id })).status));
  assert.ok([400, 404].includes((await host.admin('/api/admin/assign', { character: 'Alice', playerId: 'unknown-player' })).status));
  assert.ok([400, 404].includes((await host.upload(host.player, 'unknown-line')).status));
  const missingField = new FormData();
  missingField.append('unexpected', new Blob([webmBytes], { type: 'audio/webm' }), 'unexpected.webm');
  assert.ok([400, 413].includes((await host.request('/api/takes/01_alice', { method: 'POST', token: host.player.token, body: missingField })).status));
});

test('uploads enforce size, supported MIME, and container signatures without changing progress', async (t) => {
  const host = await recordingHost(t, { maxUploadBytes: 1024 });
  const wrongMime = await host.upload(host.player, '01_alice', { type: 'text/plain' });
  assert.ok([400, 415].includes(wrongMime.status));
  const wrongSignature = await host.upload(host.player, '01_alice', { bytes: Buffer.from('not a microphone recording'), type: 'audio/webm' });
  assert.ok([400, 415].includes(wrongSignature.status));
  const excessive = await host.upload(host.player, '01_alice', { bytes: Buffer.concat([webmBytes, Buffer.alloc(2048)]), type: 'audio/webm' });
  assert.equal(excessive.status, 413);
  const state = (await host.admin('/api/state')).data;
  assert.equal(state.session.completedLineCount, 0);
  assert.equal(state.session.lineTakes['01_alice'], undefined);
  const valid = await host.upload(host.player, '01_alice');
  assert.equal(valid.status, 200);
  assert.equal(valid.data.session.lineTakes['01_alice'].status, 'recorded');
});

test('encoded traversal and unselected pack asset IDs never expose host files', async (t) => {
  const host = await recordingHost(t);
  const packId = host.selected.session.pack.id;
  for (const route of [
    `/media/${packId}/..%2f..%2fpackage.json`,
    `/media/${packId}/%2e%2e%5c%2e%2e%5cpackage.json`,
    `/media/${packId}/%00secret`,
    `/media/unselected-pack/video`,
    '/takes/..%2f..%2fpackage.json',
  ]) {
    const result = await host.request(route, { token: host.player.token });
    assert.ok([400, 403, 404].includes(result.status), `${route}: ${result.status}`);
    assert.ok(!JSON.stringify(result.data).includes('"dependencies"'));
    assert.ok(!JSON.stringify(result.data).includes(host.root));
  }
});

test('foreign browser origins are rejected for mutations and WebSocket upgrades', async (t) => {
  const host = await recordingHost(t);
  const mutation = await host.request('/api/admin/start', { method: 'POST', token: host.adminToken, body: {}, headers: { Origin: 'https://unrelated.example' } });
  assert.equal(mutation.status, 403);
  const socket = new WebSocket(host.base.replace('http:', 'ws:') + '/ws', {
    headers: { Cookie: host.player.cookie, Origin: 'https://unrelated.example' },
  });
  const status = await new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
    socket.once('error', reject);
    socket.once('open', () => { socket.close(); reject(new Error('Foreign origin WebSocket was accepted')); });
  });
  assert.equal(status, 403);
});

test('WebSocket authenticates clients and rejects unknown commands', async (t) => {
  const host = await recordingHost(t);
  const unauthenticated = new WebSocket(host.base.replace('http:', 'ws:') + '/ws');
  const status = await new Promise((resolve, reject) => {
    unauthenticated.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
    unauthenticated.once('error', reject);
    unauthenticated.once('open', () => { unauthenticated.close(); reject(new Error('Unauthenticated WebSocket was accepted')); });
  });
  assert.equal(status, 401);
  const socket = new WebSocket(host.base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: host.player.cookie } });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
  socket.send(JSON.stringify({ type: 'admin-start-recording' }));
  assert.equal(await closed, 1008);
});

test('an in-flight upload is stale after host requests a retake on an empty line', async (t) => {
  const host = await recordingHost(t);
  const boundary = 'runtime-slow-upload-test-boundary';
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="take"; filename="voice.webm"\r\nContent-Type: audio/webm\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const result = new Promise((resolve, reject) => {
    const upload = http.request(host.base + '/api/takes/01_alice', { method: 'POST', headers: {
      Authorization: `Bearer ${host.player.token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': prefix.length + webmBytes.length + tail.length,
    } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    upload.on('error', reject);
    upload.write(prefix);
    upload.write(webmBytes.subarray(0, 4));
    // The body remains incomplete while the host invalidates the line. The
    // server must capture a generation before multipart parsing, even with no
    // prior candidate. This catches the null-old-take ABA race.
    setTimeout(async () => {
      try {
        const retake = await host.admin('/api/admin/retake', { lineId: '01_alice' });
        assert.equal(retake.status, 200);
        upload.end(Buffer.concat([webmBytes.subarray(4), tail]));
      } catch (error) { upload.destroy(error); reject(error); }
    }, 100);
  });
  const response = await result;
  assert.ok([403, 409].includes(response.status), response.body);
  const state = (await host.admin('/api/state')).data;
  assert.equal(state.session.lineTakes['01_alice'], undefined);
  assert.equal(state.session.completedLineCount, 0);
});
