import { node, mediaWarning } from '../shared/api.js';

// A source receives one AudioContext start command; overlapping windows naturally mix.
export function audioWindow(startTime, duration, bufferDuration, position, contextStart) {
  const offset = Math.max(0, position - startTime);
  const remaining = Math.min(duration, bufferDuration) - offset;
  if (remaining <= 0) return null;
  return { when: contextStart + Math.max(0, startTime - position), offset, duration: remaining };
}

export class DubPlayback {
  constructor(root, client, onError, { player = false } = {}) {
    this.client = client; this.onError = onError; this.player = player; this.context = null; this.buffers = new Map();
    this.sources = []; this.readyKey = null; this.preparing = false; this.runningId = null; this.suppressedId = null; this.generation = 0;
    this.playIntent = false; this.playCommand = 0; this.failedKey = null; this.reportedFailedKey = null;
    this.video = node('video'); this.video.muted = true; this.video.playsInline = true; this.video.preload = 'metadata';
    this.video.setAttribute('aria-label', 'Finished dub visuals');
    this.actions = node('div', undefined, 'actions');
    this.status = node('p', player ? '' : 'Load a pack to prepare playback.', 'recorder-status'); this.status.setAttribute('role', 'status');
    if (player) {
      this.playButton = node('button', 'PLAY', 'player-playback-toggle'); this.playButton.type = 'button';
      this.playButton.setAttribute('aria-label', 'Play the movie'); this.playButton.setAttribute('aria-pressed', 'false'); this.playButton.disabled = true;
      this.playButton.addEventListener('click', () => {
        if (this.runningId || this.playIntent) this.pausePlayer();
        else this.playPlayer().catch(() => {});
      });
      this.actions.append(this.playButton); root.append(this.video, this.actions, this.status);
      this.video.addEventListener('error', () => {
        this.videoFailed = true;
        this.suppressedId = this.session?.playback?.id; this.playIntent = false; this.stop();
        this.playerError('This movie could not play. Please try another browser.');
      });
      this.video.addEventListener('loadedmetadata', () => { this.videoFailed = false; });
      window.addEventListener('pagehide', () => { this.stop(); this.context?.close(); });
      return;
    }
    this.warning = node('p', undefined, 'notice'); this.warning.hidden = true;
    this.prepareButton = node('button', 'Prepare playback', 'secondary');
    this.resumeButton = node('button', 'Enable audio / catch up', 'secondary'); this.resumeButton.hidden = true;
    this.stopButton = node('button', 'Stop on this device', 'secondary'); this.stopButton.disabled = true;
    this.actions.append(this.prepareButton, this.resumeButton, this.stopButton); root.append(this.warning, this.video, this.actions, this.status);
    this.prepareButton.addEventListener('click', () => this.prepare().catch(onError));
    this.resumeButton.addEventListener('click', () => this.resume().catch(onError));
    this.stopButton.addEventListener('click', () => { this.suppressedId = this.session?.playback?.id; this.stop(); this.status.textContent = 'Stopped on this device. Click Enable audio / catch up to rejoin.'; this.resumeButton.hidden = !this.session?.playback; });
    this.video.addEventListener('loadedmetadata', () => { this.warning.hidden = true; });
    this.video.addEventListener('error', () => { this.warning.hidden = false; this.warning.textContent = 'Video cannot play in this browser. Ask the host to enable whole-video transcoding with --transcode-video.'; });
    window.addEventListener('pagehide', () => { this.stop(); this.context?.close(); });
  }
  key(session = this.session) {
    if (!session?.pack) return '';
    return `${session.matchId || ''}:${session.pack.id}:${Object.values(session.lineTakes).filter(t => t.status === 'accepted').map(t => t.id).sort().join(',')}`;
  }
  setState(snapshot) {
    if (this.player) { this.setPlayerState(snapshot); return; }
    const previous = this.session; this.session = snapshot.session;
    const pack = this.session.pack;
    this.prepareButton.disabled = !pack || this.preparing;
    if (previous?.matchId !== this.session.matchId || previous?.pack?.id !== pack?.id || previous?.pack?.videoUrl !== pack?.videoUrl) {
      this.stop(); this.buffers.clear(); this.readyKey = null; this.generation++;
      if (pack) { this.video.src = pack.videoUrl; mediaWarning(this.video, this.warning); }
      else { this.video.removeAttribute('src'); this.video.load(); }
    }
    if (!pack) return;
    const currentKey = this.key();
    if (this.readyKey && currentKey !== this.readyKey) { this.readyKey = null; this.status.textContent = 'Accepted takes changed. Prepare playback again to load the updated dub.'; }
    const playback = this.session.playback;
    if (!playback) {
      if (this.runningId) this.stop();
      this.resumeButton.hidden = true;
      if (this.readyKey === currentKey) this.status.textContent = 'Audio ready. Waiting for the host to start shared playback.';
      return;
    }
    if (this.runningId === playback.id || this.suppressedId === playback.id) return;
    this.suppressedId = null;
    if (this.readyKey !== currentKey || this.context?.state !== 'running') {
      this.resumeButton.hidden = false;
      this.status.textContent = 'The host started playback. Prepare audio, then enable it to catch up.';
      return;
    }
    this.start(playback).catch(this.onError);
  }
  updatePlayerControls() {
    if (!this.player) return;
    const active = !!(this.runningId || this.playIntent);
    this.playButton.textContent = active ? 'PAUSE' : 'PLAY';
    this.playButton.setAttribute('aria-label', active ? 'Pause the movie' : 'Play the movie');
    this.playButton.setAttribute('aria-pressed', String(active));
    this.playButton.disabled = !this.session?.playback;
  }
  playerError(message = 'The movie could not load. Press PLAY to try again.') {
    this.status.textContent = message;
    this.onError(new Error(message));
  }
  playerContext() {
    if (!this.context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('Playback is unavailable in this browser. Please try another browser.');
      this.context = new AudioContext();
      this.context.addEventListener('statechange', () => {
        if (this.context.state === 'running') this.startPlayerIfReady();
        else if (this.context.state === 'suspended' && this.runningId) {
          this.stop(); this.status.textContent = 'Press PLAY to continue.';
        }
      });
    }
    return this.context;
  }
  // Called directly by READY/PLAY so browser audio permission follows that gesture.
  async unlock() {
    if (!this.player) return this.audioContext();
    let context;
    try { context = this.playerContext(); } catch { throw new Error('Playback is unavailable in this browser. Please try another browser.'); }
    if (context.state === 'running') return context;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Press PLAY to hear the movie.')), 8000);
        context.resume().then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
    } catch { throw new Error('Press PLAY to hear the movie.'); }
    this.startPlayerIfReady(); return context;
  }
  setPlayerState(snapshot) {
    const previous = this.session; this.session = snapshot.session;
    const pack = this.session.pack;
    if (previous?.id !== this.session.id || previous?.matchId !== this.session.matchId || previous?.pack?.id !== pack?.id || previous?.pack?.videoUrl !== pack?.videoUrl) {
      this.playCommand++; this.playIntent = false; this.suppressedId = null; this.stop();
      this.generation++; this.buffers.clear(); this.readyKey = null; this.failedKey = null; this.reportedFailedKey = null;
      this.videoFailed = false;
      if (pack) this.video.src = pack.videoUrl;
      else { this.video.removeAttribute('src'); this.video.load(); }
    }
    this.updatePlayerControls();
    if (!pack) { this.status.textContent = ''; return; }
    if (this.readyKey !== this.key()) this.readyKey = null;
    if (!this.session.playback) {
      if (this.runningId || this.playIntent) { this.playCommand++; this.playIntent = false; this.stop(); }
      this.status.textContent = '';
    }
    if (this.failedKey === this.key()) {
      if (this.session.playback && this.reportedFailedKey !== this.failedKey) {
        this.reportedFailedKey = this.failedKey; this.playerError();
      }
      return;
    }
    // Fetch and decode quietly while players finish. Decoding does not require a
    // running context, and never starts any sound before the host's descriptor.
    this.preparePlayer().then(async () => {
      if (this.session?.pack && this.readyKey !== this.key() && this.failedKey !== this.key()) await this.preparePlayer();
      this.startPlayerIfReady();
    }).catch(() => {
      if (this.session?.playback && this.reportedFailedKey !== this.failedKey) {
        this.reportedFailedKey = this.failedKey; this.playerError();
      }
    });
    this.startPlayerIfReady();
  }
  preparePlayer() {
    if (this.playerPreparation) return this.playerPreparation;
    this.preparing = true;
    this.playerPreparation = (async () => {
      while (this.session?.pack && this.readyKey !== this.key()) {
        const session = this.session; const key = this.key(); const generation = this.generation;
        let context;
        try { context = this.playerContext(); } catch (error) { this.failedKey = key; throw error; }
        const assets = [{ key: `backing:${session.pack.id}`, url: session.pack.backingTrackUrl },
          ...Object.values(session.lineTakes).filter(take => take.status === 'accepted').map(take => ({ key: take.id, url: take.url }))];
        let cursor = 0;
        try {
          const worker = async () => {
            while (cursor < assets.length && generation === this.generation) {
              const asset = assets[cursor++];
              if (this.buffers.has(asset.key)) continue;
              const response = await fetch(asset.url, { credentials: 'same-origin' });
              if (!response.ok) throw new Error('Playback audio is unavailable');
              const buffer = await context.decodeAudioData(await response.arrayBuffer());
              if (generation === this.generation) this.buffers.set(asset.key, buffer);
            }
          };
          await Promise.all(Array.from({ length: Math.min(4, assets.length) }, worker));
        } catch (error) {
          if (generation !== this.generation || key !== this.key()) continue;
          this.failedKey = key; throw error;
        }
        if (generation !== this.generation || key !== this.key()) continue;
        this.readyKey = key; this.failedKey = null;
      }
    })().finally(() => { this.preparing = false; this.playerPreparation = null; });
    return this.playerPreparation;
  }
  startPlayerIfReady() {
    const playback = this.session?.playback;
    if (!playback || this.runningId === playback.id || this.suppressedId === playback.id) return;
    if (this.videoFailed) { this.status.textContent = 'This movie could not play. Please try another browser.'; return; }
    if (this.readyKey !== this.key()) {
      if (this.failedKey !== this.key()) this.status.textContent = 'Loading…';
      return;
    }
    if (this.context?.state !== 'running') { this.status.textContent = 'Press PLAY to watch.'; return; }
    this.start(playback).catch(() => this.playerError());
  }
  pausePlayer() {
    this.playCommand++; this.playIntent = false; this.suppressedId = this.session?.playback?.id;
    this.stop(); this.status.textContent = 'Paused.';
  }
  async playPlayer() {
    if (!this.session?.playback) return;
    const command = ++this.playCommand;
    this.playIntent = true; this.suppressedId = null; this.failedKey = null; this.reportedFailedKey = null;
    this.updatePlayerControls(); this.status.textContent = 'Loading…';
    try {
      // Resume immediately, before any fetch, to preserve the click's activation.
      await Promise.all([this.unlock(), this.preparePlayer()]);
      if (command !== this.playCommand) return;
      this.playIntent = false; this.startPlayerIfReady(); this.updatePlayerControls();
    } catch {
      if (command !== this.playCommand) return;
      this.playIntent = false; this.suppressedId = this.session?.playback?.id; this.stop(); this.playerError();
    }
  }
  async audioContext() {
    if (this.player) return this.unlock();
    if (!this.context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('This browser does not support Web Audio playback.');
      this.context = new AudioContext();
      this.context.addEventListener('statechange', () => {
        if (this.context.state === 'suspended' && this.session?.playback) { this.resumeButton.hidden = false; this.status.textContent = 'Audio paused by the browser. Enable audio to catch up.'; }
      });
    }
    this.status.textContent = 'Enabling browser audio… Allow audio playback if your browser asks.';
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Browser audio did not start. Click Enable audio / catch up directly, and allow audio playback in your browser.')), 8000);
        this.context.resume().then(() => { clearTimeout(timeout); resolve(); }, error => { clearTimeout(timeout); reject(error); });
      });
    } catch (error) {
      this.resumeButton.hidden = false;
      this.status.textContent = 'Browser audio is blocked. Click Enable audio / catch up and allow audio playback.';
      throw error;
    }
    return this.context;
  }
  async prepare() {
    if (this.player) return this.preparePlayer();
    if (!this.session?.pack || this.preparing) return;
    const context = await this.audioContext(); const session = this.session; const key = this.key();
    const generation = ++this.generation; this.preparing = true; this.prepareButton.disabled = true;
    this.status.textContent = 'Loading backing track and accepted voice takes…';
    const assets = [{ key: `backing:${session.pack.id}`, url: session.pack.backingTrackUrl },
      ...Object.values(session.lineTakes).filter(t => t.status === 'accepted').map(t => ({ key: t.id, url: t.url }))];
    let done = 0;
    try {
      let cursor = 0;
      const worker = async () => {
        while (cursor < assets.length && generation === this.generation) {
          const asset = assets[cursor++];
          if (!this.buffers.has(asset.key)) {
            const response = await fetch(asset.url, { credentials: 'same-origin' });
            if (!response.ok) throw new Error(`Could not load playback audio (${response.status}).`);
            const bytes = await response.arrayBuffer();
            let buffer;
            try { buffer = await context.decodeAudioData(bytes); }
            catch { throw new Error('A recorded take or backing track could not decode in this browser. Try the browser used to record those takes. Reference audio is never substituted.'); }
            if (generation === this.generation) this.buffers.set(asset.key, buffer);
          }
          done++; if (generation === this.generation) this.status.textContent = `Prepared ${done} / ${assets.length} audio files…`;
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, assets.length) }, worker));
      if (generation !== this.generation || this.key() !== key) { this.status.textContent = 'Takes changed while preparing. Prepare playback again.'; return; }
      this.readyKey = key; this.status.textContent = 'Audio ready. Waiting for the host to start shared playback.';
      if (this.session.playback) await this.start(this.session.playback);
    } catch (error) {
      this.generation++; this.readyKey = null; this.status.textContent = 'Audio preparation failed. Fix the error, then prepare again.'; throw error;
    } finally { this.preparing = false; this.prepareButton.disabled = !this.session?.pack; }
  }
  async resume() {
    if (this.player) return this.playPlayer();
    this.suppressedId = null;
    await this.audioContext();
    if (this.readyKey !== this.key()) return this.prepare();
    if (this.session?.playback) { this.stop(); await this.start(this.session.playback); }
    else this.status.textContent = 'Audio ready. Waiting for the host.';
  }
  async start(playback) {
    if (this.runningId === playback.id) return;
    this.stop(); const context = this.context; const session = this.session;
    if (!context || context.state !== 'running' || this.readyKey !== this.key()) return;
    const now = this.client.serverNow();
    const position = Math.max(0, (now - playback.startsAt) / 1000);
    const contextStart = context.currentTime + Math.max(0, (playback.startsAt - now) / 1000);
    const anchor = contextStart - position;
    const backing = this.buffers.get(`backing:${session.pack.id}`);
    this.schedule(backing, audioWindow(0, backing.duration, backing.duration, position, contextStart));
    for (const line of session.pack.lines) {
      const take = session.lineTakes[line.id]; if (take?.status !== 'accepted') continue;
      const buffer = this.buffers.get(take.id); if (!buffer) continue;
      this.schedule(buffer, audioWindow(line.startTime, line.duration, buffer.duration, position, contextStart));
    }
    this.runningId = playback.id;
    if (this.player) this.updatePlayerControls();
    else { this.stopButton.disabled = false; this.resumeButton.hidden = true; }
    const finish = Math.max(backing.duration, Number.isFinite(this.video.duration) ? this.video.duration : 0, ...session.pack.lines.map(line => line.endTime));
    let visualStarted = false;
    const step = () => {
      if (this.runningId !== playback.id) return;
      const timeline = context.currentTime - anchor;
      if (timeline >= Math.max(finish, Number.isFinite(this.video.duration) ? this.video.duration : 0)) { this.suppressedId = playback.id; this.playIntent = false; this.stop(); this.status.textContent = this.player ? 'Movie finished.' : 'Playback finished.'; return; }
      if (timeline < 0) this.status.textContent = this.player ? 'Starting soon…' : `Shared playback starts in ${Math.ceil(-timeline)} seconds…`;
      else {
        this.status.textContent = this.player ? '' : 'Playing the completed dub.';
        if (this.video.readyState >= 1) {
          if (Math.abs(this.video.currentTime - timeline) > 0.18) this.video.currentTime = Math.min(timeline, Math.max(0, this.video.duration - 0.01));
          if (!visualStarted) {
            visualStarted = true;
            this.video.play().catch(() => {
              if (this.player) { this.playIntent = false; this.suppressedId = playback.id; this.stop(); this.status.textContent = 'Press PLAY to watch.'; }
              else { this.resumeButton.hidden = false; this.status.textContent = 'Click Enable audio / catch up to start video playback.'; }
            });
          }
        }
      }
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }
  schedule(buffer, window) {
    if (!window) return;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    source.start(window.when, window.offset, window.duration); this.sources.push(source);
  }
  stop() {
    cancelAnimationFrame(this.frame); this.sources.forEach(source => { try { source.stop(); } catch {} source.disconnect(); });
    this.sources = []; this.runningId = null; this.video.pause();
    if (this.player) this.updatePlayerControls(); else this.stopButton.disabled = true;
  }
}
