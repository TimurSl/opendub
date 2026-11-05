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

test('quiet waveforms are scaled up to fill the canvas, with a capped gain for silence', async () => {
  const { waveformGain, samplePeak, livePeak, WAVEFORM_MAX_GAIN } = await import('../web/recorder/live-waveform.js');
  // A quiet take peaking at 0.05 used to draw ~1px tall; it must now fill the height.
  assert.ok(Math.abs(waveformGain(0.2) * 0.2 - 1) < 1e-9);
  assert.equal(waveformGain(1), 1);
  assert.ok(waveformGain(2) < 1, 'clipping audio is scaled down to fit');
  assert.equal(waveformGain(0.001), WAVEFORM_MAX_GAIN, 'noise floor is not blown up into a block');
  assert.equal(waveformGain(0), 1);
  assert.equal(waveformGain(Number.NaN), 1);
  assert.ok(Math.abs(samplePeak(new Float32Array([0.01, -0.3, 0.2, Infinity])) - 0.3) < 1e-6);
  assert.ok(Math.abs(samplePeak(new Float32Array([0.9, 0.1, 0.2]), 1, 3) - 0.2) < 1e-6, 'peak respects the visible range');
  const peaks = createLivePeaks(1, 10);
  assert.equal(livePeak(peaks), 0);
  appendLivePeaks(peaks, 0.1, [0.02, -0.07]);
  appendLivePeaks(peaks, 0.5, [0.04]);
  assert.ok(Math.abs(livePeak(peaks) - 0.07) < 1e-6, 'running peak follows the loudest captured sample');
});
