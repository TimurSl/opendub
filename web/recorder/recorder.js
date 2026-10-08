import { createLivePeaks, appendLivePeaks } from './live-waveform.js';
import { referenceOverhang, captureTail, capturePlan, recordedTail } from './cue-timing.js';

const CAPTURE_PRIME_MS = 180; // Start the encoder before the video cue (avoid losing the first phoneme).
const CAPTURE_TAIL_MS = 650; // Keep the mic live after the video cue ends.

export function chooseRecordingMime(Recorder = globalThis.MediaRecorder) {
  return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']
    .find(type => Recorder?.isTypeSupported(type)) || '';
}

const activeCapture = mode => ['requesting', 'countdown', 'preroll', 'recording', 'settling'].includes(mode);
const staleSave = error => /Line changed|Room changed|Match changed|another player|not recording|requires a host retake|Take changed|Retake changed|Replacement changed|Accepted take changed/i.test(error?.message || '');
const newRetakeAttemptId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

const VOICE_EFFECTS = [
  ['normal', 'Normal'], ['echo', 'Echo'], ['phone', 'Phone'], ['robot', 'Robot'],
  ['autoTune', 'AUTO-TUNE'], ['goblin', 'Goblin'], ['demon', 'Demon'],
  ['chipmunk', 'Chipmunk'], ['giant', 'Giant'], ['walkieTalkie', 'Walkie-Talkie'],
  ['megaphone', 'Megaphone'], ['cave', 'Cave'], ['badInternet', 'Bad Internet'], ['custom', 'Custom']
];

// These effects need sample-level DSP, not just a Web Audio filter.
const WORKLET_EFFECTS = new Set(['autoTune', 'goblin', 'demon', 'chipmunk', 'giant', 'walkieTalkie', 'badInternet']);
const WORKLET_UNAVAILABLE = 'Pitch and glitch voice effects require AudioWorklet, which is unavailable in this browser.';

const EFFECT_ICON_PATHS = {
  normal: '<path d="M3 12h2l2-5 4 10 4-10 3 5h3"/>',
  echo: '<path d="M3 12h3l2-4 3 8 3-8 2 4h2M5 5c4-3 10-3 14 0M5 19c4 3 10 3 14 0"/>',
  phone: '<path d="M7 3 4 5c0 7 8 15 15 15l2-3-5-4-2 2c-2-1-4-3-5-5l2-2-4-5Z"/>',
  robot: '<rect x="5" y="6" width="14" height="13" rx="2"/><path d="M12 3v3M8 11h1m6 0h1M9 15h6M3 10v5m18-5v5"/>',
  goblin: '<path d="m4 7 5 2 3-3 3 3 5-2-2 11H6L4 7Z"/><path d="m8 13 2 1m6-1-2 1m-2 1v2"/>',
  demon: '<path d="M5 8 3 3l7 3h4l7-3-2 5 1 6-4 6H8l-4-6 1-6Z"/><path d="m8 12 2 1m6-1-2 1m-2 1v2"/>',
  walkieTalkie: '<rect x="7" y="6" width="11" height="16" rx="2"/><path d="M11 6V3l6-1M10 10h5m-5 3h5m-3 5h1"/>',
  chipmunk: '<path d="M4 18 9 13l3 3 7-9"/><path d="M13 7h6v6M4 5h5M4 9h3"/>',
  giant: '<path d="M3 12h2l2-3 3 6 3-9 3 12 3-6h2"/><path d="M4 4h16M4 20h16"/>',
  cave: '<path d="M3 20V9l4-5 5 3 5-4 4 6v11Z"/><path d="M9 20v-5a3 3 0 0 1 6 0v5M3 20h18"/>',
  megaphone: '<path d="m3 10 14-5v14L3 14v-4Z"/><path d="M7 15l2 5h4l-2-4m9-5h2m-2-4 2-2m-2 14 2 2"/>',
  badInternet: '<path d="M3 9a14 14 0 0 1 15-2M6 13a9 9 0 0 1 6-2m3 1 4 4m0-4-4 4M10 18h.01"/>',
  autoTune: '<path d="M4 17V7m0 10h3m-3-5h2m-2-5h3m3 10v-6a2 2 0 0 1 4 0v6m-4-3h4m3 3V7m0 10h4"/>',
  custom: '<path d="M8 4 3 12l5 8m8-16 5 8-5 8M14 3l-4 18"/>'
};

const effectIcon = name => `<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${EFFECT_ICON_PATHS[name]}</svg>`;

export class LineRecorder {
  constructor(client, onError) {
    this.client = client; this.onError = onError; this.stream = null; this.line = null;
    this.packId = null; this.matchId = null; this.mode = 'idle'; this.generation = 0; this.mediaGeneration = 0; this.sceneSeekToken = 0;
    this.blob = null; this.objectUrl = null; this.savedTake = null; this.savedBlob = null;
    this.acceptedTake = null; this.retakeId = ''; this.retakeAttemptId = ''; this.retakeAttemptPending = false;
    this.observedCandidateId = null; this.dismissedTakeId = null; this.backup = null;
    this.saveJob = null; this.saveTail = Promise.resolve(); this.destroyed = false; this.waits = new Set();
    this.mediaWaits = new Set();
    this.waveformCache = new Map(); this.decodedTakes = new Map(); this.referenceSamples = null; this.takeSamples = null;
    this.referenceDuration = 0; this.takeDuration = 0; this.localTiming = null; this.captureTiming = null; this.activeCueOverhang = 0; this.livePeaks = null; this.waveformGeneration = 0; this.referenceGeneration = 0; this.takeGeneration = 0;
    this.video = document.getElementById('line-video');
    this.reference = document.getElementById('reference-audio');
    this.review = document.getElementById('take-review');
    this.status = document.getElementById('recorder-status');
    this.waveform = document.getElementById('recording-waveform');
    this.progress = document.getElementById('recording-progress');
    this.countdown = document.getElementById('countdown');
    this.skipCountdown = document.getElementById('skip-countdown');
    this.waveformStatus = document.getElementById('waveform-status');
    this.gainInputs = [document.getElementById('mic-gain'), document.getElementById('mic-gain-recording')].filter(Boolean);
    this.gainOutputs = [document.getElementById('mic-gain-value'), document.getElementById('mic-gain-value-recording')].filter(Boolean);
    this.meterCanvases = [document.getElementById('live-microphone-meter'), document.getElementById('live-microphone-meter-recording')].filter(Boolean);
    this.meterWraps = [document.getElementById('microphone-meter-wrap'), document.getElementById('microphone-meter-wrap-recording')].filter(Boolean);
    let savedGain = null; let savedSkip = null;
    try {
      savedGain = globalThis.localStorage?.getItem('open-dub-microphone-gain');
      savedSkip = globalThis.localStorage?.getItem('open-dub-skip-countdown');
    } catch { /* Browser storage may be disabled or unavailable in private contexts. */ }
    this.microphoneGainPercent = Number.isFinite(Number(savedGain)) && savedGain !== null ? Math.max(0, Math.min(300, Math.round(Number(savedGain) / 5) * 5)) : 100;
    this.gainInputs.forEach(input => { input.value = String(this.microphoneGainPercent); input.addEventListener('input', () => this.setMicrophoneGain(Number(input.value))); });
    this.gainOutputs.forEach(output => { output.textContent = `${this.microphoneGainPercent}%`; });
    if (this.skipCountdown && savedSkip !== null) this.skipCountdown.checked = savedSkip === 'true';
    this.skipCountdown?.addEventListener('change', () => {
      try { globalThis.localStorage?.setItem('open-dub-skip-countdown', String(this.skipCountdown.checked)); } catch {}
    });
    this.buttons = Object.fromEntries(['original', 'record', 'my-take', 'next'].map(id => [id, document.getElementById(id)]));
    this.soundpadButton = document.getElementById('soundpad-import');
    this.soundpadInput = document.getElementById('soundpad-file');
    this.soundpadButton?.addEventListener('click', () => this.soundpadInput?.click());
    this.soundpadInput?.addEventListener('change', () => {
      const file = this.soundpadInput.files?.[0];
      this.soundpadInput.value = ''; // Allow selecting the same sound again.
      if (file) this.importSound(file).catch(error => this.friendly(`Sound import failed: ${error.message}`));
    });
    this.effects = document.getElementById('effect-row'); this.currentEffect = 'normal';
    this.customEffectOptions = document.getElementById('custom-effect-options');
    this.customArgsInput = document.getElementById('custom-effect-args');
    this.customArgs = this.customArgsInput?.value || '-af vibrato=f=6:d=0.8';
    this.customArgsInput?.addEventListener('input', () => { this.customArgs = this.customArgsInput.value; });
    if (this.effects) {
      this.renderEffects();
      for (const button of this.effects.querySelectorAll('[data-effect]')) {
        button.addEventListener('click', () => this.setEffect(button.getAttribute('data-effect')));
      }
    }
    this.mediaAnalyserNodes = new Map(); this.activeAnalyser = null;
    this.buttons.original.addEventListener('click', () => this.playOriginal().catch(() => this.mediaError()));
    this.buttons['my-take'].addEventListener('click', () => this.playTake().catch(() => this.mediaError()));
    this.buttons.record.addEventListener('click', () => {
      if (['countdown', 'preroll'].includes(this.mode)) this.cancelRecording();
      else if (this.mode === 'recording') this.stopRecording(true);
      else this.record().catch(error => {
        this.cancelRecording();
        this.friendly(['Microphone access required', 'Video unavailable — ask host'].includes(error?.message) ? error.message : 'Recording failed — try again');
      });
    });
    this.buttons.next.addEventListener('click', () => this.next().catch(() => this.friendly('Save failed — try again')));
    this.video.addEventListener('error', () => this.mediaError());
    this.visibilityListener = () => {
      if (document.hidden && activeCapture(this.mode)) {
        this.cancelRecording(); this.friendly('Recording failed — try again');
      }
    };
    document.addEventListener('visibilitychange', this.visibilityListener);
    this.pagehideListener = () => this.destroy();
    window.addEventListener('pagehide', this.pagehideListener);
    this.reconnectListener = event => {
      if (event.detail && this.blob && this.allowed && !this.currentSave()) this.save().catch(() => {});
    };
    this.onlineListener = () => {
      if (this.blob && this.allowed && !this.currentSave()) this.save().catch(() => {});
    };
    client.addEventListener('connection', this.reconnectListener);
    window.addEventListener('online', this.onlineListener);
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.countdown.hidden = true; this.waveform.hidden = false;
    if (this.progress) this.progress.hidden = true;
    this.drawWaveform(true); this.updateControls();
  }
  renderEffects() {
    if (!this.effects || typeof document.createElement !== 'function' || typeof this.effects.append !== 'function') return;
    for (const button of this.effects.querySelectorAll('[data-effect]')) button.remove?.();
    for (const [id, label] of VOICE_EFFECTS) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.effect = id;
      button.setAttribute('aria-label', `Use ${label} voice effect`);
      button.setAttribute('aria-pressed', String(id === this.currentEffect));
      button.innerHTML = `${effectIcon(id)}<span>${label}</span>`;
      this.effects.append(button);
    }
  }
  friendly(message) { this.status.textContent = message; this.onError?.(new Error(message)); }
  mediaError() {
    if (activeCapture(this.mode)) this.cancelRecording();
    else this.stopMedia();
    this.friendly('Video unavailable — ask host');
  }
  hasTake() { return !!(this.blob || this.savedTake); }
  hasUnacceptedTake() { return this.hasTake(); }
  hasPlaybackTake() { return this.hasTake() || !!this.acceptedTake; }
  currentSave() { return this.saveJob?.generation === this.generation ? this.saveJob : null; }
  updateControls() {
    const capturing = activeCapture(this.mode); const accepting = this.mode === 'accepting';
    const set = (button, label, description, pressed = false) => {
      button.textContent = label;
      button.setAttribute('aria-label', description);
      button.setAttribute('aria-pressed', String(pressed));
    };
    const originalActive = this.mode === 'original'; const takeActive = this.mode === 'my-take';
    const recordingActive = ['countdown', 'preroll', 'recording'].includes(this.mode);
    set(this.buttons.original, 'ORIGINAL', originalActive ? 'Stop original playback' : 'Play original line', originalActive);
    set(this.buttons.record, recordingActive ? 'STOP' : 'RECORD', recordingActive ? 'Stop recording' : 'Record your line', recordingActive);
    set(this.buttons['my-take'], 'MY TAKE', takeActive ? 'Stop my take playback' : 'Play my take', takeActive);
    set(this.buttons.next, 'NEXT', 'Next: accept take and continue');
    this.buttons.original.disabled = !this.line || capturing || accepting || this.settings?.referencePlaybackEnabled === false;
    this.buttons['my-take'].disabled = !this.line || !this.hasPlaybackTake() || capturing || accepting;
    this.buttons.next.disabled = !this.line || !this.allowed || !this.hasTake() || capturing || accepting;
    this.buttons.record.disabled = !this.line || !this.allowed || accepting || this.mode === 'requesting' || this.mode === 'settling' || !!this.stopRequested;
    if (this.soundpadButton) this.soundpadButton.disabled = !this.line || !this.allowed || capturing || accepting;
    if (this.soundpadInput) this.soundpadInput.disabled = !this.line || !this.allowed || capturing || accepting;
    if (this.skipCountdown) this.skipCountdown.disabled = capturing || accepting;
    for (const input of this.gainInputs) input.disabled = capturing || accepting;
    for (const output of this.gainOutputs) output.textContent = `${this.microphoneGainPercent}%`;
    const microphoneAvailable = !!this.stream?.getAudioTracks().some(track => track.readyState === 'live');
    this.meterWraps.forEach(element => { element.hidden = !microphoneAvailable; });
    if (this.effects) {
      const enabled = this.settings?.voiceEffectsEnabled !== false;
      for (const button of this.effects.querySelectorAll('[data-effect]')) {
        const unavailable = WORKLET_EFFECTS.has(button.getAttribute('data-effect')) && this.effectWorkletAvailable === false;
        button.disabled = !enabled || capturing || accepting || unavailable;
        button.title = unavailable ? WORKLET_UNAVAILABLE : '';
        button.setAttribute('aria-pressed', String(button.getAttribute('data-effect') === this.currentEffect));
      }
    }
    if (this.customEffectOptions) this.customEffectOptions.hidden = this.currentEffect !== 'custom' || this.settings?.voiceEffectsEnabled === false;
    if (this.customArgsInput) this.customArgsInput.disabled = capturing || accepting || this.settings?.voiceEffectsEnabled === false;
    this.drawWaveform();
    if (microphoneAvailable) this.scheduleMicrophoneMeter(); else this.stopMicrophoneMeter();
    this.onModeChange?.(this.mode);
  }
  setMicrophoneGain(percent) {
    const value = Math.max(0, Math.min(300, Math.round((Number(percent) || 0) / 5) * 5));
    this.microphoneGainPercent = value;
    this.gainInputs.forEach(input => { if (Number(input.value) !== value) input.value = String(value); });
    this.gainOutputs.forEach(output => { output.textContent = `${value}%`; });
    try { globalThis.localStorage?.setItem('open-dub-microphone-gain', String(value)); } catch { /* Keep this value for the current page. */ }
    if (this.microphoneGainNode && this.audioContext) {
      const gain = value / 100;
      if (this.microphoneGainNode.gain.setTargetAtTime) this.microphoneGainNode.gain.setTargetAtTime(gain, this.audioContext.currentTime, 0.015);
      else this.microphoneGainNode.gain.value = gain;
    }
    this.drawMicrophoneMeter();
  }
  scheduleMicrophoneMeter() {
    if (this.microphoneMeterFrame || !this.meterAnalyser) return;
    const draw = () => {
      this.microphoneMeterFrame = 0;
      if (!this.stream?.getAudioTracks().some(track => track.readyState === 'live')) return;
      this.drawMicrophoneMeter();
      this.microphoneMeterFrame = requestAnimationFrame(draw);
    };
    this.microphoneMeterFrame = requestAnimationFrame(draw);
  }
  stopMicrophoneMeter() {
    if (this.microphoneMeterFrame) cancelAnimationFrame(this.microphoneMeterFrame);
    this.microphoneMeterFrame = 0;
  }
  drawMicrophoneMeter() {
    if (!this.meterAnalyser) return;
    const size = this.meterAnalyser.fftSize || 256; const samples = new Uint8Array(size);
    this.meterAnalyser.getByteTimeDomainData?.(samples);
    let sum = 0;
    for (const sample of samples) { const value = (sample - 128) / 128; sum += value * value; }
    const level = samples.length ? Math.min(1, Math.sqrt(sum / samples.length) * 3.8) : 0;
    for (const canvas of this.meterCanvases) {
      const bounds = canvas.getBoundingClientRect(); const width = bounds.width || canvas.width || 320; const height = bounds.height || 14;
      const ratio = Math.min(2, window.devicePixelRatio || 1); const pixelWidth = Math.round(width * ratio); const pixelHeight = Math.round(height * ratio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
      const context = canvas.getContext('2d'); if (!context) continue;
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
      context.fillStyle = '#67e5ff'; context.fillRect(0, 0, width * level, height);
    }
  }
  ensureAudioContext() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    try { this.audioContext ??= new AudioContext(); return this.audioContext; } catch { return null; }
  }
  ensureMediaAnalyser(element) {
    const context = this.ensureAudioContext();
    if (!context || !element) return null;
    if (this.mediaAnalyserNodes.has(element)) return this.mediaAnalyserNodes.get(element).analyser;
    try {
      const source = context.createMediaElementSource(element); const analyser = context.createAnalyser();
      analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser); analyser.connect(context.destination);
      this.mediaAnalyserNodes.set(element, { source, analyser });
      return analyser;
    } catch { return null; }
  }
  setEffect(effect) {
    if (!VOICE_EFFECTS.some(([id]) => id === effect) || activeCapture(this.mode)) return;
    if (WORKLET_EFFECTS.has(effect) && this.effectWorkletAvailable === false) {
      this.setEffectCapability(WORKLET_UNAVAILABLE);
      return;
    }
    this.currentEffect = this.settings?.voiceEffectsEnabled === false ? 'normal' : effect;
    if (this.customEffectOptions) this.customEffectOptions.hidden = this.currentEffect !== 'custom';
    if (this.micSource && this.audioContext) this.buildMicGraph();
    this.updateControls();
  }
  async ensureEffectWorklet(context) {
    if (!context?.audioWorklet || typeof AudioWorkletNode !== 'function') {
      this.effectWorkletAvailable = false;
      this.setEffectCapability(WORKLET_UNAVAILABLE);
      if (WORKLET_EFFECTS.has(this.currentEffect)) this.currentEffect = 'normal';
      this.updateControls();
      return false;
    }
    this.effectWorkletPromise ??= context.audioWorklet.addModule(new URL('./effect-processor.js', import.meta.url))
      .then(() => true).catch(() => false);
    this.effectWorkletAvailable = await this.effectWorkletPromise;
    this.setEffectCapability(this.effectWorkletAvailable ? '' : WORKLET_UNAVAILABLE);
    if (!this.effectWorkletAvailable && this.currentEffect === 'autoTune') this.currentEffect = 'normal';
    this.updateControls();
    return this.effectWorkletAvailable;
  }
  setEffectCapability(message) {
    const element = document.getElementById('effect-capability');
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
  }
  buildMicGraph() {
    if (!this.audioContext || !this.micSource) return;
    const context = this.audioContext;
    this.micSource.disconnect();
    try { this.captureAnalyser?.disconnect(); } catch {}
    for (const node of this.effectNodes || []) { try { node.disconnect(); } catch {} }
    for (const oscillator of this.effectOscillators || []) { try { oscillator.stop(); } catch {} }
    this.robotOscillator = null;
    this.effectOscillators = [];
    this.effectNodes = [];
    const keep = node => { this.effectNodes.push(node); return node; };
    const analyser = context.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.76;
    const meterAnalyser = keep(context.createAnalyser()); meterAnalyser.fftSize = 512; meterAnalyser.smoothingTimeConstant = 0.45;
    const destination = this.captureDestination ??= context.createMediaStreamDestination();
    const microphoneGain = keep(context.createGain());
    microphoneGain.gain.value = this.microphoneGainPercent / 100;
    this.microphoneGainNode = microphoneGain;
    this.micSource.connect(microphoneGain);
    microphoneGain.connect(meterAnalyser);
    this.meterAnalyser = meterAnalyser;
    const inputGain = keep(context.createGain());
    inputGain.gain.value = this.stopRequested ? 0 : 1;
    this.effectInputGain = inputGain; this.captureGate = inputGain;
    microphoneGain.connect(inputGain);
    let output = inputGain;
    const addFilter = (type, frequency, options = {}) => {
      const filter = keep(context.createBiquadFilter()); filter.type = type; filter.frequency.value = frequency;
      if (options.q != null) filter.Q.value = options.q;
      if (options.gain != null) filter.gain.value = options.gain;
      output.connect(filter); output = filter; return filter;
    };
    const addBandpass = (high, low) => { addFilter('highpass', high); addFilter('lowpass', low); };
    const addCompressor = (threshold = -24, ratio = 5) => {
      const compressor = keep(context.createDynamicsCompressor()); compressor.threshold.value = threshold;
      compressor.knee.value = 5; compressor.ratio.value = ratio; compressor.attack.value = 0.004; compressor.release.value = 0.12;
      output.connect(compressor); output = compressor;
    };
    const addDistortion = (drive = 1.5) => {
      const distortion = keep(context.createWaveShaper()); const curve = new Float32Array(2048);
      for (let i = 0; i < curve.length; i++) {
        const x = (i * 2) / (curve.length - 1) - 1;
        curve[i] = Math.tanh(x * drive);
      }
      distortion.curve = curve; distortion.oversample = '2x'; output.connect(distortion); output = distortion;
    };
    const addDelay = (seconds, feedbackAmount, wetAmount = 0.35, dryAmount = 0.82) => {
      const source = output;
      const dry = keep(context.createGain()); dry.gain.value = dryAmount;
      const delay = keep(context.createDelay(1)); delay.delayTime.value = seconds;
      const feedback = keep(context.createGain()); feedback.gain.value = feedbackAmount;
      const wet = keep(context.createGain()); wet.gain.value = wetAmount;
      const mix = keep(context.createGain());
      source.connect(dry); source.connect(delay); delay.connect(feedback); feedback.connect(delay); delay.connect(wet);
      dry.connect(mix); wet.connect(mix); output = mix;
    };
    const addReverb = (seconds = 0.38, wetAmount = 0.2) => {
      const source = output; const dry = keep(context.createGain()); dry.gain.value = 0.86;
      const convolver = keep(context.createConvolver()); const impulseLength = Math.floor(context.sampleRate * seconds);
      const impulse = context.createBuffer(2, impulseLength, context.sampleRate);
      for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
        const samples = impulse.getChannelData(channel);
        for (let i = 0; i < impulseLength; i++) samples[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / impulseLength, 2.4);
      }
      convolver.buffer = impulse;
      const wet = keep(context.createGain()); wet.gain.value = wetAmount;
      const mix = keep(context.createGain()); source.connect(dry); source.connect(convolver); convolver.connect(wet);
      dry.connect(mix); wet.connect(mix); output = mix;
    };
    const addChorus = () => {
      const source = output; const dry = keep(context.createGain()); dry.gain.value = 0.77;
      const delay = keep(context.createDelay(0.05)); delay.delayTime.value = 0.023;
      const lfo = keep(context.createOscillator()); lfo.type = 'sine'; lfo.frequency.value = 0.32;
      const depth = keep(context.createGain()); depth.gain.value = 0.004;
      const wet = keep(context.createGain()); wet.gain.value = 0.36;
      const mix = keep(context.createGain()); source.connect(dry); source.connect(delay); lfo.connect(depth); depth.connect(delay.delayTime);
      delay.connect(wet); dry.connect(mix); wet.connect(mix); lfo.start(); this.effectOscillators.push(lfo); output = mix;
    };

    switch (this.currentEffect) {
      case 'echo': addDelay(0.22, 0.24, 0.48, 0.78); break;
      case 'phone': addBandpass(620, 2400); addCompressor(-29, 5); break;
      case 'robot': {
        addFilter('highpass', 120, { q: 0.7 });
        addFilter('peaking', 2400, { q: 1.1, gain: 4 });
        const lowpass = addFilter('lowpass', 6500, { q: 0.7 });
        const dry = keep(context.createGain()); dry.gain.value = 0.18; lowpass.connect(dry);
        const ring = keep(context.createGain()); ring.gain.value = 0;
        const oscillator = keep(context.createOscillator()); oscillator.type = 'sine'; oscillator.frequency.value = 52;
        const depth = keep(context.createGain()); depth.gain.value = 0.85;
        oscillator.connect(depth); depth.connect(ring.gain); lowpass.connect(ring); oscillator.start();
        this.effectOscillators.push(oscillator); this.robotOscillator = oscillator;
        const distortion = keep(context.createWaveShaper()); const curve = new Float32Array(1024);
        for (let i = 0; i < curve.length; i++) {
          const x = (i * 2) / (curve.length - 1) - 1;
          curve[i] = Math.tanh(x * 1.8);
        }
        distortion.curve = curve; distortion.oversample = '2x'; ring.connect(distortion);
        const wet = keep(context.createGain()); wet.gain.value = 0.82; distortion.connect(wet);
        const mix = keep(context.createGain()); dry.connect(mix); wet.connect(mix);
        const compressor = keep(context.createDynamicsCompressor());
        compressor.threshold.value = -24; compressor.knee.value = 5; compressor.ratio.value = 8;
        compressor.attack.value = 0.003; compressor.release.value = 0.08;
        mix.connect(compressor); output = compressor;
        break;
      }
      case 'goblin': addFilter('highpass', 180); addFilter('highshelf', 2200, { gain: 2 }); break;
      case 'demon': addFilter('lowshelf', 150, { gain: 5 }); addFilter('lowpass', 4500); addDistortion(2.1); break;
      case 'walkieTalkie': addBandpass(500, 2800); addDistortion(2.2); addCompressor(-26, 6); break;
      case 'chipmunk': addFilter('highpass', 100); break;
      case 'giant': addFilter('lowshelf', 130, { gain: 2 }); addChorus(); break;
      case 'cave': addReverb(0.65, 0.45); addDelay(0.19, 0.28, 0.38, 0.85); break;
      case 'megaphone': addBandpass(300, 3500); addCompressor(-30, 12); addDistortion(3.2); break;
      case 'badInternet': addFilter('lowpass', 3800); break;
    }

    if (this.effectWorkletAvailable && WORKLET_EFFECTS.has(this.currentEffect)) {
      try {
        const processor = keep(new AudioWorkletNode(context, 'voice-effect-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit'
        }));
        processor.port.postMessage({ type: 'configure', effect: this.currentEffect });
                processor.onprocessorerror = () => {
          if (this.effectProcessor !== processor) return;
          this.effectWorkletPromise = Promise.resolve(false);
          this.effectWorkletAvailable = false;
          this.setEffectCapability(WORKLET_UNAVAILABLE);
          if (activeCapture(this.mode)) this.cancelRecording('Voice effect processing failed — record again');
          this.currentEffect = 'normal';
          if (this.micSource && !activeCapture(this.mode)) this.buildMicGraph();
          this.updateControls();
        };
        output.connect(processor); output = processor; this.effectProcessor = processor;
      } catch {
        this.effectProcessor = null;
        this.effectWorkletAvailable = false;
        this.currentEffect = 'normal';
        this.setEffectCapability(WORKLET_UNAVAILABLE);
        this.updateControls();
      }
    } else this.effectProcessor = null;

    output.connect(analyser); analyser.connect(destination);
    this.captureAnalyser = analyser; this.analyser = analyser; this.activeAnalyser = analyser;
    this.waveFrequencyData = new Uint8Array(analyser.frequencyBinCount);
  }
  async enableMicrophone() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) throw new Error('Microphone access required');
    if (this.stream?.getAudioTracks().some(track => track.readyState === 'live')) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      if (this.destroyed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
        if (this.destroyed || this.stream !== stream) return;
        if (activeCapture(this.mode)) this.cancelRecording();
        this.friendly('Microphone access required'); this.updateControls();
        this.client.dispatchEvent(new Event('microphone'));
      }));
      this.micSource?.disconnect();
      const context = this.ensureAudioContext();
      if (context) {
        try {
          this.micSource = context.createMediaStreamSource(stream);
          context.resume().catch(() => {});
          await this.ensureEffectWorklet(context);
          this.buildMicGraph();
        } catch {
          this.analyser = null; this.captureDestination = null;
          this.effectWorkletAvailable = false;
          this.setEffectCapability(WORKLET_UNAVAILABLE);
          if (WORKLET_EFFECTS.has(this.currentEffect)) this.currentEffect = 'normal';
        }
      } else {
        this.effectWorkletAvailable = false;
        this.setEffectCapability(WORKLET_UNAVAILABLE);
        if (WORKLET_EFFECTS.has(this.currentEffect)) this.currentEffect = 'normal';
      }
    } catch { throw new Error('Microphone access required'); }
    this.updateControls();
    // The recording screen may be open before READY; refresh its permission
    // hint immediately after the microphone is granted, not on the next poll.
    this.client.dispatchEvent(new Event('microphone'));
  }
  cancelPendingWaits() {
    for (const wait of this.waits) { clearTimeout(wait.timer); wait.resolve(); }
    this.waits.clear();
    clearTimeout(this.settleTimer); this.settleTimer = null;
  }
  waitCancelable(milliseconds, generation) {
    if (generation !== this.generation) return Promise.resolve();
    return new Promise(resolve => {
      const wait = { resolve: () => { this.waits.delete(wait); resolve(); }, timer: null };
      wait.timer = setTimeout(wait.resolve, milliseconds);
      this.waits.add(wait);
    });
  }
  cueOverhang() {
    return referenceOverhang(this.line?.duration || 0, this.referenceDuration, this.effectTailMilliseconds() / 1000);
  }
  waveformCacheKey(line = this.line) { return `${this.matchId || ''}:${line?.id || ''}`; }
  copyAudioSamples(buffer, startTime = 0, endTime = buffer.duration) {
    const channel = buffer.getChannelData(0); const start = Math.max(0, Math.floor(startTime * buffer.sampleRate));
    const end = Math.min(channel.length, Math.max(start, Math.floor(endTime * buffer.sampleRate)));
    const samples = new Float32Array(end - start); samples.set(channel.subarray(start, end));
    return { samples, duration: samples.length / buffer.sampleRate, sampleRate: buffer.sampleRate };
  }
  async decodeAudio(bytes) {
    const context = this.ensureAudioContext();
    if (!context?.decodeAudioData) throw new Error('Waveform decoding is unavailable');
    const buffer = await context.decodeAudioData(bytes.slice(0));
    return this.copyAudioSamples(buffer);
  }
  async loadReferenceWaveform() {
    const line = this.line; const pack = this.client.state?.session?.pack;
    if (!line || !pack) return;
    const generation = ++this.referenceGeneration; const matchId = this.matchId; const lineId = line.id;
    const viewGeneration = this.waveformGeneration; const key = this.waveformCacheKey(line);
    const cached = this.waveformCache.get(key);
    if (cached?.referenceResolved) {
      this.referenceSamples = cached.reference?.samples || null;
      this.referenceDuration = cached.reference?.duration || 0;
      this.referenceSampleRate = cached.reference?.sampleRate || 0;
      if (this.waveformStatus) this.waveformStatus.textContent = cached.reference ? 'Original waveform ready' : 'Original waveform unavailable';
      this.drawWaveform(); return;
    }
    if (this.waveformStatus) this.waveformStatus.textContent = 'Loading original waveform…';
    const controller = this.waveformAbort ??= new AbortController();
    let reference = null;
    try {
      let url = line.referenceAudio;
      let fallback = false;
      if (!url) { url = pack.videoUrl; fallback = true; }
      const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error('Original media could not load');
      const decoded = await this.decodeAudio(await response.arrayBuffer());
      if (fallback) {
        const start = Math.min(decoded.samples.length, Math.floor(line.startTime * decoded.sampleRate));
        const end = Math.min(decoded.samples.length, Math.floor(line.endTime * decoded.sampleRate));
        const samples = new Float32Array(Math.max(0, end - start)); samples.set(decoded.samples.subarray(start, end));
        reference = { samples, duration: samples.length / decoded.sampleRate, sampleRate: decoded.sampleRate };
      } else reference = decoded;
    } catch {
      reference = null;
    }
    if (generation !== this.referenceGeneration || viewGeneration !== this.waveformGeneration || matchId !== this.matchId || this.line?.id !== lineId) return;
    const entry = this.waveformCache.get(key) || {};
    entry.referenceResolved = true; entry.reference = reference; this.waveformCache.set(key, entry);
    this.referenceSamples = reference?.samples || null; this.referenceDuration = reference?.duration || 0;
    this.referenceSampleRate = reference?.sampleRate || 0;
    if (this.waveformStatus) this.waveformStatus.textContent = reference ? 'Original waveform ready' : 'Original waveform unavailable';
    this.drawWaveform();
  }
  async loadTakeWaveform(blob, takeId, url) {
    if (!this.line) return;
    const generation = ++this.takeGeneration; const matchId = this.matchId; const lineId = this.line.id;
    const viewGeneration = this.waveformGeneration; const cacheKey = `${matchId || ''}:${takeId}`;
    const cached = this.decodedTakes.get(cacheKey);
    if (cached) { this.takeSamples = cached.samples; this.takeDuration = cached.duration; this.takeSampleRate = cached.sampleRate; this.drawWaveform(); return; }
    try {
      let bytes;
      if (blob) bytes = await blob.arrayBuffer();
      else {
        const response = await fetch(url, { credentials: 'same-origin', signal: this.waveformAbort?.signal });
        if (!response.ok) throw new Error('Take could not load');
        bytes = await response.arrayBuffer();
      }
      const decoded = await this.decodeAudio(bytes);
      if (generation !== this.takeGeneration || viewGeneration !== this.waveformGeneration || matchId !== this.matchId || this.line?.id !== lineId) return;
      this.decodedTakes.set(cacheKey, decoded);
      this.takeSamples = decoded.samples; this.takeDuration = decoded.duration;
      this.takeSampleRate = decoded.sampleRate;
      this.drawWaveform();
    } catch {
      if (generation !== this.takeGeneration || viewGeneration !== this.waveformGeneration || matchId !== this.matchId || this.line?.id !== lineId) return;
      if (this.waveformStatus && this.waveformStatus.textContent !== 'Original waveform unavailable') this.waveformStatus.textContent = 'Your take waveform unavailable';
    }
  }
  setLine(pack, line, allowed, settings, paused = false, matchId = this.client.state?.session?.matchId) {
    const wasPaused = this.paused; this.paused = paused;
    const matchChanged = this.matchId !== matchId;
    const changed = matchChanged || this.packId !== pack?.id || this.line?.id !== line?.id;
    if (changed) {
      this.sceneSeekToken++;
      this.cancelPendingWaits(); this.waveformAbort?.abort(); this.waveformGeneration++; this.referenceGeneration++; this.takeGeneration++;
      this.waveformAbort = new AbortController();
      this.abort('', true);
      this.dismissedTakeId = null; this.observedCandidateId = null;
      this.acceptedTake = null; this.retakeId = ''; this.retakeAttemptId = ''; this.retakeAttemptPending = false;
      if (matchChanged) { this.waveformCache.clear(); this.decodedTakes.clear(); }
      this.referenceSamples = null; this.takeSamples = null; this.referenceDuration = 0; this.takeDuration = 0; this.localTiming = null; this.captureTiming = null; this.livePeaks = null;
      this.referenceSampleRate = 0; this.takeSampleRate = 0;
    } else if (!allowed && this.allowed && (activeCapture(this.mode) || this.currentSave() || this.mode === 'accepting')) {
      this.abort('', true);
    }
    this.allowed = allowed; this.settings = settings; this.line = line; this.packId = pack?.id; this.matchId = matchId;
    if (settings?.voiceEffectsEnabled === false && this.currentEffect !== 'normal') this.setEffect('normal');
    if (pack && this.video.getAttribute('src') !== pack.videoUrl) {
      this.stopMedia(); this.video.src = pack.videoUrl; this.video.muted = true;
    }
    if (changed && line) {
      this.referenceLoadPromise = this.loadReferenceWaveform();
      const token = this.sceneSeekToken; const lineId = line.id; const currentMatch = matchId;
      this.seek(line.startTime, () => token === this.sceneSeekToken && this.line?.id === lineId && this.matchId === currentMatch).catch(() => {});
    }
    if (!line) {
      this.referenceSamples = null; this.takeSamples = null;
      if (this.waveformStatus) this.waveformStatus.textContent = '';
    }
    this.updateControls();
    if (wasPaused && !paused && allowed && this.blob) {
      // A save interrupted by a host pause can finish unwinding before retrying.
      this.saveTail.then(() => {
        if (!this.paused && this.allowed && this.blob) this.save().catch(() => {});
      });
    }
  }
  setCandidate(take) {
    this.setTakes(take, this.acceptedTake, null);
  }
  setTakes(take, acceptedTake, replacementTake) {
    const previousAcceptedId = this.acceptedTake?.id;
    this.acceptedTake = acceptedTake?.status === 'accepted' ? acceptedTake : null;
    const playerId = this.client.state?.viewer.playerId;
    const replacementOwned = replacementTake?.status === 'recorded' && replacementTake.playerId === playerId;
    const candidate = replacementOwned ? replacementTake : take?.status === 'recorded' && take.playerId === playerId ? take : null;
    if (!candidate) {
      if (this.observedCandidateId) {
        const wasAccepted = this.acceptedTake?.id === this.observedCandidateId;
        this.observedCandidateId = null;
        this.retakeId = '';
        if (wasAccepted) {
          this.clearTake();
          if (this.mode !== 'accepting') this.mode = 'idle';
        } else {
          this.abort('', true);
          this.status.textContent = 'Record a new take';
        }
      }
      if (this.acceptedTake && previousAcceptedId !== this.acceptedTake.id) {
        this.review.src = this.acceptedTake.url;
        this.loadTakeWaveform(null, this.acceptedTake.id, this.acceptedTake.url);
      } else if (this.acceptedTake && !this.takeSamples) this.loadTakeWaveform(null, this.acceptedTake.id, this.acceptedTake.url);
      this.updateControls();
      return;
    }
    this.observedCandidateId = candidate.id;
    this.retakeId = replacementOwned ? replacementTake.retakeId || '' : '';
    if (activeCapture(this.mode) || candidate.id === this.dismissedTakeId || this.blob) return;
    if (this.savedTake?.id !== candidate.id) {
      this.takeGeneration++; this.takeSamples = null; this.takeDuration = 0; this.takeSampleRate = 0;
      this.savedTake = candidate; this.savedBlob = null;
      this.review.src = candidate.url; this.mode = 'review'; this.status.textContent = 'Take ready';
      this.loadTakeWaveform(null, candidate.id, candidate.url);
    }
    this.updateControls();
  }
  async waitMedia(element, name, timeout = 15000) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); element.removeEventListener(name, done); element.removeEventListener('error', fail); this.mediaWaits.delete(wait); };
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('Video unavailable — ask host')); };
      const wait = { cancel: () => { cleanup(); resolve(); } };
      this.mediaWaits.add(wait); timer = setTimeout(fail, timeout);
      element.addEventListener(name, done, { once: true }); element.addEventListener('error', fail, { once: true });
    });
  }
  cancelMediaWaits() { for (const wait of [...this.mediaWaits]) wait.cancel(); }
  async seek(time, isCurrent = () => true) {
    if (this.video.readyState < 1) await this.waitMedia(this.video, 'loadedmetadata');
    if (!isCurrent()) return;
    this.video.pause();
    if (Math.abs(this.video.currentTime - time) > 0.015) {
      const sought = this.waitMedia(this.video, 'seeked');
      this.video.currentTime = time; await sought;
      if (!isCurrent()) return;
    }
  }
  stopMedia() {
    this.mediaGeneration++; cancelAnimationFrame(this.frame); this.cancelMediaWaits();
    if (this.startListener) { this.video.removeEventListener('playing', this.startListener); this.startListener = null; }
    this.video.pause(); this.reference.pause(); this.review.pause(); this.video.muted = true;
    if (['original', 'my-take'].includes(this.mode)) this.mode = this.hasPlaybackTake() ? 'review' : 'idle';
    this.activeAnalyser = this.captureAnalyser || null;
    this.drawWaveform(false); this.updateControls();
  }
  async playFragment(audio, mode, fallback = false, padded = false) {
    if (!this.line || activeCapture(this.mode) || this.mode === 'accepting') return;
    this.stopMedia(); const generation = this.generation; const mediaGeneration = this.mediaGeneration;
    const line = this.line;
    const mediaElement = audio || this.video;
    const context = this.ensureAudioContext();
    this.activeAnalyser = this.ensureMediaAnalyser(mediaElement) || null;
    if (context?.state === 'suspended') context.resume().catch(() => {});
    this.mode = mode; this.updateControls(); this.drawWaveform(true);
    const takeTiming = this.localTiming || this.savedTake || this.acceptedTake;
    const leadIn = mode === 'my-take' ? (takeTiming?.leadIn || 0) : 0;
    const tail = mode === 'my-take' ? (takeTiming?.tail || 0) : 0;
    const takeTimelineStart = line.startTime - leadIn;
    const fragmentStart = mode === 'my-take' ? Math.max(0, takeTimelineStart)
      : padded ? Math.max(0, line.startTime - (this.settings?.previewBefore ?? 1.5)) : line.startTime;
    const fragmentEnd = mode === 'my-take' ? line.endTime + tail : padded ? line.endTime + (this.settings?.previewAfter ?? 0.5) : line.endTime;
    let audioTail = 0; let audioPlaybackEnd = 0;
    await this.seek(fragmentStart);
    if (generation !== this.generation || mediaGeneration !== this.mediaGeneration) return;
    if (audio) {
      audio.load();
      if (audio.readyState < 2) await this.waitMedia(audio, 'loadeddata');
      // A cue at video time zero cannot play negative-time lead-in. Skip just
      // that portion of the take, keeping the actual speech on the cue.
      audio.currentTime = mode === 'my-take' ? Math.max(0, -takeTimelineStart) : 0;
      if (Number.isFinite(audio.duration)) {
        audioPlaybackEnd = mode === 'my-take' ? audio.duration
          : Math.min(audio.duration, line.duration + referenceOverhang(line.duration, audio.duration, 0));
        audioTail = Math.max(0, audioPlaybackEnd - (line.endTime - (mode === 'my-take' ? takeTimelineStart : line.startTime)));
      }
    }
    if (generation !== this.generation || mediaGeneration !== this.mediaGeneration) return;
    this.video.muted = !fallback;
    this.status.textContent = mode === 'original' ? 'Original' : 'My take';
    let voiceStarted = false;
    const startAudio = () => {
      if (!audio || voiceStarted || this.video.currentTime < (mode === 'my-take' ? fragmentStart : line.startTime) - 0.005 || generation !== this.generation || mediaGeneration !== this.mediaGeneration) return;
      voiceStarted = true;
      audio.play().catch(() => { this.stopMedia(); this.friendly('Video unavailable — ask host'); });
    };
    this.startListener = startAudio;
    this.video.addEventListener('playing', startAudio, { once: true });
    try { await this.video.play(); } catch (error) { this.stopMedia(); throw error; }
    const step = () => {
      if (generation !== this.generation || mediaGeneration !== this.mediaGeneration) return;
      // Voice playback supplies the fragment timeline when an audio take exists.
      if (audio && !voiceStarted && this.video.currentTime >= (mode === 'my-take' ? fragmentStart : line.startTime)) startAudio();
      if (audio && voiceStarted && !audio.paused && !audio.ended && this.video.currentTime < line.endTime) {
        const desired = (mode === 'my-take' ? takeTimelineStart : line.startTime) + audio.currentTime;
        if (Math.abs(this.video.currentTime - desired) > 0.15) this.video.currentTime = Math.min(desired, line.endTime);
      }
      const audioFinished = audio && (audio.ended || (audioPlaybackEnd > 0 && audio.currentTime >= audioPlaybackEnd - 0.015));
      if (audio && this.video.currentTime >= line.endTime) {
        if (audioTail > 0) this.video.pause();
        if (audioTail <= 0 || audioFinished) audio.pause();
      }
      // Never stop an overhanging reference MP3 just because the video cue
      // reached dub_ends. The tail is audible with the final video frame held.
      if (audioTail > 0 ? audioFinished : this.video.currentTime >= fragmentEnd || this.video.ended) {
        this.stopMedia(); this.status.textContent = this.hasPlaybackTake() ? 'Take ready' : ''; this.updateControls(); return;
      }
      this.drawWaveform(true);
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step); this.updateControls();
  }
  async playOriginal() {
    if (!this.line) return;
    if (this.settings?.referencePlaybackEnabled === false) return;
    if (this.mode === 'original') { this.stopMedia(); this.status.textContent = this.hasPlaybackTake() ? 'Take ready' : ''; return; }
    if (this.line.referenceAudio) {
      this.reference.src = this.line.referenceAudio;
      await this.playFragment(this.reference, 'original', false, true);
    } else await this.playFragment(null, 'original', true, true);
  }
  async playTake() {
    if (!this.hasPlaybackTake()) return;
    if (this.mode === 'my-take') { this.stopMedia(); this.status.textContent = 'Take ready'; return; }
    const take = this.savedTake || this.acceptedTake;
    this.review.src = this.objectUrl || take.url;
    await this.playFragment(this.review, 'my-take');
  }
  async discardCurrent() {
    if (activeCapture(this.mode) || this.mode === 'accepting') return false;
    const lineId = this.line?.id;
    if (!lineId) return true;
    if (this.currentSave()) await this.currentSave().promise.catch(() => {});
    if (this.retakeId || this.retakeAttemptPending) {
      const retakeId = this.retakeId || await this.resolveRetakeId(lineId);
      if (retakeId) await this.client.request('/api/takes/' + encodeURIComponent(lineId) + '/retake/cancel', { retakeId });
    } else if (this.savedTake?.status === 'recorded') {
      await this.client.request('/api/takes/' + encodeURIComponent(lineId) + '/discard', { takeId: this.savedTake.id });
    }
    this.cancelRecording('', true);
    this.observedCandidateId = null; this.retakeId = ''; this.retakeAttemptId = ''; this.retakeAttemptPending = false;
    return true;
  }
  async cancelActiveRetake() {
    if (!this.line || (!this.retakeId && !this.retakeAttemptPending) || activeCapture(this.mode) || this.mode === 'accepting') return false;
    const lineId = this.line.id; const retakeId = this.retakeId || await this.resolveRetakeId(lineId);
    if (!retakeId) return false;
    await this.client.request('/api/takes/' + encodeURIComponent(lineId) + '/retake/cancel', { retakeId });
    if (this.line?.id === lineId) {
      this.retakeId = ''; this.retakeAttemptId = ''; this.retakeAttemptPending = false; this.observedCandidateId = null;
      this.acceptedTake = this.client.state?.session?.lineTakes?.[lineId] || this.acceptedTake;
      this.clearTake(); this.mode = 'idle'; this.status.textContent = '';
      this.updateControls();
    }
    return true;
  }
  pauseCapture() {
    if (activeCapture(this.mode)) this.cancelRecording();
    else if (['original', 'my-take'].includes(this.mode)) this.stopMedia();
  }
  captureBackup() {
    return { blob: this.blob, objectUrl: this.objectUrl, savedTake: this.savedTake, savedBlob: this.savedBlob, dismissedTakeId: this.dismissedTakeId, retakeId: this.retakeId, acceptedTake: this.acceptedTake, localTiming: this.localTiming };
  }
  async resolveRetakeId(lineId, generation = this.generation) {
    if (this.retakeId) return this.retakeId;
    if (!this.retakeAttemptId) return '';
    this.retakeAttemptPending = true;
    const body = { attemptId: this.retakeAttemptId };
    const route = '/api/takes/' + encodeURIComponent(lineId) + '/retake';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.client.request(route, body);
        if (generation !== this.generation) return '';
        if (typeof result.retakeId !== 'string' || !result.retakeId) throw new Error('Retake could not start');
        this.retakeId = result.retakeId;
        this.retakeAttemptId = ''; this.retakeAttemptPending = false;
        return this.retakeId;
      } catch (problem) {
        if (problem.status) {
          if (problem.status < 500) { this.retakeAttemptId = ''; this.retakeAttemptPending = false; }
          throw problem;
        }
        if (attempt === 2 || generation !== this.generation) throw problem;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    return '';
  }
  releaseBackup() {
    if (this.backup?.objectUrl && this.backup.objectUrl !== this.objectUrl) URL.revokeObjectURL(this.backup.objectUrl);
    this.backup = null;
  }
  async importSound(file) {
    if (!this.line || !this.allowed || activeCapture(this.mode) || this.mode === 'accepting') return;
    if (!file || !file.size || file.size > 25 * 1024 * 1024) throw new Error('Choose an audio file under 25 MB');
    this.stopMedia();
    const generation = ++this.generation; const line = this.line;
    this.backup = this.captureBackup();
    this.mode = 'settling'; this.status.textContent = 'Importing sound…'; this.updateControls();
    try {
      if (this.acceptedTake && !this.retakeId) {
        this.retakeAttemptId ||= newRetakeAttemptId();
        this.retakeAttemptPending = true;
        const retakeId = await this.resolveRetakeId(line.id, generation);
        if (generation !== this.generation || !this.allowed) return;
        if (!retakeId) throw new Error('Retake could not start');
      }
      const blob = await this.client.processSoundpadAudio(line.id, file, this.retakeId);
      if (generation !== this.generation || !this.allowed || this.line?.id !== line.id) return;
      if (!(blob instanceof Blob) || !blob.size) throw new Error('Audio conversion returned an empty file');
      const decoded = await this.decodeAudio(await blob.arrayBuffer());
      if (generation !== this.generation || !this.allowed || this.line?.id !== line.id) return;
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error('Could not decode sound');
      this.localTiming = { leadIn: 0, tail: Math.round(Math.min(2, Math.max(0, decoded.duration - line.duration)) * 1000) / 1000 };
      this.dismissedTakeId = this.backup?.savedTake?.id ?? this.observedCandidateId;
      this.takeGeneration++; this.takeSamples = null; this.takeDuration = 0; this.takeSampleRate = 0;
      this.prepareRecordedTake(blob, line, generation, true).catch(error => {
        if (generation === this.generation) this.cancelRecording(`Sound import failed: ${error.message}`);
      });
    } catch (error) {
      if (generation === this.generation) this.cancelRecording(`Sound import failed: ${error.message}`);
    }
  }
  async record() {
    if (!this.line || !this.allowed || activeCapture(this.mode) || this.mode === 'accepting') return;
    this.audioContext?.resume().catch(() => {});
    this.stopMedia(); const generation = ++this.generation; const line = this.line;
    this.backup = this.captureBackup();
    this.mode = 'requesting'; this.updateControls();
    await this.enableMicrophone();
    if (generation !== this.generation || !this.allowed) return;
    if (this.acceptedTake && !this.retakeId) {
      this.retakeAttemptId ||= newRetakeAttemptId();
      this.retakeAttemptPending = true;
      const retakeId = await this.resolveRetakeId(line.id, generation);
      if (generation !== this.generation || !this.allowed) return;
      if (!retakeId) throw new Error('Retake could not start');
    }
    this.mode = 'countdown'; this.status.textContent = ''; this.updateControls();
    await this.seek(line.startTime);
    if (!this.skipCountdown?.checked) {
      for (let count = 3; count > 0; count--) {
        if (generation !== this.generation) return;
        this.countdown.textContent = String(count); this.countdown.hidden = false;
        await this.waitCancelable(1000, generation);
      }
    }
    if (generation !== this.generation) return;
    this.countdown.hidden = true;
    this.mode = 'preroll'; this.status.textContent = 'Starting…'; this.updateControls();
    await this.waitCancelable(200, generation);
    if (generation !== this.generation) return;
    // Waveform and actual capture must use the same cue length. The original
    // audio can extend a little beyond the INI's dub_ends timestamp.
    if (this.referenceLoadPromise) await Promise.race([this.referenceLoadPromise, this.waitCancelable(1500, generation)]);
    if (generation !== this.generation) return;
    const overhang = this.cueOverhang();
    this.activeCueOverhang = overhang; // Frozen for this take, even if the reference finishes loading later.
    const mimeType = chooseRecordingMime(); const chunks = [];
    const recorder = new MediaRecorder(this.captureDestination?.stream || this.stream, mimeType ? { mimeType } : undefined);
    this.recorder = recorder;
    recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener('error', () => {
      if (generation === this.generation) { this.cancelRecording(); this.friendly('Recording failed — try again'); }
    });
    recorder.addEventListener('stop', () => {
      if (generation !== this.generation) return;
      clearTimeout(this.stopFallbackTimer); this.stopRequested = false; this.pendingStopGeneration = null;
      // Tail was frozen at recorder.stop(), not at this asynchronous event.
      // Finalizing the encoded WebM may take hundreds of milliseconds.
      this.localTiming = this.captureTiming ? { ...this.captureTiming } : null;
      this.captureTiming = null; this.activeCueOverhang = 0; this.livePeaks = null; this.captureStartedAt = 0; this.stopRequestedAt = 0; this.captureDeadline = 0; this.captureDuration = 0; this.captureCueEndAt = 0;
      this.stopMedia(); clearTimeout(this.recordingWatchdog);
      if (this.progress) this.progress.hidden = true;
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      if (!blob.size) { this.cancelRecording(); this.friendly('Recording failed — try again'); return; }
      this.prepareRecordedTake(blob, line, generation).catch(() => {
        if (generation === this.generation) this.cancelRecording('Recording failed — try again');
      });
    }, { once: true });
    // MediaRecorder now starts BEFORE video.play(), avoiding the previously lost
    // first ~100-200ms. The measured offset travels with the take to playback/export.
    const captureStart = performance.now();
    this.captureStartedAt = captureStart;
    this.captureDeadline = 0; this.captureCueEndAt = 0; this.captureDuration = 0;
    this.captureTiming = { leadIn: 0, tail: captureTail(overhang, this.effectTailMilliseconds() / 1000) };
    this.livePeaks = createLivePeaks(line.duration + 3);
    this.dismissedTakeId = this.backup?.savedTake?.id ?? this.observedCandidateId;
    this.blob = null; this.objectUrl = null; this.savedTake = null; this.savedBlob = null; this.localTiming = null;
    this.takeGeneration++; this.takeSamples = null; this.takeDuration = 0; this.takeSampleRate = 0;
    this.stopRequested = false; this.pendingStopGeneration = null;
    if (this.effectInputGain && this.audioContext) {
      this.effectInputGain.gain.cancelScheduledValues(this.audioContext.currentTime);
      this.effectInputGain.gain.setTargetAtTime(1, this.audioContext.currentTime, 0.004);
    }
    this.effectProcessor?.port.postMessage({ type: 'begin', duration: line.duration + 3 });
    recorder.start();
    this.mode = 'preroll'; this.status.textContent = 'Capturing lead-in…'; this.waveform.hidden = false;
    if (this.progress) { this.progress.max = line.duration + this.captureTiming.tail; this.progress.value = 0; this.progress.hidden = false; }
    this.updateControls();
    const prerollDraw = () => {
      if (generation !== this.generation || recorder.state !== 'recording' || this.mode !== 'preroll') return;
      this.sampleLiveWaveform(); this.drawWaveform(true);
      this.frame = requestAnimationFrame(prerollDraw);
    };
    this.frame = requestAnimationFrame(prerollDraw);
    const start = () => {
      this.startListener = null;
      cancelAnimationFrame(this.frame);
      if (generation !== this.generation || recorder.state !== 'recording') return;
      const leadIn = (performance.now() - captureStart) / 1000;
      if (leadIn > 1) { this.cancelRecording('Video took too long to start — record again'); return; }
      this.captureTiming.leadIn = Math.round(Math.max(0, leadIn) * 1000) / 1000;
      const cueStartAt = performance.now();
      const plan = capturePlan(captureStart, cueStartAt, line.duration, overhang, this.effectTailMilliseconds() / 1000);
      this.captureCueEndAt = cueStartAt + (line.duration + overhang) * 1000;
      this.captureDeadline = plan.deadlineMs;
      this.captureDuration = plan.duration;
      this.captureTiming.tail = plan.tail;
      if (this.progress) this.progress.max = this.captureDuration;
      this.mode = 'recording'; this.status.textContent = 'Recording'; this.updateControls();
      this.recordingWatchdog = setTimeout(() => {
        if (generation === this.generation && recorder.state === 'recording') { this.cancelRecording(); this.friendly('Recording failed — try again'); }
      }, (line.duration + 4) * 1000);
      let previousTime = this.video.currentTime; let lastAdvance = performance.now();
      const step = () => {
        if (generation !== this.generation || recorder.state !== 'recording') return;
        const now = performance.now();
        this.sampleLiveWaveform();
        if (!this.reducedMotion || now - (this.lastWaveformDrawAt || 0) > 120) {
          this.lastWaveformDrawAt = now; this.drawWaveform(true);
        }
        if (!this.stopRequested) {
          if (this.video.currentTime > previousTime + 0.001) { previousTime = this.video.currentTime; lastAdvance = now; }
          if ((this.video.ended && this.video.currentTime < line.endTime - 0.05) || (!this.video.ended && now - lastAdvance > 1500)) {
            this.cancelRecording(); this.friendly('Recording failed — try again'); return;
          }
          // Video's media clock may jump ahead (or the last frame may end
          // before the MP3). Never let it stop the actual microphone capture.
          if (now >= this.captureCueEndAt) this.stopRecording();
        }
        if (this.progress) this.progress.value = Math.max(0, Math.min(this.progress.max, (now - this.captureStartedAt) / 1000));
        this.frame = requestAnimationFrame(step);
      };
      this.frame = requestAnimationFrame(step);
    };
    this.startListener = start;
    this.video.muted = true; this.video.addEventListener('playing', start, { once: true });
    await this.waitCancelable(CAPTURE_PRIME_MS, generation);
    if (generation !== this.generation) return;
    try { await this.video.play(); } catch (error) { this.video.removeEventListener('playing', start); throw error; }
  }
  sampleLiveWaveform() {
    if (!this.livePeaks || !this.captureAnalyser || !this.captureStartedAt) return;
    const analyser = this.captureAnalyser;
    const data = this.liveSamples?.length === analyser.fftSize ? this.liveSamples : new Float32Array(analyser.fftSize);
    this.liveSamples = data;
    analyser.getFloatTimeDomainData?.(data);
    appendLivePeaks(this.livePeaks, (performance.now() - this.captureStartedAt) / 1000, data);
  }

  async prepareRecordedTake(blob, line, generation, imported = false) {
    if (generation !== this.generation) return;
      this.mode = 'settling'; this.status.textContent = !imported && this.currentEffect === 'custom' ? 'Applying Custom FFmpeg effect…' : 'Finishing take…'; this.updateControls();
      let finishedBlob = blob;
      if (!imported && this.currentEffect === 'custom') {
        try {
          finishedBlob = await this.client.processCustomAudio(line.id, blob, this.customArgs, this.retakeId);
          if (!(finishedBlob instanceof Blob) || !finishedBlob.size) throw new Error('Empty Custom FFmpeg result');
        } catch (error) {
          if (generation === this.generation) this.cancelRecording(`Custom effect failed: ${error.message || 'record again'}`);
          return;
        }
      }
      if (generation !== this.generation || this.mode !== 'settling') return;
      this.blob = finishedBlob; this.objectUrl = URL.createObjectURL(finishedBlob); this.savedTake = null; this.savedBlob = null;
      this.review.src = this.objectUrl;
      this.localTakeSerial = (this.localTakeSerial || 0) + 1;
      const localTakeId = `local-${this.localTakeSerial}`;
      this.loadTakeWaveform(finishedBlob, localTakeId, this.objectUrl);
      this.save().catch(() => {});
      this.waitCancelable(200, generation).then(() => {
        if (generation !== this.generation || this.mode !== 'settling') return;
        this.releaseBackup(); this.mode = 'review'; this.status.textContent = 'Take ready'; this.updateControls();
      });
  }
  drawWaveform(active = false) {
    if (!this.waveform) return;
    if (['original', 'my-take'].includes(this.mode)) {
      const now = performance.now(); const interval = this.reducedMotion ? 250 : 100;
      if (now - (this.lastWaveformDrawAt || 0) < interval) return;
      this.lastWaveformDrawAt = now;
    }
    const bounds = this.waveform.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(bounds.width * pixelRatio); const pixelHeight = Math.round(bounds.height * pixelRatio);
    if (this.waveform.width !== pixelWidth || this.waveform.height !== pixelHeight) {
      this.waveform.width = pixelWidth; this.waveform.height = pixelHeight;
    }
    const context = this.waveform.getContext('2d'); if (!context) return;
    const width = bounds.width; const height = bounds.height; const center = height / 2;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0); context.clearRect(0, 0, width, height);
    const isCapturing = this.livePeaks && ['preroll', 'recording'].includes(this.mode);
    const take = this.savedTake || this.acceptedTake;
    const timing = isCapturing ? this.captureTiming : (this.localTiming || take);
    const leadIn = timing?.leadIn || 0; const tail = timing?.tail || 0;
    const visibleOverhang = isCapturing ? (this.activeCueOverhang || 0) : referenceOverhang(this.line?.duration || 0, this.referenceDuration, 0);
    const visibleReferenceDuration = Math.min(this.referenceDuration, (this.line?.duration || 0) + visibleOverhang);
    // One duration for the live waveform, playhead and progress bar.
    // In particular, never add a reference tail beyond the actual capture.
    const duration = isCapturing && this.captureDuration > 0 ? this.captureDuration
      : Math.max((this.line?.duration || 0) + leadIn + tail, visibleReferenceDuration + leadIn, this.takeDuration, 0.05);
    const drawSamples = (samples, sampleRate, sampleDuration, color, alpha, offset = 0) => {
      if (!samples?.length || !sampleRate || !sampleDuration) return;
      context.globalAlpha = alpha; context.strokeStyle = color; context.lineWidth = 1;
      const scale = height * 0.43; const columns = Math.max(1, Math.ceil(width));
      const samplesPerColumn = Math.max(1, Math.ceil(duration * sampleRate / columns));
      for (let column = 0; column < columns; column++) {
        const time = column / columns * duration - offset;
        if (time < 0) continue;
        if (time >= sampleDuration) break;
        const start = Math.min(samples.length - 1, Math.floor(time * sampleRate));
        const end = Math.min(samples.length, Math.max(start + 1, start + samplesPerColumn));
        let minimum = 0; let maximum = 0;
        for (let index = start; index < end; index++) { minimum = Math.min(minimum, samples[index]); maximum = Math.max(maximum, samples[index]); }
        const x = column / columns * width;
        context.beginPath(); context.moveTo(x, center - maximum * scale); context.lineTo(x, center - minimum * scale); context.stroke();
      }
      context.globalAlpha = 1;
    };
    context.strokeStyle = '#515151'; context.lineWidth = 1;
    context.beginPath(); context.moveTo(0, center); context.lineTo(width, center); context.stroke();
    drawSamples(this.referenceSamples, this.referenceSampleRate, visibleReferenceDuration, '#b093ff', 0.82, leadIn);
    if (isCapturing) {
      context.strokeStyle = '#67e5ff'; context.lineWidth = 1.5; context.globalAlpha = 0.98;
      const peaks = this.livePeaks; const scale = height * 0.43;
      for (let bin = 0; bin < peaks.recorded.length; bin++) {
        if (!peaks.recorded[bin]) continue;
        const x = (bin / peaks.binsPerSecond) / duration * width;
        if (x > width) break;
        context.beginPath(); context.moveTo(x, center - peaks.maxima[bin] * scale);
        context.lineTo(x, center - peaks.minima[bin] * scale); context.stroke();
      }
      context.globalAlpha = 1;
    } else drawSamples(this.takeSamples, this.takeSampleRate, this.takeDuration, '#67e5ff', 0.98);
    if (['original', 'my-take', 'recording', 'preroll'].includes(this.mode)) {
      const elapsed = isCapturing ? Math.max(0, (performance.now() - this.captureStartedAt) / 1000)
        : this.mode === 'my-take' ? this.review.currentTime : this.video.currentTime - this.line.startTime + leadIn;
      const x = Math.max(0, Math.min(width, elapsed / duration * width));
      context.strokeStyle = '#f4f4f4'; context.lineWidth = 1.5; context.globalAlpha = 0.95;
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); context.globalAlpha = 1;
    }
  }

  stopRecording(manual = false) {
    if (this.mode !== 'recording' || this.recorder?.state !== 'recording' || this.stopRequested) return;
    this.video.pause(); clearTimeout(this.recordingWatchdog);
    this.stopRequested = true; this.pendingStopGeneration = this.generation; this.stopRequestedAt = performance.now();
    // Do not close the capture gate here: that was cutting final consonants.
    // The microphone stays live for the tail and the recorder stops afterward.
    if (this.currentEffect === 'walkieTalkie') this.effectProcessor?.port.postMessage({ type: 'endingClick' });
    this.status.textContent = 'Capturing the end…'; this.updateControls();
    if (manual) {
      // STOP is allowed early, so shorten the waveform to the new real stop.
      this.captureDeadline = this.stopRequestedAt + this.effectTailMilliseconds();
      this.captureDuration = (this.captureDeadline - this.captureStartedAt) / 1000;
    }
    if (this.progress) this.progress.max = this.captureDuration;
    this.stopFallbackTimer = setTimeout(() => this.finishRecording(this.pendingStopGeneration),
      Math.max(0, Math.ceil(this.captureDeadline - performance.now())));
  }
  effectTailMilliseconds() {
    return ({ echo: 850, cave: 1100 })[this.currentEffect] ?? CAPTURE_TAIL_MS;
  }
  finishRecording(generation) {
    clearTimeout(this.stopFallbackTimer);
    if (generation !== this.generation || this.recorder?.state !== 'recording') return;
    // A delayed or early timer should not make the playhead and the audio diverge.
    if (performance.now() + 2 < this.captureDeadline) {
      this.stopFallbackTimer = setTimeout(() => this.finishRecording(generation), Math.ceil(this.captureDeadline - performance.now()));
      return;
    }
    this.pendingStopGeneration = null;
    const finishedAt = performance.now();
    if (this.captureTiming) this.captureTiming.tail = recordedTail(this.captureStartedAt, finishedAt,
      this.captureTiming.leadIn, this.line?.duration || 0);
    if (this.progress) { this.progress.max = this.captureDuration; this.progress.value = this.captureDuration; }
    this.sampleLiveWaveform(); this.drawWaveform(true);
    try { this.recorder.stop(); } catch {}
  }
  cancelRecording(message = '', discard = false) {
    this.generation++; this.cancelPendingWaits(); this.stopMedia(); clearTimeout(this.recordingWatchdog); clearTimeout(this.stopFallbackTimer);
    this.takeGeneration++;
    this.stopRequested = false; this.pendingStopGeneration = null;
    this.captureTiming = null; this.activeCueOverhang = 0; this.livePeaks = null; this.captureStartedAt = 0; this.stopRequestedAt = 0; this.captureDeadline = 0; this.captureDuration = 0; this.captureCueEndAt = 0;
    this.countdown.hidden = true; this.waveform.hidden = false;
    if (this.progress) this.progress.hidden = true;
    if (this.recorder?.state === 'recording') { try { this.recorder.stop(); } catch {} }
    if (!discard && this.backup) {
      const activeRetakeId = this.retakeId;
      if (this.objectUrl && this.objectUrl !== this.backup.objectUrl) URL.revokeObjectURL(this.objectUrl);
      Object.assign(this, this.backup); this.backup = null;
      if (activeRetakeId) this.retakeId = activeRetakeId;
      if (this.objectUrl || this.savedTake) this.review.src = this.objectUrl || this.savedTake.url;
      if (this.blob) this.loadTakeWaveform(this.blob, `restored-local-${this.line?.id || ''}`, this.objectUrl);
      else if (this.savedTake) this.loadTakeWaveform(null, this.savedTake.id, this.savedTake.url);
    } else if (discard) {
      this.clearTake(); this.releaseBackup();
    }
    this.mode = this.hasTake() ? 'review' : 'idle';
    this.status.textContent = message || (this.hasTake() ? 'Take ready' : '');
    this.updateControls();
  }
  clearTake() {
    this.takeGeneration++; this.takeSamples = null; this.takeDuration = 0; this.takeSampleRate = 0; this.localTiming = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.blob = null; this.objectUrl = null; this.savedTake = null; this.savedBlob = null;
    this.review.pause(); this.review.removeAttribute('src');
    this.drawWaveform();
  }
  abort(message = '', discard = false) { this.cancelRecording(message, discard); }
  save() {
    if (!this.blob) return Promise.resolve(this.savedTake);
    if (this.savedTake && this.savedBlob === this.blob) return Promise.resolve(this.savedTake);
    if (this.currentSave()) return this.currentSave().promise;
    if (!this.line || !this.allowed || this.paused || this.destroyed) return Promise.resolve(null);
    const generation = this.generation; const blob = this.blob; const lineId = this.line.id;
    const job = { generation, promise: null };
    this.saveJob = job;
    job.promise = this.saveTail.catch(() => {}).then(async () => {
      if (generation !== this.generation || !this.allowed || this.paused || this.blob !== blob) {
        if (this.saveJob === job) this.saveJob = null;
        return null;
      }
      const timer = setTimeout(() => {
        if (generation === this.generation && this.saveJob === job && !activeCapture(this.mode) && this.mode !== 'accepting') this.status.textContent = 'Saving…';
      }, 1000);
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (generation !== this.generation || !this.allowed || this.paused || this.blob !== blob) return null;
          try {
            const body = new FormData();
            body.append('take', blob, 'voice.' + (blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'));
            const snapshot = await this.client.request('/api/takes/' + encodeURIComponent(lineId), body, { multipart: true, retakeId: this.retakeId, takeTiming: this.localTiming });
            if (generation !== this.generation || !this.allowed || this.blob !== blob) return null;
            const take = this.retakeId ? snapshot.session.replacementTakes?.[lineId] : snapshot.session.lineTakes[lineId];
            if (!take || take.status !== 'recorded' || take.playerId !== this.client.state?.viewer.playerId) return null;
            this.savedTake = take; this.savedBlob = blob; this.observedCandidateId = take.id;
            if (!['original', 'my-take', 'accepting', 'settling'].includes(this.mode)) this.status.textContent = 'Take ready';
            return take;
          } catch (error) {
            if (generation !== this.generation || !this.allowed || this.paused || this.blob !== blob) return null;
            if (staleSave(error)) { this.abort('', true); this.status.textContent = 'Record a new take'; return null; }
            if (attempt === 2) { this.status.textContent = 'Save failed — try again'; throw new Error('Save failed — try again'); }
            await new Promise(resolve => setTimeout(resolve, 900 * (attempt + 1)));
          }
        }
      } finally {
        clearTimeout(timer);
        if (this.saveJob === job) this.saveJob = null;
        this.updateControls();
      }
    });
    this.saveTail = job.promise.catch(() => {});
    return job.promise;
  }
  async next() {
    if (!this.line || !this.allowed || !this.hasTake() || activeCapture(this.mode) || this.mode === 'accepting') return;
    this.stopMedia(); const generation = this.generation; const lineId = this.line.id;
    this.mode = 'accepting'; this.updateControls();
    const timer = setTimeout(() => { if (generation === this.generation) this.status.textContent = 'Saving…'; }, 1000);
    try {
      const take = await this.save();
      if (!take || generation !== this.generation || !this.allowed || this.line?.id !== lineId) return;
      const body = { takeId: take.id };
      if (this.retakeId) body.retakeId = this.retakeId;
      const acceptedSnapshot = await this.client.request('/api/takes/' + encodeURIComponent(lineId) + '/accept', body);
      // The returned state moves only this player's queue; other players carry on.
      if (generation === this.generation) {
        this.acceptedTake = acceptedSnapshot.session?.lineTakes?.[lineId] || this.acceptedTake;
        this.retakeId = ''; this.retakeAttemptId = ''; this.retakeAttemptPending = false; this.observedCandidateId = null;
        this.clearTake(); this.mode = 'idle'; this.status.textContent = '';
        this.onAccepted?.(lineId);
      }
    } catch {
      if (generation === this.generation) this.status.textContent = 'Save failed — try again';
      throw new Error('Save failed — try again');
    } finally {
      clearTimeout(timer);
      if (generation === this.generation && this.mode === 'accepting') this.mode = this.hasTake() ? 'review' : 'idle';
      this.updateControls();
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.abort('', true);
    this.stopMicrophoneMeter(); this.cancelPendingWaits(); this.cancelMediaWaits();
    this.stream?.getTracks().forEach(track => track.stop()); this.micSource?.disconnect();
    this.audioContext?.close().catch(() => {});
    document.removeEventListener('visibilitychange', this.visibilityListener);
    window.removeEventListener('pagehide', this.pagehideListener); window.removeEventListener('online', this.onlineListener);
    this.client.removeEventListener('connection', this.reconnectListener);
  }
}
