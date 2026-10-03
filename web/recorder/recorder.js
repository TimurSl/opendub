export function chooseRecordingMime(Recorder = globalThis.MediaRecorder) {
  return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']
    .find(type => Recorder?.isTypeSupported(type)) || '';
}

const activeCapture = mode => ['requesting', 'countdown', 'recording'].includes(mode);
const staleSave = error => /Line changed|Room changed|another player|not recording|requires a host retake|Take changed/i.test(error?.message || '');

export class LineRecorder {
  constructor(client, onError) {
    this.client = client; this.onError = onError; this.stream = null; this.line = null;
    this.packId = null; this.mode = 'idle'; this.generation = 0; this.mediaGeneration = 0;
    this.blob = null; this.objectUrl = null; this.savedTake = null; this.savedBlob = null;
    this.observedCandidateId = null; this.dismissedTakeId = null; this.backup = null;
    this.saveJob = null; this.saveTail = Promise.resolve(); this.destroyed = false;
    this.video = document.getElementById('line-video');
    this.reference = document.getElementById('reference-audio');
    this.review = document.getElementById('take-review');
    this.status = document.getElementById('recorder-status');
    this.waveform = document.getElementById('recording-waveform');
    this.progress = document.getElementById('recording-progress');
    this.countdown = document.getElementById('countdown');
    this.buttons = Object.fromEntries(['original', 'record', 'my-take', 'next'].map(id => [id, document.getElementById(id)]));
    this.effects = document.getElementById('effect-row'); this.currentEffect = 'normal';
    this.mediaAnalyserNodes = new Map(); this.activeAnalyser = null;
    this.buttons.original.addEventListener('click', () => this.playOriginal().catch(() => this.mediaError()));
    this.buttons['my-take'].addEventListener('click', () => this.playTake().catch(() => this.mediaError()));
    this.buttons.record.addEventListener('click', () => {
      if (this.mode === 'countdown') this.cancelRecording();
      else if (this.mode === 'recording') this.stopRecording();
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
  friendly(message) { this.status.textContent = message; this.onError?.(new Error(message)); }
  mediaError() {
    if (activeCapture(this.mode)) this.cancelRecording();
    else this.stopMedia();
    this.friendly('Video unavailable — ask host');
  }
  hasTake() { return !!(this.blob || this.savedTake); }
  currentSave() { return this.saveJob?.generation === this.generation ? this.saveJob : null; }
  updateControls() {
    const capturing = activeCapture(this.mode); const accepting = this.mode === 'accepting';
    const set = (button, icon, label, description, pressed = false) => {
      button.querySelector('.control-icon').textContent = icon;
      button.querySelector('.control-label').textContent = label;
      button.setAttribute('aria-label', description);
      button.setAttribute('aria-pressed', String(pressed));
    };
    const originalActive = this.mode === 'original'; const takeActive = this.mode === 'my-take';
    const recordingActive = ['countdown', 'recording'].includes(this.mode);
    set(this.buttons.original, originalActive ? '■' : '♫', originalActive ? 'Stop' : 'Original', originalActive ? 'Stop original playback' : 'Play original line', originalActive);
    set(this.buttons.record, recordingActive ? '■' : '●', recordingActive ? 'Stop' : 'Record', recordingActive ? 'Stop recording' : 'Record your line', this.mode === 'recording');
    set(this.buttons['my-take'], takeActive ? '■' : '↻', takeActive ? 'Stop' : 'My take', takeActive ? 'Stop your take' : 'Play your take', takeActive);
    set(this.buttons.next, '➜', 'Next', 'Save take and continue');
    this.buttons.original.disabled = !this.line || capturing || accepting || this.settings?.referencePlaybackEnabled === false;
    this.buttons['my-take'].disabled = !this.line || !this.hasTake() || capturing || accepting;
    this.buttons.next.disabled = !this.line || !this.allowed || !this.hasTake() || capturing || accepting;
    this.buttons.record.disabled = !this.line || !this.allowed || accepting || this.mode === 'requesting';
    if (this.effects) {
      const enabled = this.settings?.voiceEffectsEnabled !== false;
      for (const button of this.effects.querySelectorAll('[data-effect]')) button.disabled = !enabled || capturing;
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
    if (!['normal', 'echo', 'phone', 'robot'].includes(effect) || activeCapture(this.mode)) return;
    this.currentEffect = this.settings?.voiceEffectsEnabled === false ? 'normal' : effect;
    if (this.micSource && this.audioContext) this.buildMicGraph();
    this.updateControls();
  }
  buildMicGraph() {
    if (!this.audioContext || !this.micSource) return;
    const context = this.audioContext;
    this.micSource.disconnect();
    for (const node of this.effectNodes || []) { try { node.disconnect(); } catch {} }
    if (this.robotOscillator) { try { this.robotOscillator.stop(); } catch {} this.robotOscillator = null; }
    this.effectNodes = [];
    const analyser = context.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.76;
    const destination = this.captureDestination ??= context.createMediaStreamDestination();
    let output = this.micSource;
    const keep = node => { this.effectNodes.push(node); return node; };
    if (this.currentEffect === 'phone') {
      const high = keep(context.createBiquadFilter()); high.type = 'highpass'; high.frequency.value = 430;
      const low = keep(context.createBiquadFilter()); low.type = 'lowpass'; low.frequency.value = 3200;
      output.connect(high); high.connect(low); output = low;
    } else if (this.currentEffect === 'robot') {
      const modulated = keep(context.createGain()); modulated.gain.value = 0.62;
      const oscillator = context.createOscillator(); oscillator.type = 'square'; oscillator.frequency.value = 28;
      const depth = keep(context.createGain()); depth.gain.value = 0.3;
      oscillator.connect(depth); depth.connect(modulated.gain); oscillator.start(); this.robotOscillator = oscillator;
      output.connect(modulated); output = modulated;
    } else if (this.currentEffect === 'echo') {
      const dry = keep(context.createGain()); dry.gain.value = 0.78;
      const delay = keep(context.createDelay(0.6)); delay.delayTime.value = 0.22;
      const feedback = keep(context.createGain()); feedback.gain.value = 0.24;
      const wet = keep(context.createGain()); wet.gain.value = 0.48;
      const mix = keep(context.createGain());
      output.connect(dry); output.connect(delay); delay.connect(feedback); feedback.connect(delay); delay.connect(wet);
      dry.connect(mix); wet.connect(mix); output = mix;
    }
    output.connect(analyser); analyser.connect(destination);
    this.captureAnalyser = analyser; this.analyser = analyser; this.activeAnalyser = analyser;
    this.waveFrequencyData = new Uint8Array(analyser.frequencyBinCount);
  }
  async enableMicrophone() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) throw new Error('Microphone access required');
    if (this.stream?.getAudioTracks().some(track => track.readyState === 'live')) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (this.destroyed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
        if (this.destroyed || this.stream !== stream) return;
        if (activeCapture(this.mode)) this.cancelRecording();
        this.friendly('Microphone access required'); this.updateControls();
      }));
      this.micSource?.disconnect();
      const context = this.ensureAudioContext();
      if (context) {
        try {
          this.micSource = context.createMediaStreamSource(stream);
          context.resume().catch(() => {});
          this.buildMicGraph();
        } catch { this.analyser = null; this.captureDestination = null; }
      }
    } catch { throw new Error('Microphone access required'); }
    this.updateControls();
  }
  setLine(pack, line, allowed, settings) {
    const changed = this.packId !== pack?.id || this.line?.id !== line?.id;
    if (changed) {
      this.abort('', true);
      this.dismissedTakeId = null; this.observedCandidateId = null; this.drawWaveform(true);
    } else if (!allowed && this.allowed && (activeCapture(this.mode) || this.currentSave() || this.mode === 'accepting')) {
      this.abort('', true);
    }
    this.allowed = allowed; this.settings = settings; this.line = line; this.packId = pack?.id;
    if (settings?.voiceEffectsEnabled === false && this.currentEffect !== 'normal') this.setEffect('normal');
    if (pack && this.video.getAttribute('src') !== pack.videoUrl) {
      this.stopMedia(); this.video.src = pack.videoUrl; this.video.muted = true;
    }
    this.updateControls();
  }
  setCandidate(take) {
    const owned = take?.status === 'recorded' && take.playerId === this.client.state?.viewer.playerId;
    if (!owned) {
      if (this.observedCandidateId) {
        this.observedCandidateId = null;
        this.abort('', true);
        this.status.textContent = 'Record a new take';
      }
      return;
    }
    this.observedCandidateId = take.id;
    if (activeCapture(this.mode) || take.id === this.dismissedTakeId) return;
    // A local replacement remains authoritative until its own upload completes.
    if (this.blob) return;
    if (this.savedTake?.id !== take.id) {
      this.savedTake = take; this.savedBlob = null;
      this.review.src = take.url; this.mode = 'review'; this.status.textContent = 'Take ready';
    }
    this.updateControls();
  }
  async waitMedia(element, name, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); element.removeEventListener(name, done); element.removeEventListener('error', fail); };
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('Video unavailable — ask host')); };
      const timer = setTimeout(fail, timeout);
      element.addEventListener(name, done, { once: true }); element.addEventListener('error', fail, { once: true });
    });
  }
  async seek(time) {
    if (this.video.readyState < 1) await this.waitMedia(this.video, 'loadedmetadata');
    this.video.pause();
    if (Math.abs(this.video.currentTime - time) > 0.015) {
      const sought = this.waitMedia(this.video, 'seeked');
      this.video.currentTime = time; await sought;
    }
  }
  stopMedia() {
    this.mediaGeneration++; cancelAnimationFrame(this.frame);
    if (this.startListener) { this.video.removeEventListener('playing', this.startListener); this.startListener = null; }
    this.video.pause(); this.reference.pause(); this.review.pause(); this.video.muted = true;
    if (['original', 'my-take'].includes(this.mode)) this.mode = this.hasTake() ? 'review' : 'idle';
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
    const fragmentStart = padded ? Math.max(0, line.startTime - (this.settings?.previewBefore ?? 1.5)) : line.startTime;
    const fragmentEnd = padded ? line.endTime + (this.settings?.previewAfter ?? 0.5) : line.endTime;
    await this.seek(fragmentStart);
    if (generation !== this.generation || mediaGeneration !== this.mediaGeneration) return;
    if (audio) {
      audio.load();
      if (audio.readyState < 2) await this.waitMedia(audio, 'loadeddata');
      audio.currentTime = 0;
    }
    if (generation !== this.generation || mediaGeneration !== this.mediaGeneration) return;
    this.video.muted = !fallback;
    this.status.textContent = mode === 'original' ? 'Original' : 'My take';
    let voiceStarted = false;
    const startAudio = () => {
      if (!audio || voiceStarted || this.video.currentTime < line.startTime - 0.005 || generation !== this.generation || mediaGeneration !== this.mediaGeneration) return;
      voiceStarted = true;
      audio.play().catch(() => { this.stopMedia(); this.friendly('Video unavailable — ask host'); });
    };
    this.startListener = startAudio;
    this.video.addEventListener('playing', startAudio, { once: true });
    try { await this.video.play(); } catch (error) { this.stopMedia(); throw error; }
    const step = () => {
      if (generation !== this.generation || mediaGeneration !== this.mediaGeneration) return;
      // Voice playback supplies the fragment timeline when an audio take exists.
      if (audio && !voiceStarted && this.video.currentTime >= line.startTime) startAudio();
      if (audio && voiceStarted && !audio.paused && !audio.ended && this.video.currentTime < line.endTime) {
        const desired = line.startTime + audio.currentTime;
        if (Math.abs(this.video.currentTime - desired) > 0.15) this.video.currentTime = Math.min(desired, line.endTime);
      }
      if (audio && this.video.currentTime >= line.endTime) audio.pause();
      if (this.video.currentTime >= fragmentEnd || this.video.ended) {
        this.stopMedia(); this.status.textContent = this.hasTake() ? 'Take ready' : ''; this.updateControls(); return;
      }
      if (!this.reducedMotion) this.drawWaveform(true);
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step); this.updateControls();
  }
  async playOriginal() {
    if (!this.line) return;
    if (this.settings?.referencePlaybackEnabled === false) return;
    if (this.mode === 'original') { this.stopMedia(); this.status.textContent = this.hasTake() ? 'Take ready' : ''; return; }
    if (this.line.referenceAudio) {
      this.reference.src = this.line.referenceAudio;
      await this.playFragment(this.reference, 'original', false, true);
    } else await this.playFragment(null, 'original', true, true);
  }
  async playTake() {
    if (!this.hasTake()) return;
    if (this.mode === 'my-take') { this.stopMedia(); this.status.textContent = 'Take ready'; return; }
    this.review.src = this.objectUrl || this.savedTake.url;
    await this.playFragment(this.review, 'my-take');
  }
  pauseCapture() {
    if (this.mode === 'recording') this.stopRecording();
    else if (['requesting', 'countdown'].includes(this.mode)) this.cancelRecording();
    else if (['original', 'my-take'].includes(this.mode)) this.stopMedia();
  }
  captureBackup() {
    return { blob: this.blob, objectUrl: this.objectUrl, savedTake: this.savedTake, savedBlob: this.savedBlob, dismissedTakeId: this.dismissedTakeId };
  }
  releaseBackup() {
    if (this.backup?.objectUrl && this.backup.objectUrl !== this.objectUrl) URL.revokeObjectURL(this.backup.objectUrl);
    this.backup = null;
  }
  async record() {
    if (!this.line || !this.allowed || activeCapture(this.mode) || this.mode === 'accepting') return;
    this.audioContext?.resume().catch(() => {});
    this.stopMedia(); const generation = ++this.generation; const line = this.line;
    this.backup = this.captureBackup();
    this.mode = 'requesting'; this.updateControls();
    await this.enableMicrophone();
    if (generation !== this.generation || !this.allowed) return;
    this.mode = 'countdown'; this.status.textContent = ''; this.updateControls();
    await this.seek(line.startTime);
    for (let count = 3; count > 0; count--) {
      if (generation !== this.generation) return;
      this.countdown.textContent = String(count); this.countdown.hidden = false;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (generation !== this.generation) return;
    this.countdown.hidden = true;
    const mimeType = chooseRecordingMime(); const chunks = [];
    const recorder = new MediaRecorder(this.captureDestination?.stream || this.stream, mimeType ? { mimeType } : undefined);
    this.recorder = recorder;
    recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener('error', () => {
      if (generation === this.generation) { this.cancelRecording(); this.friendly('Recording failed — try again'); }
    });
    recorder.addEventListener('stop', () => {
      if (generation !== this.generation) return;
      this.stopMedia(); clearTimeout(this.recordingWatchdog);
      if (this.progress) this.progress.hidden = true;
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      if (!blob.size) { this.cancelRecording(); this.friendly('Recording failed — try again'); return; }
      this.blob = blob; this.objectUrl = URL.createObjectURL(blob); this.savedTake = null; this.savedBlob = null;
      this.releaseBackup(); this.review.src = this.objectUrl;
      this.mode = 'review'; this.status.textContent = 'Take ready'; this.updateControls();
      this.save().catch(() => {});
    }, { once: true });
    const start = () => {
      this.startListener = null;
      if (generation !== this.generation || recorder.state !== 'inactive') return;
      this.dismissedTakeId = this.backup?.savedTake?.id ?? this.observedCandidateId;
      this.blob = null; this.objectUrl = null; this.savedTake = null; this.savedBlob = null;
      recorder.start();
      this.recordingWatchdog = setTimeout(() => {
        if (generation === this.generation && recorder.state === 'recording') { this.cancelRecording(); this.friendly('Recording failed — try again'); }
      }, (line.duration + 2) * 1000);
      this.mode = 'recording'; this.status.textContent = 'Recording'; this.waveform.hidden = false;
      if (this.progress) { this.progress.max = line.duration; this.progress.value = 0; this.progress.hidden = false; }
      this.updateControls();
      this.drawWaveform(true);
      let previousTime = this.video.currentTime; let lastAdvance = performance.now(); let lastSemantic = 0;
      const step = () => {
        if (generation !== this.generation || recorder.state !== 'recording') return;
        const now = performance.now();
        if (this.video.currentTime > previousTime + 0.001) { previousTime = this.video.currentTime; lastAdvance = now; }
        if (this.video.ended && this.video.currentTime < line.endTime - 0.05 || now - lastAdvance > 1500) {
          this.cancelRecording(); this.friendly('Recording failed — try again'); return;
        }
        if (this.video.currentTime >= line.endTime || this.video.ended) { this.stopRecording(); return; }
        if (!this.reducedMotion) this.drawWaveform(true);
        if (now - lastSemantic > 250) {
          if (this.progress) this.progress.value = Math.max(0, Math.min(line.duration, this.video.currentTime - line.startTime));
          lastSemantic = now;
        }
        this.frame = requestAnimationFrame(step);
      };
      this.frame = requestAnimationFrame(step);
    };
    this.startListener = start;
    this.video.muted = true; this.video.addEventListener('playing', start, { once: true });
    try { await this.video.play(); } catch (error) { this.video.removeEventListener('playing', start); throw error; }
  }
  drawWaveform(active = false) {
    if (!this.waveform) return;
    const bounds = this.waveform.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(bounds.width * pixelRatio); const pixelHeight = Math.round(bounds.height * pixelRatio);
    if (this.waveform.width !== pixelWidth || this.waveform.height !== pixelHeight) {
      this.waveform.width = pixelWidth; this.waveform.height = pixelHeight;
    }
    const context = this.waveform.getContext('2d'); if (!context) return;
    const width = bounds.width; const height = bounds.height;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0); context.clearRect(0, 0, width, height);
    const recording = this.mode === 'recording'; const playing = ['original', 'my-take'].includes(this.mode);
    const analyser = recording ? this.captureAnalyser : playing ? this.activeAnalyser : null;
    const data = analyser ? (this.waveFrequencyData ??= new Uint8Array(analyser.frequencyBinCount)) : null;
    if (analyser && data) analyser.getByteFrequencyData(data);
    const count = Math.max(32, Math.min(168, Math.floor(width / 7)));
    const gap = 3; const barWidth = Math.max(2, (width - gap * (count - 1)) / count);
    const maximum = height * 0.43; const center = height / 2;
    const glow = !this.reducedMotion && (active || recording || playing);
    const gradient = context.createLinearGradient(0, center - maximum, 0, center + maximum);
    gradient.addColorStop(0, '#a78bfa'); gradient.addColorStop(.48, '#78e3d0'); gradient.addColorStop(1, '#ff76a1');
    context.fillStyle = gradient; context.shadowColor = '#a877ff'; context.shadowBlur = glow ? 10 : 0;
    const phase = this.reducedMotion ? 0 : performance.now() * .004;
    let seed = 0; for (const char of String(this.line?.id || 'open-dub')) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
    for (let index = 0; index < count; index++) {
      let strength;
      if (data?.length) {
        const sample = data[Math.min(data.length - 1, Math.floor(index / count * data.length))] / 255;
        strength = Math.max(.035, Math.pow(sample, .8));
      } else {
        const curve = Math.abs(Math.sin((index + (seed % 19)) * .73));
        const pulse = Math.abs(Math.sin(index * .19 - phase));
        strength = recording || playing || active ? .12 + curve * (.28 + pulse * .56) : .07 + curve * .2;
      }
      const barHeight = Math.max(4, strength * maximum * 1.9);
      const x = index * (barWidth + gap); const y = center - barHeight / 2;
      if (context.roundRect) { context.beginPath(); context.roundRect(x, y, barWidth, barHeight, Math.min(4, barWidth / 2)); context.fill(); }
      else context.fillRect(x, y, barWidth, barHeight);
    }
    context.shadowBlur = 0;
  }
  stopRecording() {
    if (this.mode !== 'recording' || this.recorder?.state !== 'recording') return;
    this.video.pause(); cancelAnimationFrame(this.frame); clearTimeout(this.recordingWatchdog);
    this.recorder.stop();
  }
  cancelRecording(message = '', discard = false) {
    this.generation++; this.stopMedia(); clearTimeout(this.recordingWatchdog);
    this.countdown.hidden = true; this.waveform.hidden = false;
    if (this.progress) this.progress.hidden = true;
    if (this.recorder?.state === 'recording') { try { this.recorder.stop(); } catch {} }
    if (!discard && this.backup) {
      if (this.objectUrl && this.objectUrl !== this.backup.objectUrl) URL.revokeObjectURL(this.objectUrl);
      Object.assign(this, this.backup); this.backup = null;
      if (this.objectUrl || this.savedTake) this.review.src = this.objectUrl || this.savedTake.url;
    } else if (discard) {
      this.clearTake(); this.releaseBackup();
    }
    this.mode = this.hasTake() ? 'review' : 'idle';
    this.status.textContent = message || (this.hasTake() ? 'Take ready' : '');
    this.updateControls();
  }
  clearTake() {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.blob = null; this.objectUrl = null; this.savedTake = null; this.savedBlob = null;
    this.review.pause(); this.review.removeAttribute('src');
  }
  abort(message = '', discard = false) { this.cancelRecording(message, discard); }
  save() {
    if (!this.blob) return Promise.resolve(this.savedTake);
    if (this.savedTake && this.savedBlob === this.blob) return Promise.resolve(this.savedTake);
    if (this.currentSave()) return this.currentSave().promise;
    if (!this.line || !this.allowed || this.destroyed) return Promise.resolve(null);
    const generation = this.generation; const blob = this.blob; const lineId = this.line.id;
    const job = { generation, promise: null };
    this.saveJob = job;
    job.promise = this.saveTail.catch(() => {}).then(async () => {
      if (generation !== this.generation || !this.allowed || this.blob !== blob) return null;
      const timer = setTimeout(() => {
        if (generation === this.generation && this.saveJob === job && !activeCapture(this.mode) && this.mode !== 'accepting') this.status.textContent = 'Saving…';
      }, 1000);
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (generation !== this.generation || !this.allowed || this.blob !== blob) return null;
          try {
            const body = new FormData();
            body.append('take', blob, 'voice.' + (blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'));
            const snapshot = await this.client.request('/api/takes/' + encodeURIComponent(lineId), body, { multipart: true });
            if (generation !== this.generation || !this.allowed || this.blob !== blob) return null;
            const take = snapshot.session.lineTakes[lineId];
            if (!take || take.status !== 'recorded' || take.playerId !== this.client.state?.viewer.playerId) return null;
            this.savedTake = take; this.savedBlob = blob; this.observedCandidateId = take.id;
            if (!['original', 'my-take', 'accepting'].includes(this.mode)) this.status.textContent = 'Take ready';
            return take;
          } catch (error) {
            if (generation !== this.generation || !this.allowed || this.blob !== blob) return null;
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
      await this.client.request('/api/takes/' + encodeURIComponent(lineId) + '/accept', { takeId: take.id });
      // The returned state moves only this player's queue; other players carry on.
      if (generation === this.generation) { this.clearTake(); this.mode = 'idle'; this.status.textContent = ''; }
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
    this.stream?.getTracks().forEach(track => track.stop()); this.micSource?.disconnect();
    this.audioContext?.close().catch(() => {});
    document.removeEventListener('visibilitychange', this.visibilityListener);
    window.removeEventListener('pagehide', this.pagehideListener); window.removeEventListener('online', this.onlineListener);
    this.client.removeEventListener('connection', this.reconnectListener);
  }
}
