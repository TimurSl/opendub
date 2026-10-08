import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivePeaks, appendLivePeaks } from '../web/recorder/live-waveform.js';

test('live peaks accumulate from microphone samples at the matching timeline bin', () => {
  const peaks = createLivePeaks(3, 20);
  appendLivePeaks(peaks, 0.12, new Float32Array([0.1, -0.8, 0.5]));
  appendLivePeaks(peaks, 0.13, new Float32Array([-0.2, 0.9]));
  appendLivePeaks(peaks, 1.1, new Float32Array([-0.4, 0.4]));
  assert.equal(peaks.recorded[2], 1);
  assert.ok(Math.abs(peaks.minima[2] + 0.8) < 1e-6);
  assert.ok(Math.abs(peaks.maxima[2] - 0.9) < 1e-6);
  assert.equal(peaks.recorded[22], 1);
  assert.equal(peaks.recorded[1], 0);
});

test('peaks ignore invalid times and clamp late samples to the final bin', () => {
  const peaks = createLivePeaks(1, 10);
  appendLivePeaks(peaks, -1, [1]);
  appendLivePeaks(peaks, Number.NaN, [1]);
  assert.equal(peaks.recorded.some(Boolean), false);
  appendLivePeaks(peaks, 2, [-0.5, 0.6, Infinity]);
  assert.equal(peaks.recorded[9], 1);
  assert.equal(peaks.minima[9], -0.5);
  assert.ok(Math.abs(peaks.maxima[9] - 0.6) < 1e-6);
});
