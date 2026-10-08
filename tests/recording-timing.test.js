import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../server/session/store.js';

test('new take lead-in and tail metadata survives session snapshots and old takes default to zero', () => {
  const store = new SessionStore({ packs: [], dataDir: '.' });
  store.data.lineTakes.a = { id: 'a-new', playerId: 'p', status: 'accepted', leadIn: 0.18, tail: 0.65 };
  store.data.lineTakes.b = { id: 'b-old', playerId: 'p', status: 'accepted' };
  store.data.replacementTakes.a = { id: 'a-replace', playerId: 'p', status: 'recorded', leadIn: 0.22, tail: 1.1 };
  const result = store.snapshot({ kind: 'player', playerId: 'p' });
  assert.deepEqual([result.session.lineTakes.a.leadIn, result.session.lineTakes.a.tail], [0.18, 0.65]);
  assert.deepEqual([result.session.lineTakes.b.leadIn, result.session.lineTakes.b.tail], [0, 0]);
  assert.deepEqual([result.session.replacementTakes.a.leadIn, result.session.replacementTakes.a.tail], [0.22, 1.1]);
  assert.equal(store.snapshot({ kind: 'admin' }).session.replacementTakes.a, undefined);
});
