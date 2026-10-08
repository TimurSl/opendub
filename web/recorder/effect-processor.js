import { detectVoicedPitch, scaleSnapSemitones } from './pitch.js';

const TAU = Math.PI * 2;
// A deliberately obvious, robotic correction instead of nearly inaudible
// nearest-semitone tuning of speech. C major triad repeats every octave.
const AUTO_TUNE_NOTES = [0, 4, 7];

class VoiceEffectProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.effect = 'normal';
    this.historySize = 8192;
    this.history = [new Float32Array(this.historySize), new Float32Array(this.historySize)];
    this.pitchWindowSize = Math.floor(sampleRate * 0.036);
    this.pitchWindow = new Float32Array(Math.ceil(this.pitchWindowSize / 4));
    this.pitchAnalysisRate = sampleRate / 4;
    this.analysisStep = Math.max(1, Math.floor(sampleRate * 0.015));
    this.randomState = 0x6d2b79f5;
    this.port.onmessage = event => this.onMessage(event.data || {});
    this.reset();
  }

  onMessage(message) {
    if (message.type === 'configure') {
      this.effect = message.effect || 'normal';
      this.reset();
    } else if (message.type === 'begin') {
      this.reset();
      if (this.effect === 'walkieTalkie') this.startClick();
    } else if (message.type === 'endingClick' && this.effect === 'walkieTalkie') {
      this.startClick();
    }
  }

  reset() {
    this.frame = 0;
    this.ringIndex = 0;
    this.crushCounter = 0;
    this.crushHeld = [0, 0];
    this.dropoutFrames = 0;
    this.nextDropout = Math.round(sampleRate * 0.9);
    this.clickFrames = 0;
    this.clickLength = 0;
    this.lastAutoTuneFrame = -1;
    this.autoTuneTarget = 0;
    this.autoTuneSemitones = 0;
    this.autoTuneWet = 0;
    this.autoTuneVoiced = false;
    this.lastVoicedFrame = -Infinity;
    this.history.forEach(channel => channel.fill(0));
    this.pitchWindow.fill(0);
  }

  random() {
    let value = this.randomState;
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    this.randomState = value >>> 0;
    return this.randomState / 0x100000000;
  }

  startClick() {
    this.clickLength = Math.floor(sampleRate * 0.026);
    this.clickFrames = this.clickLength;
  }

  readHistory(channel, delay) {
    let position = this.ringIndex - delay;
    if (position < 0) position += this.historySize;
    const left = Math.floor(position) % this.historySize;
    const right = (left + 1) % this.historySize;
    const fraction = position - Math.floor(position);
    const samples = this.history[channel];
    return samples[left] * (1 - fraction) + samples[right] * fraction;
  }

  pitchSample(channel, delayA, delayB, weightA) {
    return this.readHistory(channel, delayA) * weightA + this.readHistory(channel, delayB) * (1 - weightA);
  }

  analyzePitch() {
    const n = this.pitchWindow.length;
    // Downsample 48 kHz microphone audio to 12 kHz before YIN-style analysis.
    // This is far cheaper than analyzing every microphone sample on the realtime thread.
    for (let index = 0; index < n; index++) {
      const offset = index * 4;
      let sum = 0;
      for (let step = 0; step < 4; step++) {
        const at = (this.ringIndex - this.pitchWindowSize + offset + step + this.historySize) % this.historySize;
        sum += this.history[0][at];
      }
      this.pitchWindow[index] = sum * 0.25;
    }
    const pitch = detectVoicedPitch(this.pitchWindow, this.pitchAnalysisRate, { minimumFrequency: 70, maximumFrequency: 750, confidenceThreshold: 0.73 });
    if (pitch) {
      this.lastVoicedFrame = this.frame;
      this.autoTuneTarget = scaleSnapSemitones(pitch.frequency, AUTO_TUNE_NOTES);
    }
    // Briefly hold a detected note through small unstable/noisy voice regions.
    // Longer unvoiced stretches are left untreated for intelligibility.
    this.autoTuneVoiced = this.frame - this.lastVoicedFrame < sampleRate * 0.065;
    if (!this.autoTuneVoiced) this.autoTuneTarget = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    if (!output.length) return true;
    const sourceL = input[0];
    const sourceR = input[1] || sourceL;
    const outL = output[0];
    const outR = output[1];
    const effect = this.effect;
    const shifting = ['autoTune', 'goblin', 'demon', 'chipmunk', 'giant'].includes(effect);
    const pitchPeriod = Math.max(1, Math.floor(sampleRate * 0.07));
    const minimumDelay = sampleRate * 0.004;
    const smoothing = 1 - Math.exp(-1 / (sampleRate * 0.009));
    const gateSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.012));

    for (let index = 0; index < outL.length; index++) {
      const dryL = sourceL?.[index] || 0;
      const dryR = sourceR?.[index] || 0;
      this.history[0][this.ringIndex] = dryL;
      this.history[1][this.ringIndex] = dryR;
      let left = dryL; let right = dryR;

      if (shifting) {
        let semitones = 0;
        if (effect === 'goblin') semitones = 6.5;
        else if (effect === 'demon') semitones = -6;
        else if (effect === 'chipmunk') semitones = 11;
        else if (effect === 'giant') semitones = -10;
        else {
          if (this.frame - this.lastAutoTuneFrame >= this.analysisStep) {
            this.lastAutoTuneFrame = this.frame;
            if (this.frame >= this.pitchWindowSize) this.analyzePitch();
          }
          this.autoTuneSemitones += (this.autoTuneTarget - this.autoTuneSemitones) * smoothing;
          this.autoTuneWet += (Number(this.autoTuneVoiced) - this.autoTuneWet) * gateSmoothing;
          semitones = this.autoTuneSemitones;
        }
        const ratio = Math.pow(2, semitones / 12);
        const span = Math.abs(ratio - 1) * pitchPeriod;
        const phase = (this.frame % pitchPeriod) / pitchPeriod;
        const phaseB = (phase + 0.5) % 1;
        const delayA = minimumDelay + (ratio >= 1 ? span * (1 - phase) : span * phase);
        const delayB = minimumDelay + (ratio >= 1 ? span * (1 - phaseB) : span * phaseB);
        const weightA = 0.5 - 0.5 * Math.cos(TAU * phase);
        const shiftedL = this.pitchSample(0, delayA, delayB, weightA);
        const shiftedR = this.pitchSample(1, delayA, delayB, weightA);
        const wet = effect === 'autoTune' ? this.autoTuneWet : 1;
        left = dryL * (1 - wet) + shiftedL * wet;
        right = dryR * (1 - wet) + shiftedR * wet;
      } else if (effect === 'badInternet') {
        const period = Math.max(1, Math.floor(sampleRate / 6500));
        if (this.crushCounter === 0) {
          this.crushHeld[0] = Math.round(dryL * 16) / 16;
          this.crushHeld[1] = Math.round(dryR * 16) / 16;
        }
        left = this.crushHeld[0]; right = this.crushHeld[1];
        this.crushCounter = (this.crushCounter + 1) % period;
        if (this.dropoutFrames > 0) { left = 0; right = 0; this.dropoutFrames--; }
        else if (this.frame >= this.nextDropout) {
          this.dropoutFrames = Math.floor(sampleRate * (0.045 + this.random() * 0.1));
          this.nextDropout = this.frame + Math.floor(sampleRate * (0.55 + this.random() * 0.75));
        }
      } else if (effect === 'walkieTalkie' && this.clickFrames > 0) {
        const elapsed = this.clickLength - this.clickFrames;
        const envelope = this.clickFrames / Math.max(1, this.clickLength);
        const click = Math.sin(TAU * (680 + elapsed * 0.23) * elapsed / sampleRate) * envelope * 0.32;
        left += click; right += click;
        this.clickFrames--;
      }

      outL[index] = Math.max(-1, Math.min(1, left));
      if (outR) outR[index] = Math.max(-1, Math.min(1, right));
      this.ringIndex = (this.ringIndex + 1) % this.historySize;
      this.frame++;
    }
    return true;
  }
}

registerProcessor('voice-effect-processor', VoiceEffectProcessor);
