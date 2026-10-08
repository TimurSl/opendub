import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTail, capturePlan, recordedTail } from '../web/recorder/cue-timing.js';

test('post-roll stays bounded and has no dependency on the length of the MP3', () => {
  assert.equal(captureTail(0.65), 0.65);
  assert.equal(captureTail(1.1), 1.1);
  assert.equal(captureTail(25), 2);
  assert.equal(captureTail(-1), 0);
});

test('cue end and final recorder deadline depend only on the INI and effect tail', () => {
  const plan = capturePlan(1000, 1180, 2, 0.65);
  assert.deepEqual(plan, { tail: 0.65, deadlineMs: 3830, duration: 2.83 });
  assert.equal(recordedTail(1000, 3830, 0.18, 2), 0.65);
  assert.equal(recordedTail(1000, 2750, 0.18, 2), 0);
});
