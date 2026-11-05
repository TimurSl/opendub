import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { startFixtureRuntime, webmBytes } from './helpers.js';

async function recordingHost(t, options = {}) {
  const host = await startFixtureRuntime(t, options);
  const selected = await host.select();
  assert.equal((await host.admin('/api/admin/open-lobby', {})).status, 200);
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

test('admin API from another address requires the admin token, and plain-HTTP login is refused', async (t) => {
  // Admin is no longer restricted to the host PC: public admin access uses
  // opendub-auth tokens (see docs/NIXOS_STANDALONE.md). The static login page
  // is public; every admin API call still needs the token.
  const host = await startFixtureRuntime(t);
  async function fromOtherAddress(route, body, { token = host.adminToken } = {}) {
    return new Promise((resolve, reject) => {
      const request = http.request(host.base + route, {
        localAddress: '127.0.0.2',
        method: body ? 'POST' : 'GET',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      }, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
      request.once('error', reject);
      request.end(body ? JSON.stringify(body) : undefined);
    });
  }
  // 127.0.0.2 exercises the non-local source-address path without a LAN interface.
  assert.equal(await fromOtherAddress('/api/admin/packs', undefined, { token: null }), 401);
  assert.equal(await fromOtherAddress('/api/admin/packs', undefined, { token: 'wrong-token-wrong-token-wrong-token' }), 401);
  assert.equal(await fromOtherAddress('/api/admin/packs'), 200);
  assert.equal(await fromOtherAddress('/api/admin/create-party', {}, { token: null }), 401);
  // Sending the token over plain HTTP from another machine would leak it.
  assert.equal(await fromOtherAddress('/api/admin/login', { token: host.adminToken }, { token: null }), 403);
  assert.equal(await fromOtherAddress('/'), 200); // Player entry remains reachable.
});

test('nickname, assignment, and upload metadata are validated on the server', async (t) => {
  const lobby = await startFixtureRuntime(t);
  const selected = await lobby.select();
  assert.equal((await lobby.admin('/api/admin/open-lobby', {})).status, 200);
  for (const nickname of ['', 'x'.repeat(256), 42, null, { html: '<script>' }]) {
    const result = await lobby.request('/api/join', { method: 'POST', body: {
      roomId: selected.session.id, joinToken: selected.session.joinToken, nickname,
    } });
    assert.equal(result.status, 400, JSON.stringify(result.data));
  }
  const host = await recordingHost(t);
  assert.ok([400, 404].includes((await host.admin('/api/admin/assign', { character: 'Unknown', playerId: host.player.id })).status));
  assert.ok([400, 404].includes((await host.admin('/api/admin/assign', { character: 'Alice', playerId: 'unknown-player' })).status));
  assert.ok([400, 404].includes((await host.upload(host.player, 'unknown-line')).status));
  const missingField = new FormData();
  missingField.append('unexpected', new Blob([webmBytes], { type: 'audio/webm' }), 'unexpected.webm');
  const matchId = (await host.admin('/api/state')).data.session.matchId;
  assert.ok([400, 413].includes((await host.request('/api/takes/01_alice', { method: 'POST', token: host.player.token, headers: { 'X-Match-ID': matchId }, body: missingField })).status));
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

// These are the requests Nginx sends over WireGuard after terminating HTTPS.
// node:http preserves Host, unlike fetch implementations that override it.
function proxyRequest(host, route, { body, headers = {}, localAddress = '127.0.0.2' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(host.base + route, {
      localAddress, method: body === undefined ? 'GET' : 'POST',
      headers: Object.fromEntries(Object.entries({
        Host: 'dub.example.com', Origin: 'https://dub.example.com',
        'X-Forwarded-Proto': 'https', 'Sec-Fetch-Site': 'same-origin',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
      }).filter(([, value]) => value !== undefined)),
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: response.statusCode, headers: response.headers, data });
      });
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function proxySocket(host, cookie, headers = {}, localAddress = '127.0.0.2') {
  return new WebSocket(host.base.replace('http:', 'ws:') + '/ws?viewer=player', {
    localAddress, headers: {
      Host: 'dub.example.com', Origin: 'https://dub.example.com',
      'X-Forwarded-Proto': 'https', Cookie: cookie, ...headers,
    },
  });
}

async function rejectedSocket(socket) {
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume(); socket.terminate(); resolve(response.statusCode);
    });
    socket.once('error', error => { if (!error.message.includes('before the connection')) reject(error); });
    socket.once('open', () => { socket.terminate(); reject(new Error('Rejected origin WebSocket was accepted')); });
  });
}

test('trusted HTTPS proxy supports joining, cookies, player actions, media, and WebSockets over HTTP', async t => {
  // An expanded IPv4-mapped address must match the real IPv4 connection too.
  const host = await startFixtureRuntime(t, { trustedProxy: ' ::ffff:7f00:2 , 2001:db8::1 ' });
  const selected = await host.select();
  assert.equal((await host.admin('/api/admin/open-lobby', {})).status, 200);
  assert.equal((await proxyRequest(host, '/join/' + selected.session.id)).status, 200);
  const joined = await proxyRequest(host, '/api/join', { body: {
    roomId: selected.session.id, joinToken: selected.session.joinToken, nickname: 'Proxy player',
  } });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  const cookieHeader = joined.headers['set-cookie'][0];
  assert.match(cookieHeader, /; Secure/i);
  assert.match(cookieHeader, /; HttpOnly/i);
  assert.match(cookieHeader, /; SameSite=Strict/i);
  const cookie = cookieHeader.split(';')[0];
  const headers = { Cookie: cookie };
  assert.equal((await proxyRequest(host, '/api/state?viewer=player', { headers })).status, 200);
  assert.equal((await proxyRequest(host, '/api/player/claim', { headers, body: { character: 'Alice', matchId: joined.data.session.matchId } })).status, 200);
  const media = await proxyRequest(host, joined.data.session.pack.videoUrl, { headers: { ...headers, Range: 'bytes=0-3' } });
  assert.equal(media.status, 206);
  assert.equal(media.data, 'OggS');
  const socket = proxySocket(host, cookie);
  t.after(() => socket.terminate());
  const state = await new Promise((resolve, reject) => {
    socket.once('message', message => resolve(JSON.parse(message)));
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      response.resume(); reject(new Error('Proxy WebSocket rejected: ' + response.statusCode));
    });
  });
  assert.equal(state.viewer.playerId, joined.data.viewer.playerId);
  // Proxy trust never grants admin access by itself: a spoofed client IP
  // without the token is rejected, and only the real admin token works.
  assert.equal((await proxyRequest(host, '/api/admin/packs', {
    headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' },
  })).status, 401);
  assert.equal((await proxyRequest(host, '/api/admin/login', {
    body: { token: 'not-the-admin-token-not-the-admin-token' }, headers: { 'X-Forwarded-For': '127.0.0.1' },
  })).status, 401);
  assert.equal((await proxyRequest(host, '/api/admin/login', {
    body: { token: host.adminToken },
  })).status, 200);
  assert.equal((await proxyRequest(host, '/api/admin/packs', {
    headers: { Authorization: 'Bearer ' + host.adminToken },
  })).status, 200);
});

test('forwarded HTTPS is ignored without explicit proxy trust, including PUBLIC_LINK', async t => {
  for (const options of [{ trustedProxy: '' }, { trustedProxy: '', publicLink: 'https://dub.example.com' }, { trustedProxy: '127.0.0.3' }]) {
    const host = await startFixtureRuntime(t, options);
    const selected = await host.select();
    const body = { roomId: selected.session.id, joinToken: selected.session.joinToken, nickname: 'Untrusted' };
    const joined = await proxyRequest(host, '/api/join', { body });
    assert.equal(joined.status, 403);
    assert.equal(joined.data.error, 'Origin does not match runtime');
    const direct = await proxyRequest(host, '/api/join', {
      body, headers: { Origin: 'http://dub.example.com' },
    });
    assert.equal(direct.status, 200);
    assert.doesNotMatch(direct.headers['set-cookie'][0], /; Secure/i);
    assert.equal(await rejectedSocket(proxySocket(host, direct.headers['set-cookie'][0].split(';')[0])), 403);
  }
});

test('trusted proxies still reject foreign origins, rewritten hosts, and ambiguous forwarded schemes', async t => {
  const host = await startFixtureRuntime(t, { trustedProxy: '127.0.0.2' });
  const selected = await host.select();
  const player = await host.join(selected.session, 'Local player');
  const body = { roomId: selected.session.id, joinToken: selected.session.joinToken, nickname: 'Rejected' };
  for (const headers of [
    { Origin: 'https://unrelated.example' },
    { Host: 'internal.example', 'X-Forwarded-Host': 'dub.example.com' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'X-Forwarded-Proto': 'https,http' },
    { 'X-Forwarded-Proto': 'https, https' },
    { 'X-Forwarded-Proto': 'HTTPS' },
    { 'X-Forwarded-Proto': 'ftp' },
    { 'X-Forwarded-Proto': '' },
    { 'X-Forwarded-Proto': ['https', 'https'] },
  ]) {
    assert.equal((await proxyRequest(host, '/api/join', { body, headers })).status, 403, JSON.stringify(headers));
    assert.equal(await rejectedSocket(proxySocket(host, player.cookie, headers)), 403, JSON.stringify(headers));
  }
  // A trusted address without a forwarded scheme falls back to the actual HTTP transport.
  const fallback = await proxyRequest(host, '/api/join', {
    body, headers: { Origin: 'http://dub.example.com', 'X-Forwarded-Proto': undefined },
  });
  assert.equal(fallback.status, 200);
  assert.doesNotMatch(fallback.headers['set-cookie'][0], /; Secure/i);
});

test('proxy trust configuration accepts only explicit IP addresses', async t => {
  for (const trustedProxy of [true, '*', '10.0.0.0/8', 'localhost', 'fe80::1%wg0', '127.0.0.1,', '127.0.0.1,,127.0.0.2']) {
    await assert.rejects(() => startFixtureRuntime(t, { trustedProxy }), /TRUSTED_PROXY/);
  }
});
