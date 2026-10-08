import test from 'node:test';
import assert from 'node:assert/strict';
import { chromaticSnapSemitones, detectVoicedPitch } from '../web/recorder/pitch.js';

function tone(frequency, { sampleRate = 48000, length = 4096, amplitude = 0.6, phase = 0 } = {}) {
  return Float32Array.from({ length }, (_, index) => amplitude * Math.sin((2 * Math.PI * frequency * index / sampleRate) + phase));
}

function assertNear(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: got ${actual}, expected ${expected} ± ${tolerance}`);
}

test('voiced-pitch detection recognizes detuned speech-band tones and chromatic snapping uses A4 = 440 Hz', () => {
  const frequency = 450;
  const pitch = detectVoicedPitch(tone(frequency), 48000);
  assert.ok(pitch, 'a clean voiced tone passes the confidence gate');
  assertNear(pitch.frequency, frequency, 0.6, 'detected frequency');
  assert.ok(pitch.confidence >= 0.8);
  assert.ok(Number.isFinite(pitch.rms));

  const correction = chromaticSnapSemitones(pitch.frequency);
  const tunedFrequency = pitch.frequency * Math.pow(2, correction / 12);
  assertNear(tunedFrequency, 440, 0.1, 'a detuned A4 tone snaps to the nearest equal-tempered note');
  assert.ok(correction < 0, 'an above-pitch tone is corrected downward');
  assertNear(chromaticSnapSemitones(440), 0, 1e-12, 'A4 needs no correction');
  assertNear(chromaticSnapSemitones(880), 0, 1e-12, 'A5 uses the same A = 440 reference');
});

test('silence, unvoiced noise, and invalid samples do not produce a voiced-pitch correction', () => {
  assert.equal(detectVoicedPitch(new Float32Array(4096), 48000), null, 'silence is gated');
  assert.equal(detectVoicedPitch(tone(440, { amplitude: 0.001 }), 48000), null, 'very quiet input is gated');

  let seed = 0x12345678;
  const noise = Float32Array.from({ length: 4096 }, () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 0.8 - 0.4;
  });
  assert.equal(detectVoicedPitch(noise, 48000), null, 'broadband noise stays uncorrected');

  const invalid = tone(440);
  invalid[100] = Number.NaN;
  assert.equal(detectVoicedPitch(invalid, 48000), null, 'non-finite samples do not escape as a pitch');
  assert.equal(chromaticSnapSemitones(0), 0);
  assert.equal(chromaticSnapSemitones(Number.POSITIVE_INFINITY), 0);
  assert.ok(Number.isFinite(chromaticSnapSemitones(440.5)));
});

test('pitch analysis is independent across repeated recording windows', () => {
  const first = detectVoicedPitch(tone(330), 48000);
  const second = detectVoicedPitch(tone(494), 48000);
  const repeatedFirst = detectVoicedPitch(tone(330), 48000);
  assert.ok(first && second && repeatedFirst);
  assertNear(first.frequency, 330, 0.6, 'first recording');
  assertNear(second.frequency, 494, 0.6, 'second recording');
  assert.deepEqual(repeatedFirst, first, 'a new recording starts with a clean analysis result');
});
