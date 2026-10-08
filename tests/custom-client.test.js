import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeClient } from '../web/shared/api.js';

test('Custom client sends binary recording with match/retake tokens and handles WebM response', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const client = new RuntimeClient('player');
  client.state = { session: { matchId: 'match-123' } };
  globalThis.fetch = async (route, options) => {
    assert.equal(route, '/api/takes/line%2Fwith%20space/custom');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['X-Match-ID'], 'match-123');
    assert.equal(options.headers['X-Retake-ID'], 'retake-456');
    assert.equal(options.body.get('args'), '-af volume=2');
    assert.ok(options.body.get('take') instanceof Blob);
    return new Response(new Blob(['webm'], { type: 'audio/webm' }), { headers: { 'Content-Type': 'audio/webm' } });
  };
  const result = await client.processCustomAudio('line/with space', new Blob(['input'], { type: 'audio/webm' }), '-af volume=2', 'retake-456');
  assert.equal(await result.text(), 'webm');
});

test('Custom client surfaces server validation errors instead of saving the raw take', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const client = new RuntimeClient('player');
  client.state = { session: { matchId: 'match' } };
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Custom: filter not permitted' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(client.processCustomAudio('line', new Blob(['input'], { type: 'audio/webm' }), '-af amovie=/etc/passwd'), /not permitted/);
});
