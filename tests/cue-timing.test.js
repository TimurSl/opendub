import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTail, capturePlan, recordedTail, referenceOverhang } from '../web/recorder/cue-timing.js';

test('a reference longer than dub_ends extends the recording window, not just the waveform', () => {
  const overhang = referenceOverhang(2, 2.5, 0.65);
  assert.equal(overhang, 0.5);
  assert.equal(captureTail(overhang, 0.65), 1.15);
});

test('old or missing reference audio keeps original cue timing', () => {
  assert.equal(referenceOverhang(2, 0), 0);
  assert.equal(referenceOverhang(2, Number.NaN), 0);
  assert.equal(referenceOverhang(2, 1.8), 0);
});

test('extra dialogue and effect decay never exceed server tail limit', () => {
  assert.equal(referenceOverhang(2, 5, 1.1), 0.9);
  assert.equal(captureTail(0.9, 1.1), 2);
  assert.equal(referenceOverhang(2, 5, 0.65), 1.25);
  assert.equal(captureTail(1.25, 0.65), 1.9);
});

test('capture deadline includes lead-in and full tail and is independent of video currentTime', () => {
  const plan = capturePlan(1000, 1180, 2, 0.5, 0.65);
  assert.deepEqual(plan, { tail: 1.15, deadlineMs: 4330, duration: 3.33 });
  assert.equal(recordedTail(1000, 4330, 0.18, 2), 1.15);
  assert.equal(recordedTail(1000, 2750, 0.18, 2), 0, 'manual early stop has no extra tail');
});
