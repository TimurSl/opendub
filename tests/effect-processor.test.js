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
  assert.ok(processor.autoTuneTarget < -0.25, 'the 450 Hz tone is directed down toward A4');
  const measuredFirst = detectVoicedPitch(detuned.output.subarray(3000), sampleRateHz);
  assert.ok(measuredFirst, 'corrected output remains voiced');
  assert.ok(Math.abs(measuredFirst.frequency - 440) < 16, `corrected output should approach A4; got ${measuredFirst.frequency} Hz`);

  const transition = render(processor, repeatedTone(330, recordingFrames, recordingFrames));
  assert.equal(transition.frameCount, recordingFrames);
  assert.ok([...transition.output].every(Number.isFinite));
  assert.ok(processor.autoTuneVoiced);
  assert.ok(Math.abs(processor.autoTuneTarget) < 0.15, `330 Hz should snap near E4; got ${processor.autoTuneTarget} semitones`);

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
