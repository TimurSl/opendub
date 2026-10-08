import { chromaticSnapSemitones, detectVoicedPitch } from './pitch.js';

const TAU = Math.PI * 2;

class VoiceEffectProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.effect = 'normal';
    this.frame = 0;
    this.ringIndex = 0;
    this.historySize = 8192;
    this.history = [new Float32Array(this.historySize), new Float32Array(this.historySize)];
    this.cloneHistory = [new Float32Array(this.historySize), new Float32Array(this.historySize)];
    this.cloneIndex = 0;
    this.crushHeld = [0, 0];
    this.crushCounter = 0;
    this.dropoutFrames = 0;
    this.nextDropout = Math.round(sampleRate * 1.7);
    this.randomState = 0x6d2b79f5;
    this.ringPhase = 0;
    this.clickFrames = 0;
    this.clickLength = 0;
    this.reverseLeadSize = Math.max(1, Math.floor(sampleRate * 0.06));
    this.reverseLead = [new Float32Array(this.reverseLeadSize), new Float32Array(this.reverseLeadSize)];
    this.reverseLeadCount = 0;
    this.reverseIndex = 0;
    this.reverseStage = 'capture';
    this.reverseEnded = false;
    this.reverseDrained = false;
    this.reverseHasSpeech = false;
    this.drunkSemitones = 0;
    this.drunkTarget = 0;
    this.nextDrunkChange = 0;
    this.fifoSize = 16384;
    this.fifo = [new Float32Array(this.fifoSize), new Float32Array(this.fifoSize)];
    this.fifoRead = 0;
    this.fifoWrite = 0;
    this.fifoCount = 0;
    this.cursedEchoSize = Math.max(1, Math.floor(sampleRate * 0.065));
    this.cursedEcho = [new Float32Array(this.cursedEchoSize), new Float32Array(this.cursedEchoSize)];
    this.cursedEchoPosition = -1;
    this.cursedSilenceFrames = 0;
    this.cursedSpeechFrames = 0;
    this.cursedWasSpeaking = false;
    this.speedLeadFrames = 0;
    this.speedStarted = false;
    this.speedEnded = false;
    this.speedDrained = false;
    this.speedFraction = 0;
    this.speedReadRate = 1;
    this.speedTarget = 1;
    this.nextSpeedChange = 0;
    this.pitchWindowSize = Math.floor(sampleRate * 0.036);
    this.pitchWindow = new Float32Array(this.pitchWindowSize);
    this.autoTuneFrameStep = Math.max(1, Math.floor(sampleRate * 0.01));
    this.lastAutoTuneFrame = -1;
    this.autoTuneTarget = 0;
    this.autoTuneSemitones = 0;
    this.autoTuneWet = 0;
    this.autoTuneVoiced = false;
    this.port.onmessage = event => this.onMessage(event.data || {});
  }

  onMessage(message) {
    if (message.type === 'configure') {
      this.effect = message.effect || 'normal';
      this.reset();
    } else if (message.type === 'begin') {
      this.reset();
      if (this.effect === 'walkieTalkie') this.startClick();
      if (this.effect === 'goblin' || this.effect === 'drunk') {
        const duration = Number(message.duration) || 0;
        const leadRatio = this.effect === 'goblin' ? 1 - 1 / 1.04 : 0.02;
        this.speedLeadFrames = Math.max(1, Math.floor(sampleRate * duration * leadRatio));
        const headroom = this.effect === 'drunk' ? duration * 0.03 : 0.12;
        this.ensureFifoSize(this.speedLeadFrames + Math.floor(sampleRate * headroom));
        this.speedReadRate = this.effect === 'goblin' ? 1.04 : 1;
        this.speedTarget = this.speedReadRate;
      }
    } else if (message.type === 'endingClick' && this.effect === 'walkieTalkie') {
      this.startClick();
    } else if (message.type === 'finish' && this.effect === 'reverseDemon') {
      this.reverseEnded = true;
      if (this.reverseStage === 'capture') {
        this.reverseLeadSize = this.reverseLeadCount;
        if (this.reverseLeadCount) this.reverseStage = 'reverse';
        else { this.reverseStage = 'normal'; this.reverseDrained = true; this.port.postMessage({ type: 'drained' }); }
      }
    } else if (message.type === 'finish' && (this.effect === 'goblin' || this.effect === 'drunk')) {
      this.speedEnded = true; this.speedReadRate = 1;
      if (!this.speedStarted && this.fifoCount > 0) {
        this.speedLeadFrames = this.fifoCount; this.speedStarted = true;
      }
      if (this.fifoCount === 0 && !this.speedDrained) {
        this.speedDrained = true; this.port.postMessage({ type: 'drained' });
      }
    }
  }

  reset() {
    this.frame = 0;
    this.ringIndex = 0;
    this.cloneIndex = 0;
    this.crushCounter = 0;
    this.dropoutFrames = 0;
    this.clickFrames = 0;
    this.clickLength = 0;
    this.nextDropout = Math.round(sampleRate * (1.5 + this.random() * 1.8));
    this.ringPhase = 0;
    this.drunkSemitones = 0;
    this.drunkTarget = 0;
    this.nextDrunkChange = 0;
    this.reverseLeadCount = 0;
    this.reverseLeadSize = Math.max(1, Math.floor(sampleRate * 0.06));
    this.reverseIndex = 0;
    this.reverseStage = 'capture';
    this.reverseEnded = false;
    this.reverseDrained = false;
    this.reverseHasSpeech = false;
    this.fifoRead = 0;
    this.fifoWrite = 0;
    this.fifoCount = 0;
    this.cursedEchoPosition = -1;
    this.cursedSilenceFrames = 0;
    this.cursedSpeechFrames = 0;
    this.cursedWasSpeaking = false;
    this.cursedEcho.forEach(channel => channel.fill(0));
    this.speedLeadFrames = 0;
    this.speedStarted = false;
    this.speedEnded = false;
    this.speedDrained = false;
    this.speedFraction = 0;
    this.speedReadRate = 1;
    this.speedTarget = 1;
    this.nextSpeedChange = 0;
    this.lastAutoTuneFrame = -1;
    this.autoTuneTarget = 0;
    this.autoTuneSemitones = 0;
    this.autoTuneWet = 0;
    this.autoTuneVoiced = false;
    this.pitchWindow.fill(0);
    this.history.forEach(channel => channel.fill(0));
    this.cloneHistory.forEach(channel => channel.fill(0));
    this.reverseLead.forEach(channel => channel.fill(0));
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

  ensureFifoSize(frames) {
    const size = Math.min(sampleRate * 5, Math.max(this.fifoSize, frames + 1));
    if (size === this.fifoSize) return;
    this.fifoSize = size;
    this.fifo = [new Float32Array(size), new Float32Array(size)];
    this.fifoRead = 0; this.fifoWrite = 0; this.fifoCount = 0;
  }

  readHistory(channel, delay) {
    const data = this.history[channel];
    let position = this.ringIndex - delay;
    while (position < 0) position += this.historySize;
    const left = Math.floor(position) % this.historySize;
    const right = (left + 1) % this.historySize;
    const fraction = position - Math.floor(position);
    return data[left] * (1 - fraction) + data[right] * fraction;
  }

  pitchSample(channel, ratio, phase, extraDelay = 0) {
    const span = Math.max(1, Math.abs(ratio - 1) * Math.floor(sampleRate * 0.035));
    const minimum = Math.min(sampleRate * 0.025, Math.max(4, sampleRate * 0.004));
    const delayAt = turn => ratio >= 1
      ? minimum + span * (1 - turn)
      : minimum + span * turn;
    const phaseB = (phase + 0.5) % 1;
    const weightA = 0.5 - 0.5 * Math.cos(TAU * phase);
    const weightB = 0.5 - 0.5 * Math.cos(TAU * phaseB);
    return this.readHistory(channel, delayAt(phase) + extraDelay) * weightA + this.readHistory(channel, delayAt(phaseB) + extraDelay) * weightB;
  }

  semitoneRatio(semitones) { return Math.pow(2, semitones / 12); }

  crush(value, bits) {
    const steps = Math.pow(2, bits - 1);
    return Math.round(value * steps) / steps;
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    if (!output.length) return true;
    const frames = output[0].length;
    const inputChannels = input.length;
    const reverse = this.effect === 'reverseDemon';

    for (let frame = 0; frame < frames; frame++) {
      const leftInput = inputChannels ? input[0][frame] || 0 : 0;
      const rightInput = inputChannels > 1 ? input[1][frame] || 0 : leftInput;
      let left = 0;
      let right = 0;

      if (reverse) {
        if (!this.reverseEnded) {
          if (!this.reverseHasSpeech && Math.max(Math.abs(leftInput), Math.abs(rightInput)) > 0.018) this.reverseHasSpeech = true;
          if (this.reverseHasSpeech) {
            this.pushFifo(0, leftInput);
            this.pushFifo(1, rightInput);
          } else {
            left = leftInput; right = rightInput;
          }
        }
        if (this.reverseStage === 'capture' && this.reverseHasSpeech) {
          this.reverseLead[0][this.reverseLeadCount] = leftInput;
          this.reverseLead[1][this.reverseLeadCount] = rightInput;
          this.reverseLeadCount++;
          if (this.reverseLeadCount >= this.reverseLeadSize) this.reverseStage = 'reverse';
        } else if (this.reverseStage === 'reverse') {
          const index = this.reverseLeadSize - 1 - this.reverseIndex;
          left = this.reverseLead[0][index] * 0.22;
          right = this.reverseLead[1][index] * 0.22;
          this.reverseIndex++;
          if (this.reverseIndex >= this.reverseLeadSize) {
            this.reverseStage = 'normal';
            this.reverseIndex = 0;
          }
        } else if (this.fifoCount > 0) {
          left = this.popFifo(0);
          right = this.popFifo(1);
        }
        if (this.reverseEnded && this.reverseStage === 'normal' && this.fifoCount === 0 && !this.reverseDrained) {
          this.reverseDrained = true;
          this.port.postMessage({ type: 'drained' });
        }
      } else {
        let effectLeft = leftInput; let effectRight = rightInput;
        if (this.effect === 'goblin' || this.effect === 'drunk') {
          if (!this.speedEnded) {
            this.pushFifo(0, leftInput);
            this.pushFifo(1, rightInput);
          }
          if (!this.speedStarted && this.fifoCount >= this.speedLeadFrames) this.speedStarted = true;
          if (this.speedStarted && this.fifoCount > 0) {
            const current = this.fifoRead; const next = (current + 1) % this.fifoSize;
            effectLeft = this.fifo[0][current] * (1 - this.speedFraction) + this.fifo[0][next] * this.speedFraction;
            effectRight = this.fifo[1][current] * (1 - this.speedFraction) + this.fifo[1][next] * this.speedFraction;
            this.speedFraction += this.speedEnded ? 1 : this.speedReadRate;
            const consumed = Math.min(this.fifoCount, Math.floor(this.speedFraction));
            this.speedFraction -= consumed;
            this.fifoRead = (this.fifoRead + consumed) % this.fifoSize;
            this.fifoCount -= consumed;
            if (this.fifoCount === 0) this.speedFraction = 0;
          } else {
            effectLeft = 0; effectRight = 0;
          }
          if (this.effect === 'drunk' && !this.speedEnded) {
            if (this.frame >= this.nextSpeedChange) {
              this.speedTarget = 0.985 + this.random() * 0.03;
              this.nextSpeedChange = this.frame + Math.floor(sampleRate * (0.22 + this.random() * 0.48));
            }
            this.speedReadRate += (this.speedTarget - this.speedReadRate) * 0.0002;
          }
          if (this.speedEnded && this.fifoCount === 0 && !this.speedDrained) {
            this.speedDrained = true; this.port.postMessage({ type: 'drained' });
          }
        }
        this.history[0][this.ringIndex] = effectLeft;
        this.history[1][this.ringIndex] = effectRight;
        this.cloneHistory[0][this.cloneIndex] = leftInput;
        this.cloneHistory[1][this.cloneIndex] = rightInput;

        const phase = (this.frame % Math.floor(sampleRate * 0.035)) / Math.floor(sampleRate * 0.035);
        const direct = effectLeft;
        if (this.effect === 'autoTune') {
          if (this.frame - this.lastAutoTuneFrame >= this.autoTuneFrameStep) {
            this.lastAutoTuneFrame = this.frame;
            if (this.frame >= this.pitchWindowSize) {
              for (let index = 0; index < this.pitchWindowSize; index++) {
                const source = (this.ringIndex - this.pitchWindowSize + index + this.historySize) % this.historySize;
                this.pitchWindow[index] = this.history[0][source];
              }
              const pitch = detectVoicedPitch(this.pitchWindow, sampleRate);
              this.autoTuneVoiced = !!pitch;
              this.autoTuneTarget = pitch ? chromaticSnapSemitones(pitch.frequency) : 0;
            } else {
              this.autoTuneVoiced = false; this.autoTuneTarget = 0;
            }
          }
          const correctionSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.025));
          const gateSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.018));
          this.autoTuneSemitones += (this.autoTuneTarget - this.autoTuneSemitones) * correctionSmoothing;
          this.autoTuneWet += ((this.autoTuneVoiced ? 1 : 0) - this.autoTuneWet) * gateSmoothing;
          const tunedRatio = this.semitoneRatio(this.autoTuneSemitones);
          const tunedLeft = this.pitchSample(0, tunedRatio, phase);
          const tunedRight = this.pitchSample(1, tunedRatio, phase);
          left = direct * (1 - this.autoTuneWet) + tunedLeft * this.autoTuneWet;
          right = rightInput * (1 - this.autoTuneWet) + tunedRight * this.autoTuneWet;
        } else if (['goblin', 'chipmunk', 'giant', 'drunk', 'helium', 'cursed', 'bossFight', 'alien'].includes(this.effect)) {
          let semitones = 0;
          if (this.effect === 'goblin') semitones = 6.82;
          if (this.effect === 'chipmunk') semitones = 11;
          if (this.effect === 'giant') semitones = -10;
          if (this.effect === 'drunk') {
            if (this.frame >= this.nextDrunkChange) {
              this.drunkTarget = (this.random() * 2 - 1) * 1.6;
              this.nextDrunkChange = this.frame + Math.floor(sampleRate * (0.2 + this.random() * 0.5));
            }
            this.drunkSemitones += (this.drunkTarget - this.drunkSemitones) * 0.0012;
            semitones = this.drunkSemitones;
          }
          if (this.effect === 'helium') semitones = 9.5;
          if (this.effect === 'cursed') semitones = -6;
          if (this.effect === 'bossFight') semitones = -9;
          if (this.effect === 'alien') semitones = 1.5;
          const ratio = this.semitoneRatio(semitones);
          left = this.pitchSample(0, ratio, phase);
          right = this.pitchSample(1, ratio, phase);
          if (this.effect === 'bossFight') {
            const octave = this.semitoneRatio(semitones - 12);
            left = left * 0.78 + this.pitchSample(0, octave, phase) * 0.22;
            right = right * 0.78 + this.pitchSample(1, octave, phase) * 0.22;
          }
        } else if (this.effect === 'cloneArmy') {
          const leftDelay = sampleRate * 0.008;
          const rightDelay = sampleRate * 0.019;
          const minusSevenCents = this.semitoneRatio(-0.07);
          const plusSevenCents = this.semitoneRatio(0.07);
          left = direct * 0.68 + this.pitchSample(0, minusSevenCents, phase, leftDelay) * 0.18 + this.pitchSample(0, plusSevenCents, phase, rightDelay) * 0.14;
          right = rightInput * 0.68 + this.pitchSample(1, minusSevenCents, phase, rightDelay) * 0.18 + this.pitchSample(1, plusSevenCents, phase, leftDelay) * 0.14;
        } else if (this.effect === 'brokenRobot') {
          const frequency = 54;
          const ring = Math.sin(this.ringPhase);
          left = direct * ring; right = rightInput * ring;
          this.ringPhase = (this.ringPhase + TAU * frequency / sampleRate) % TAU;
          if (this.effect === 'brokenRobot') {
            left = this.crush(left, 5); right = this.crush(right, 5);
            if (this.dropoutFrames > 0) { left = 0; right = 0; this.dropoutFrames--; }
            else if (this.frame >= this.nextDropout) {
              this.dropoutFrames = Math.floor(sampleRate * (0.025 + this.random() * 0.055));
              this.nextDropout = this.frame + Math.floor(sampleRate * (0.45 + this.random() * 1.35));
            }
          }
        } else if (this.effect === 'badInternet' || this.effect === 'nokia') {
          const targetRate = this.effect === 'nokia' ? 8000 : 11000;
          const period = Math.max(1, Math.floor(sampleRate / targetRate));
          if (this.crushCounter === 0) {
            this.crushHeld[0] = this.crush(leftInput, this.effect === 'nokia' ? 7 : 8);
            this.crushHeld[1] = this.crush(rightInput, this.effect === 'nokia' ? 7 : 8);
          }
          left = this.crushHeld[0]; right = this.crushHeld[1];
          this.crushCounter = (this.crushCounter + 1) % period;
          if (this.effect === 'badInternet') {
            if (this.dropoutFrames > 0) { left = 0; right = 0; this.dropoutFrames--; }
            else if (this.frame >= this.nextDropout) {
              this.dropoutFrames = Math.floor(sampleRate * (0.03 + this.random() * 0.07));
              this.nextDropout = this.frame + Math.floor(sampleRate * (1.1 + this.random() * 1.6));
            }
          }
        } else if (this.effect === 'vhs') {
          const wow = Math.sin(this.frame * TAU / (sampleRate * 1.35)) * 0.20;
          const flutter = Math.sin(this.frame * TAU / (sampleRate * 0.16)) * 0.035;
          const ratio = this.semitoneRatio(wow + flutter);
          const hiss = (this.random() * 2 - 1) * 0.008;
          left = this.pitchSample(0, ratio, phase) + hiss;
          right = this.pitchSample(1, ratio, phase) + hiss;
        } else if (this.effect === 'radio') {
          const noise = (this.random() * 2 - 1) * 0.012;
          left = direct + noise; right = rightInput + noise;
        } else if (this.effect === 'walkieTalkie') {
          left = direct; right = rightInput;
          if (this.clickFrames > 0) {
            const elapsed = this.clickLength - this.clickFrames;
            const envelope = this.clickFrames / Math.max(1, this.clickLength);
            const click = Math.sin(TAU * (680 + elapsed * 0.23) * elapsed / sampleRate) * envelope * 0.32;
            left += click; right += click;
            this.clickFrames--;
          }
        } else {
          left = direct; right = rightInput;
        }

        if (this.effect === 'alien' || this.effect === 'cursed') {
          if (this.effect === 'cursed') {
            if (Math.max(Math.abs(leftInput), Math.abs(rightInput)) > 0.018) {
              this.cursedWasSpeaking = true; this.cursedSpeechFrames++; this.cursedSilenceFrames = 0;
            } else if (this.cursedWasSpeaking) {
              this.cursedSilenceFrames++;
              if (this.cursedSilenceFrames > sampleRate * 0.12 && this.cursedSpeechFrames > sampleRate * 0.08) {
                for (let index = 0; index < this.cursedEchoSize; index++) {
                  const sourceIndex = (this.ringIndex - this.cursedSilenceFrames - index + this.historySize) % this.historySize;
                  this.cursedEcho[0][index] = this.history[0][sourceIndex];
                  this.cursedEcho[1][index] = this.history[1][sourceIndex];
                }
                this.cursedEchoPosition = 0; this.cursedSpeechFrames = 0; this.cursedSilenceFrames = 0; this.cursedWasSpeaking = false;
              }
            }
            if (this.cursedEchoPosition >= 0) {
              left += this.cursedEcho[0][this.cursedEchoPosition] * 0.12;
              right += this.cursedEcho[1][this.cursedEchoPosition] * 0.12;
              this.cursedEchoPosition++;
              if (this.cursedEchoPosition >= this.cursedEchoSize) this.cursedEchoPosition = -1;
            }
          }
          const depth = this.effect === 'cursed' ? 0.10 : 1;
          const frequency = this.effect === 'alien' ? 92 : 83;
          const ring = Math.sin(this.ringPhase);
          left = this.effect === 'cursed' ? left * (1 - depth) + left * ring * depth : left * ring;
          right = this.effect === 'cursed' ? right * (1 - depth) + right * ring * depth : right * ring;
          this.ringPhase = (this.ringPhase + TAU * frequency / sampleRate) % TAU;
        }

        if (this.effect === 'radio') {
          // Quiet line noise sits under the band-limited signal.
          const hiss = (this.random() * 2 - 1) * 0.003;
          left += hiss; right += hiss;
        } else if (this.effect === 'vhs') {
          left += (this.random() * 2 - 1) * 0.006;
          right += (this.random() * 2 - 1) * 0.006;
        }

        this.ringIndex = (this.ringIndex + 1) % this.historySize;
        this.cloneIndex = (this.cloneIndex + 1) % this.historySize;
        this.frame++;
      }

      output[0][frame] = Math.max(-1, Math.min(1, left));
      if (output.length > 1) output[1][frame] = Math.max(-1, Math.min(1, right));
    }
    return true;
  }

  pushFifo(channel, sample) {
    if (channel === 0) {
      if (this.fifoCount >= this.fifoSize - 1) return;
      this.fifo[0][this.fifoWrite] = sample;
      this.fifo[1][this.fifoWrite] = 0;
      this.fifoWrite = (this.fifoWrite + 1) % this.fifoSize;
      this.fifoCount++;
    } else {
      const index = (this.fifoWrite - 1 + this.fifoSize) % this.fifoSize;
      this.fifo[1][index] = sample;
    }
  }

  popFifo(channel) {
    const value = this.fifo[channel][this.fifoRead];
    if (channel === 1) {
      this.fifoRead = (this.fifoRead + 1) % this.fifoSize;
      this.fifoCount--;
    }
    return value;
  }
}

registerProcessor('voice-effect-processor', VoiceEffectProcessor);
