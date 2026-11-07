import test from 'node:test';
import assert from 'node:assert/strict';
import { modeBadges, speedState, describeConstraint } from '../web/player/extras.js';

const session = (rules = {}, extra = {}) => ({ pack: { lines: [] }, rules: { mode: 'character', relayEvery: 3, speed: { enabled: false, lineTimeLimitSec: 10 }, mystery: false, cards: { enabled: false }, takeLimit: 0, ...rules }, ...extra });

test('mode badges name only the rules that change how a match plays', () => {
  assert.deepEqual(modeBadges(session()), []);
  assert.deepEqual(modeBadges(session({ mode: 'duet', mystery: true, cards: { enabled: true } })), ['DUET', 'MYSTERY', 'CARDS']);
  assert.deepEqual(modeBadges(session({ mode: 'relay', relayEvery: 1, speed: { enabled: true } })), ['RELAY · every 1 line', 'SPEED ROUND']);
  assert.deepEqual(modeBadges(session({ takeLimit: 1 })), ['ONE TAKE']);
  assert.deepEqual(modeBadges({ rules: { mode: 'duet' }, pack: null }), []);
});

test('speed state mirrors the server clock for one line', () => {
  const speed = { speed: { enabled: true, lineTimeLimitSec: 10 } };
  assert.deepEqual(speedState(session(), 'a', null, 0), { enabled: false, canRecord: true, phase: 'off' });
  assert.equal(speedState(session(speed), 'a', null, 0).phase, 'idle');
  assert.equal(speedState(session(speed), 'a', null, 0).canRecord, false, 'recording waits for START');
  const running = session(speed, { lineClocks: { a: { openedAt: 0, deadline: 5000 } } });
  assert.deepEqual(speedState(running, 'a', null, 1000), { enabled: true, canRecord: true, phase: 'running', remaining: 4000 });
  assert.deepEqual(speedState(running, 'a', null, 5000), { enabled: true, canRecord: false, phase: 'expired', remaining: 0 });
  assert.equal(speedState(running, 'a', { id: 't' }, 9000).canRecord, true, 'a saved take can still be accepted after the clock');
  assert.equal(speedState(running, 'a', { id: 't' }, 9000).phase, 'taken');
  assert.equal(speedState(running, 'b', null, 1000).phase, 'idle', 'every line has its own clock');
});

test('constraint cards are described in plain words for the player', () => {
  assert.equal(describeConstraint({ blind: { caption: true, reference: true }, takeLimit: 1 }), 'Rules for you: you cannot read the caption, you cannot hear the original, you get 1 take per line.');
  assert.equal(describeConstraint({ takeLimit: 3 }), 'Rules for you: you get 3 takes per line.');
  assert.equal(describeConstraint(null), '');
});
