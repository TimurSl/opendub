import test from 'node:test';
import assert from 'node:assert/strict';
import { detectVoicedPitch } from '../web/recorder/pitch.js';

const sampleRateHz = 48000;
const blockSize = 128;
const recordingFrames = blockSize * 38;
let importCount = 0;

async function createProcessor(t) {
  const names = ['AudioWorkletProcessor', 'sampleRate', 'registerProcessor'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const registered = new Map();
  class WorkletBase {
    constructor() {
      this.port = { onmessage: null, messages: [], postMessage(message) { this.messages.push(message); } };
    }
  }
  Object.defineProperty(globalThis, 'AudioWorkletProcessor', { value: WorkletBase, configurable: true });
  Object.defineProperty(globalThis, 'sampleRate', { value: sampleRateHz, configurable: true });
  Object.defineProperty(globalThis, 'registerProcessor', { value: (name, processor) => registered.set(name, processor), configurable: true });
  t.after(() => {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  await import(`../web/recorder/effect-processor.js?worklet-test=${++importCount}`);
  const Processor = registered.get('voice-effect-processor');
  assert.ok(Processor, 'the module registers its audio worklet processor');
  return new Processor();
}

function toneBlock(frequency, firstFrame, length = blockSize, amplitude = 0.6) {
  return Float32Array.from({ length }, (_, index) => amplitude * Math.sin(2 * Math.PI * frequency * (firstFrame + index) / sampleRateHz));
}

function noiseBlock(firstFrame, length = blockSize) {
  let seed = (0x12345678 + firstFrame) >>> 0;
  return Float32Array.from({ length }, () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 0.8 - 0.4;
  });
}

function repeatedNoise(frames) {
  const input = new Float32Array(frames);
  for (let offset = 0; offset < frames; offset += blockSize) input.set(noiseBlock(offset), offset);
  return input;
}

function render(processor, input) {
  assert.equal(input.length % blockSize, 0);
  const output = new Float32Array(input.length);
  let frameCount = 0;
  for (let offset = 0; offset < input.length; offset += blockSize) {
    const inputBlock = input.subarray(offset, offset + blockSize);
    const outputBlock = new Float32Array(blockSize);
    assert.equal(processor.process([[inputBlock]], [[outputBlock]]), true);
    output.set(outputBlock, offset);
    frameCount += outputBlock.length;
  }
  return { output, frameCount };
}

function repeatedTone(frequency, frames, startFrame = 0) {
  return Float32Array.from({ length: frames }, (_, index) => 0.6 * Math.sin(2 * Math.PI * frequency * (startFrame + index) / sampleRateHz));
}

test('AUTO-TUNE worklet gates unvoiced audio, tracks pitch transitions, resets between recordings, and preserves finite frame-aligned output', async t => {
  const processor = await createProcessor(t);
  processor.port.onmessage({ data: { type: 'configure', effect: 'autoTune' } });
  processor.port.onmessage({ data: { type: 'begin', duration: 2 } });

  const detuned = render(processor, repeatedTone(450, recordingFrames));
  assert.equal(detuned.frameCount, recordingFrames, 'worklet output duration matches input duration');
  assert.ok([...detuned.output].every(Number.isFinite), 'detuned-tone output remains finite');
  assert.ok(processor.autoTuneVoiced, 'a sustained tone passes the voiced-pitch gate');
  assert.ok(processor.autoTuneTarget < -2, 'hard tuning makes a clearly audible correction toward G4');
  const measuredFirst = detectVoicedPitch(detuned.output.subarray(3000), sampleRateHz);
  assert.ok(measuredFirst, 'corrected output remains voiced');
  assert.ok(Math.abs(measuredFirst.frequency - 392) < 9, `hard-tuned output must reach G4, not stay at 450 Hz; got ${measuredFirst.frequency} Hz`);

  const transition = render(processor, repeatedTone(330, recordingFrames, recordingFrames));
  assert.equal(transition.frameCount, recordingFrames);
  assert.ok([...transition.output].every(Number.isFinite));
  assert.ok(processor.autoTuneVoiced);
  assert.ok(Math.abs(processor.autoTuneTarget) < 0.15, `330 Hz should remain near E4 in the C-major triad; got ${processor.autoTuneTarget} semitones`);

  processor.port.onmessage({ data: { type: 'begin', duration: 2 } });
  assert.equal(processor.frame, 0);
  assert.equal(processor.autoTuneTarget, 0);
  assert.equal(processor.autoTuneSemitones, 0);
  assert.equal(processor.autoTuneWet, 0);
  assert.equal(processor.autoTuneVoiced, false);
  const silence = render(processor, new Float32Array(blockSize * 19));
  assert.equal(silence.frameCount, blockSize * 19);
  assert.ok([...silence.output].every(Number.isFinite));
  assert.equal(processor.autoTuneVoiced, false, 'silence passes without pitch correction');

  processor.port.onmessage({ data: { type: 'begin', duration: 2 } });
  const noiseInput = repeatedNoise(recordingFrames);
  const noise = render(processor, noiseInput);
  assert.equal(noise.frameCount, noiseInput.length);
  assert.ok([...noise.output].every(Number.isFinite));
  assert.equal(processor.autoTuneVoiced, false, 'broadband noise remains unvoiced');
});


test('pitch effects actually change fundamentals instead of silently leaving speech unchanged', async t => {
  const processor = await createProcessor(t);
  const frames = blockSize * 80;
  const baseFrequency = 210;
  const expected = { goblin: 210 * 2 ** (6.5 / 12), demon: 210 * 2 ** (-6 / 12), chipmunk: 210 * 2 ** (11 / 12), giant: 210 * 2 ** (-10 / 12) };
  for (const [effect, target] of Object.entries(expected)) {
    processor.port.onmessage({ data: { type: 'configure', effect } });
    processor.port.onmessage({ data: { type: 'begin', duration: 2 } });
    const output = render(processor, repeatedTone(baseFrequency, frames)).output;
    assert.ok(output.every(Number.isFinite), `${effect} produces valid samples`);
    const measured = detectVoicedPitch(output.subarray(frames - 4096), sampleRateHz, { confidenceThreshold: 0.65 });
    assert.ok(measured, `${effect} produces pitched sound`);
    assert.ok(Math.abs(measured.frequency - target) < target * 0.08, `${effect} should shift ${baseFrequency} Hz near ${target.toFixed(1)} Hz, got ${measured.frequency.toFixed(1)} Hz`);
  }
});

test('worklet only changes audio for its selected effect; normal and click effects work', async t => {
  const processor = await createProcessor(t);
  const frames = blockSize * 28;
  const source = repeatedTone(210, frames);
  processor.port.onmessage({ data: { type: 'configure', effect: 'normal' } });
  assert.deepEqual(render(processor, source).output, source, 'normal passes samples through exactly');
  processor.port.onmessage({ data: { type: 'configure', effect: 'walkieTalkie' } });
  processor.port.onmessage({ data: { type: 'begin', duration: 1 } });
  const clicked = render(processor, new Float32Array(frames)).output;
  assert.ok(clicked.some(sample => Math.abs(sample) > 0.05), 'walkie-talkie has an audible start click');
  processor.port.onmessage({ data: { type: 'endingClick' } });
  const ending = render(processor, new Float32Array(frames)).output;
  assert.ok(ending.some(sample => Math.abs(sample) > 0.05), 'walkie-talkie has an audible end click');
});
