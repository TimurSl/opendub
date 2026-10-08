import test from 'node:test';
import assert from 'node:assert/strict';
import { LineRecorder } from '../web/recorder/recorder.js';

class Element extends EventTarget {
  constructor() {
    super(); this.attributes = new Map(); this.src = ''; this.readyState = 4; this.hidden = false;
    this.paused = true; this.ended = false; this._time = 0; this.width = 680; this.height = 58;
    this.playCount = 0; this.duration = 30; this.textContent = '';
  }
  set currentTime(value) { this._time = value; queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
  get currentTime() { return this._time; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return name === 'src' ? this.src : this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  pause() { this.paused = true; }
  load() {}
  play() { this.paused = false; this.playCount++; queueMicrotask(() => this.dispatchEvent(new Event('playing'))); return Promise.resolve(); }
  getBoundingClientRect() { return { width: 680, height: 58 }; }
  getContext() {
    return this.context ??= {
      strokes: [], setTransform() {}, clearRect() {}, beginPath() { this.path = []; },
      moveTo(x, y) { this.path.push([x, y]); }, lineTo(x, y) { this.path.push([x, y]); },
      stroke() { this.strokes.push({ color: this.strokeStyle, path: [...this.path] }); },
      roundRect() {}, fill() {}, fillRect() {},
    };
  }
  querySelectorAll() { return this.effectButtons || []; }
}
const line = { id: 'own-line', character: 'Actor', startTime: 10, endTime: 12, duration: 2, referenceAudio: '/reference' };
const pack = { id: 'pack', videoUrl: '/video' };
const candidate = id => ({ id, playerId: 'player', status: 'recorded', url: '/takes/' + id });
const snapshot = take => ({ session: { lineTakes: { [line.id]: take } } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, handle, storage) {
  const originals = Object.fromEntries(['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const elements = new Map(); const frames = new Map(); let frameId = 0;
  const document = new EventTarget(); document.hidden = false;
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.getElementById('effect-row').effectButtons = ['normal', 'echo', 'phone', 'robot', 'autoTune'].map(effect => {
    const button = new Element(); button.setAttribute('data-effect', effect); return button;
  });
  const window = new EventTarget(); window.matchMedia = () => ({ matches: false }); window.isSecureContext = true;
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { value: callback => { frames.set(++frameId, callback); return frameId; }, configurable: true });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: id => frames.delete(id), configurable: true });
  if (storage !== undefined) Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  const calls = []; const client = new EventTarget(); client.state = { viewer: { playerId: 'player' } };
  client.request = async (path, body, options) => {
    calls.push({ path, body, options });
    return handle ? handle(path, body, options, calls.length) : {};
  };
  client.state.session = { matchId: 'fixture-match', pack };
  const recorder = new LineRecorder(client, () => {});
  recorder.setLine(pack, line, true, { previewBefore: 1.5, previewAfter: 0.5 });
  t.after(() => {
    recorder.destroy();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  function localTake(text = 'microphone') {
    recorder.blob = new Blob([text], { type: 'audio/webm' });
    recorder.objectUrl = URL.createObjectURL(recorder.blob);
    return recorder.blob;
  }
  function frame() {
    const entry = [...frames.entries()].at(-1);
    if (entry) { frames.delete(entry[0]); entry[1](); }
  }
  return { recorder, calls, localTake, elements, frame };
}

test('NEXT waits for the automatic save and accepts only its returned take', async t => {
  const upload = deferred();
  const { recorder, calls, localTake } = fixture(t, path => path.endsWith('/accept') ? {} : upload.promise);
  localTake();
  const saving = recorder.save(); const advancing = recorder.next();
  await turn();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body instanceof FormData);
  assert.equal(calls[0].path, '/api/takes/own-line');
  upload.resolve(snapshot(candidate('saved')));
  await Promise.all([saving, advancing]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/api/takes/own-line/accept');
  assert.deepEqual(calls[1].body, { takeId: 'saved' });
  assert.equal(recorder.hasTake(), false);
});

test('a queued replacement waits for the older save and NEXT accepts the replacement', async t => {
  const first = deferred(); const second = deferred(); let uploadCount = 0;
  const { recorder, calls, localTake } = fixture(t, path => {
    if (path.endsWith('/accept')) return {};
    return ++uploadCount === 1 ? first.promise : second.promise;
  });
  localTake('old'); const oldSave = recorder.save(); await turn();
  URL.revokeObjectURL(recorder.objectUrl);
  recorder.generation++; localTake('new');
  const newSave = recorder.save(); const advancing = recorder.next();
  first.resolve(snapshot(candidate('old'))); await turn();
  assert.equal(calls.length, 2);
  assert.equal(recorder.savedTake, null);
  second.resolve(snapshot(candidate('new')));
  await Promise.all([oldSave, newSave, advancing]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].body, { takeId: 'new' });
});

test('host removal invalidates a known candidate and prevents stale NEXT acceptance', async t => {
  const upload = deferred();
  const { recorder, calls, localTake } = fixture(t, () => upload.promise);
  recorder.setCandidate(candidate('previous'));
  localTake('replacement');
  const saving = recorder.save(); const advancing = recorder.next(); await turn();
  recorder.setCandidate(undefined);
  assert.equal(recorder.hasTake(), false);
  upload.resolve(snapshot(candidate('late')));
  await Promise.all([saving, advancing]);
  assert.equal(calls.length, 1);
  assert.equal(recorder.savedTake, null);
});

test('an absent candidate during the first save preserves the local take', async t => {
  const upload = deferred();
  const { recorder, localTake } = fixture(t, () => upload.promise);
  const blob = localTake(); const saving = recorder.save(); await turn();
  recorder.setCandidate(undefined);
  assert.equal(recorder.blob, blob);
  upload.resolve(snapshot(candidate('first')));
  await saving;
  assert.equal(recorder.savedTake.id, 'first');
});

test('changing personal lines invalidates an in-flight save and NEXT', async t => {
  const upload = deferred();
  const { recorder, calls, localTake } = fixture(t, () => upload.promise);
  localTake(); const advancing = recorder.next(); await turn();
  recorder.setLine(pack, { ...line, id: 'next-owned-line' }, true, {});
  upload.resolve(snapshot(candidate('late')));
  await advancing;
  assert.equal(calls.length, 1);
  assert.equal(recorder.line.id, 'next-owned-line');
  assert.equal(recorder.hasTake(), false);
});

test('cancelled replacement countdown and failed replacement restore the previous take', t => {
  const { recorder, localTake } = fixture(t);
  const blob = localTake(); const url = recorder.objectUrl;
  recorder.savedTake = candidate('previous'); recorder.savedBlob = blob;
  recorder.backup = recorder.captureBackup(); recorder.mode = 'countdown';
  recorder.cancelRecording();
  assert.equal(recorder.blob, blob);
  assert.equal(recorder.objectUrl, url);
  assert.equal(recorder.savedTake.id, 'previous');
  assert.equal(recorder.buttons.record.textContent, 'RECORD');
  recorder.backup = recorder.captureBackup(); recorder.blob = null; recorder.objectUrl = null;
  recorder.savedTake = null; recorder.mode = 'recording';
  recorder.cancelRecording();
  assert.equal(recorder.blob, blob);
  assert.equal(recorder.objectUrl, url);
  assert.equal(recorder.savedTake.id, 'previous');
});

test('a restored saved candidate advances without another upload', async t => {
  const { recorder, calls } = fixture(t);
  recorder.setCandidate(candidate('restored'));
  assert.equal(recorder.review.src, '/takes/restored');
  assert.equal(recorder.buttons.next.disabled, false);
  await recorder.next();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/takes/own-line/accept');
  assert.deepEqual(calls[0].body, { takeId: 'restored' });
});

test('ORIGINAL uses preview padding and starts reference at the line; MY TAKE stays exact', async t => {
  const { recorder, frame } = fixture(t);
  await recorder.playOriginal();
  assert.equal(recorder.video.currentTime, 8.5);
  assert.equal(recorder.reference.playCount, 0);
  recorder.video.currentTime = 10; frame();
  assert.equal(recorder.reference.playCount, 1);
  recorder.video.currentTime = 12; frame();
  assert.equal(recorder.reference.paused, true);
  assert.equal(recorder.video.paused, false);
  recorder.video.currentTime = 12.5; frame();
  assert.equal(recorder.video.paused, true);
  recorder.setCandidate(candidate('saved'));
  await recorder.playTake();
  assert.equal(recorder.video.currentTime, 10);
  assert.equal(recorder.review.playCount, 1);
  assert.equal(recorder.video.muted, true);
});

test('source audio fallback is audible only in ORIGINAL and waveform has an idle baseline', async t => {
  const { recorder } = fixture(t);
  recorder.setLine(pack, { ...line, referenceAudio: null }, true, { previewBefore: 0, previewAfter: 0 });
  await recorder.playOriginal();
  assert.equal(recorder.video.muted, false);
  recorder.stopMedia();
  assert.equal(recorder.video.muted, true);
  assert.equal(recorder.waveform.hidden, false);
  assert.equal(recorder.progress.hidden, true);
});

test('decoded waveforms overlay the full longer take on the original line timeline', t => {
  const { recorder, elements } = fixture(t);
  recorder.referenceSamples = Float32Array.from({ length: 200 }, (_, index) => Math.sin(index));
  recorder.referenceDuration = 2; recorder.referenceSampleRate = 100;
  recorder.takeSamples = Float32Array.from({ length: 400 }, (_, index) => Math.cos(index));
  recorder.takeDuration = 4; recorder.takeSampleRate = 100;
  recorder.drawWaveform();
  const strokes = elements.get('recording-waveform').getContext('2d').strokes;
  const original = strokes.filter(stroke => stroke.color === '#b093ff');
  const take = strokes.filter(stroke => stroke.color === '#67e5ff');
  const lastX = list => Math.max(...list.map(stroke => stroke.path[0][0]));
  assert.ok(original.length > 0 && take.length > original.length);
  assert.ok(lastX(take) > 670 && lastX(take) > lastX(original) * 1.9, 'the take extends the shared timeline to its full duration');
  recorder.mode = 'my-take'; recorder.review.currentTime = 1.25; recorder.lastWaveformDrawAt = -1000;
  recorder.drawWaveform();
  assert.ok(elements.get('recording-waveform').getContext('2d').strokes.some(stroke => stroke.color === '#f4f4f4'), 'playback draws a visible cursor');
});

test('stale waveform decoding is discarded and missing-reference video decoding is attempted', async t => {
  const { recorder } = fixture(t);
  const originalFetch = globalThis.fetch; const fetches = [];
  globalThis.fetch = async url => {
    fetches.push(String(url));
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  recorder.decodeAudio = async () => ({ samples: Float32Array.from({ length: 3000 }, (_, index) => index / 3000), duration: 3, sampleRate: 1000 });
  recorder.setLine(pack, { ...line, id: 'fallback-line', startTime: 1, endTime: 2, duration: 1, referenceAudio: null }, true, {});
  await turn(); await turn();
  assert.equal(fetches[0], pack.videoUrl);
  assert.equal(recorder.referenceSamples.length, 1000);
  assert.equal(recorder.referenceDuration, 1);

  const decoding = deferred(); recorder.decodeAudio = () => decoding.promise;
  recorder.loadTakeWaveform(new Blob(['old take'], { type: 'audio/webm' }), 'old-take', '');
  await turn(); await turn();
  recorder.setLine(pack, { ...line, id: 'new-line' }, true, {});
  decoding.resolve({ samples: new Float32Array([1, 1]), duration: 2, sampleRate: 1 });
  await turn(); await turn();
  assert.equal(recorder.takeSamples, null, 'a result for the previous line cannot paint over the new line');

  recorder.decodeAudio = async () => { throw new Error('unsupported source audio'); };
  recorder.setLine(pack, { ...line, id: 'failed-line' }, true, {});
  await turn(); await turn();
  assert.equal(recorder.waveformStatus.textContent, 'Original waveform unavailable');
  assert.equal(recorder.buttons.record.disabled, false, 'waveform failure does not block recording');
});

test('microphone amplification is remembered, feeds capture and meter before effects, and never reaches speakers', t => {
  const values = new Map([['open-dub-microphone-gain', '175']]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const { recorder } = fixture(t, undefined, storage);
  assert.equal(recorder.microphoneGainPercent, 175);
  const makeNode = () => ({ connections: [], connect(target) { this.connections.push(target); }, disconnect() {} });
  const context = {
    currentTime: 0, sampleRate: 48000, destination: makeNode(),
    createAnalyser() { return Object.assign(makeNode(), { frequencyBinCount: 256 }); },
    createGain() { return Object.assign(makeNode(), { gain: { value: 1 } }); },
    createMediaStreamDestination() { return Object.assign(makeNode(), { stream: {} }); },
    close() { return Promise.resolve(); },
  };
  recorder.audioContext = context; recorder.micSource = makeNode(); recorder.buildMicGraph();
  const gain = recorder.microphoneGainNode;
  assert.equal(gain.gain.value, 1.75);
  assert.deepEqual(recorder.micSource.connections, [gain]);
  assert.equal(gain.connections.includes(recorder.meterAnalyser), true);
  assert.equal(gain.connections.includes(recorder.effectInputGain), true);
  recorder.setMicrophoneGain(205);
  assert.equal(gain.gain.value, 2.05);
  assert.equal(values.get('open-dub-microphone-gain'), '205');
  assert.ok(![recorder.micSource, ...recorder.effectNodes, recorder.captureAnalyser].some(node => node.connections.includes(context.destination)));
});

test('the 0.2-second scene lead-in and take-review waits are cancelable and do not create stray takes', async t => {
  const { recorder } = fixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  let instances = 0; let savesDuringReviewWait = 0;
  class FakeRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() { super(); this.state = 'inactive'; this.mimeType = 'audio/webm'; instances++; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        const data = new Event('dataavailable'); data.data = new Blob(['captured audio'], { type: this.mimeType });
        this.dispatchEvent(data); this.dispatchEvent(new Event('stop'));
      });
    }
  }
  Object.defineProperty(globalThis, 'MediaRecorder', { value: FakeRecorder, configurable: true });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'MediaRecorder', descriptor); else delete globalThis.MediaRecorder; });
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
  recorder.stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  recorder.enableMicrophone = async () => {};
  recorder.skipCountdown.checked = true;
  recorder.save = () => { savesDuringReviewWait++; return Promise.resolve(null); };
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  const cancelled = recorder.record(); await turn();
  assert.equal(recorder.mode, 'preroll'); assert.equal(recorder.video.playCount, 0);
  recorder.cancelRecording('', true); await cancelled;
  assert.equal(instances, 0); assert.equal(recorder.blob, null);

  const recording = recorder.record();
  await delay(220); await recording;
  assert.equal(recorder.mode, 'recording'); assert.equal(recorder.video.playCount, 1);
  recorder.stopRecording(); await delay(20);
  assert.equal(recorder.mode, 'settling'); assert.equal(savesDuringReviewWait, 1);
  await delay(220);
  assert.equal(recorder.mode, 'review');
});

test('microphone permission finishes even when the optional monitoring context cannot resume', async t => {
  const { recorder } = fixture(t);
  const descriptors = Object.fromEntries(['navigator', 'MediaRecorder'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const track = new EventTarget(); track.readyState = 'live'; track.stop = () => { track.readyState = 'ended'; };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => stream } }, configurable: true });
  Object.defineProperty(globalThis, 'MediaRecorder', { value: class {}, configurable: true });
  window.AudioContext = class {
    createAnalyser() { return {}; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    resume() { return new Promise(() => {}); }
    close() { return Promise.resolve(); }
  };
  let timeout;
  try {
    await Promise.race([recorder.enableMicrophone(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('monitor context blocked microphone readiness')), 100);
    })]);
    assert.equal(recorder.stream, stream);
    assert.equal(track.readyState, 'live');
  } finally { clearTimeout(timeout); }
});


test('a pause before a queued save starts releases its job and resume saves the same take', async t => {
  const { recorder, calls, localTake } = fixture(t, path => path.endsWith('/accept') ? {} : snapshot(candidate('resumed')));
  const blob = localTake();
  const saving = recorder.save();
  recorder.setLine(pack, line, true, {}, true);
  assert.equal(await saving, null);
  assert.equal(recorder.currentSave(), null);
  assert.equal(recorder.blob, blob);
  assert.equal(calls.length, 0);
  recorder.setLine(pack, line, true, {}, false);
  await recorder.next();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/api/takes/own-line');
  assert.deepEqual(calls[1].body, { takeId: 'resumed' });
});

test('a save rejected during pause preserves the local take and automatically retries on resume', async t => {
  const upload = deferred();
  const { recorder, calls, localTake } = fixture(t, (path, body, options, count) => count === 1 ? upload.promise : snapshot(candidate('resumed')));
  const blob = localTake(); const url = recorder.objectUrl;
  const saving = recorder.save(); await turn();
  recorder.setLine(pack, line, true, {}, true);
  upload.resolve(Promise.reject(new Error('Session is not recording')));
  assert.equal(await saving, null);
  assert.equal(recorder.blob, blob);
  assert.equal(recorder.objectUrl, url);
  assert.equal(recorder.savedTake, null);
  assert.equal(calls.length, 1);
  recorder.setLine(pack, line, true, {}, false);
  await turn();
  assert.equal(calls.length, 2);
  assert.equal(recorder.savedTake.id, 'resumed');
  assert.equal(recorder.savedBlob, blob);
});

test('a host pause cancels an unfinished replacement and restores the previous take', t => {
  const { recorder, localTake } = fixture(t);
  const blob = localTake(); const url = recorder.objectUrl;
  recorder.savedTake = candidate('previous'); recorder.savedBlob = blob;
  recorder.backup = recorder.captureBackup(); recorder.blob = null; recorder.objectUrl = null; recorder.savedTake = null;
  let stopCalls = 0;
  recorder.recorder = { state: 'recording', stop() { stopCalls++; } };
  recorder.mode = 'recording';
  recorder.pauseCapture();
  assert.equal(stopCalls, 1);
  assert.equal(recorder.blob, blob);
  assert.equal(recorder.objectUrl, url);
  assert.equal(recorder.savedTake.id, 'previous');
  assert.equal(recorder.mode, 'review');
});


test('voice effect buttons select one effect and lock during capture or host disablement', t => {
  const { recorder } = fixture(t);
  const buttons = recorder.effects.querySelectorAll('[data-effect]');
  buttons[3].dispatchEvent(new Event('click'));
  assert.equal(recorder.currentEffect, 'robot');
  assert.deepEqual(buttons.map(button => button.getAttribute('aria-pressed')), ['false', 'false', 'false', 'true', 'false']);
  recorder.mode = 'recording'; recorder.updateControls();
  assert.ok(buttons.every(button => button.disabled));
  recorder.setEffect('echo'); assert.equal(recorder.currentEffect, 'robot');
  recorder.mode = 'idle';
  recorder.setLine(pack, line, true, { voiceEffectsEnabled: false });
  assert.equal(recorder.currentEffect, 'normal');
  assert.ok(buttons.every(button => button.disabled));
  recorder.setLine(pack, line, true, { voiceEffectsEnabled: true });
  assert.ok(buttons.every(button => !button.disabled));
});

test('AUTO-TUNE is disabled with an explanation when worklet processing is unavailable', t => {
  const { recorder, elements } = fixture(t);
  const button = recorder.effects.querySelectorAll('[data-effect]').find(item => item.getAttribute('data-effect') === 'autoTune');
  assert.ok(button);
  recorder.effectWorkletAvailable = false;
  recorder.updateControls();
  assert.equal(button.disabled, true);
  assert.match(button.title, /AudioWorklet/);
  recorder.setEffect('autoTune');
  assert.equal(recorder.currentEffect, 'normal');
  recorder.setEffect('goblin');
  assert.equal(recorder.currentEffect, 'normal', 'other DSP effects cannot be selected if the worklet is unavailable');
  recorder.setEffect('echo');
  assert.equal(recorder.currentEffect, 'echo', 'native Web Audio effects still work without the worklet');
  assert.match(elements.get('effect-capability').textContent, /effects require AudioWorklet/);

  recorder.effectWorkletAvailable = true;
  recorder.updateControls();
  assert.equal(button.disabled, false);
  assert.equal(button.title, '');
  recorder.setEffect('autoTune');
  assert.equal(recorder.currentEffect, 'autoTune');
});

test('an accepted take stays the playback source until an owned replacement is saved or canceled', async t => {
  const { recorder, calls } = fixture(t);
  const accepted = { ...candidate('accepted'), status: 'accepted', url: '/takes/accepted' };
  const replacement = { ...candidate('replacement'), retakeId: 'opaque-retake', url: '/takes/replacement' };
  recorder.loadTakeWaveform = () => {};
  recorder.client.state.session.lineTakes = { [line.id]: accepted };
  recorder.setTakes(undefined, accepted, undefined);
  assert.equal(recorder.acceptedTake.id, 'accepted');
  assert.equal(recorder.review.src, '/takes/accepted');

  recorder.setTakes(undefined, accepted, replacement);
  assert.equal(recorder.savedTake.id, 'replacement');
  assert.equal(recorder.review.src, '/takes/replacement');
  recorder.retakeId = 'opaque-retake';
  const local = new Blob(['candidate'], { type: 'audio/webm' });
  recorder.savedBlob = local; recorder.mode = 'review';
  recorder.mode = 'recording';
  assert.equal(await recorder.cancelActiveRetake(), false, 'cancellation is unavailable during capture');
  assert.equal(calls.length, 0);
  recorder.mode = 'review';
  assert.equal(await recorder.cancelActiveRetake(), true);
  assert.equal(calls.at(-1).path, '/api/takes/own-line/retake/cancel');
  assert.deepEqual(calls.at(-1).body, { retakeId: 'opaque-retake' });
  assert.equal(recorder.retakeId, '');
  assert.equal(recorder.savedTake, null);
  assert.equal(recorder.acceptedTake.id, 'accepted');
  assert.equal(recorder.hasPlaybackTake(), true);
  await recorder.playTake();
  assert.equal(recorder.review.src, '/takes/accepted', 'MY TAKE falls back to the accepted version after cancellation');
});

test('robot capture uses bipolar ring modulation, dry mix, saturation and compression; switching stops oscillator', t => {
  const { recorder } = fixture(t);
  const nodes = [];
  const node = kind => {
    const value = { kind, connections: [], connect(target) { this.connections.push(target); }, disconnect() { this.disconnected = true; } };
    for (const name of ['gain', 'frequency', 'Q', 'threshold', 'knee', 'ratio', 'attack', 'release']) value[name] = { value: 0 };
    nodes.push(value); return value;
  };
  recorder.audioContext = {
    createBiquadFilter: () => node('filter'), createGain: () => node('gain'),
    createWaveShaper: () => node('distortion'), createDynamicsCompressor: () => node('compressor'),
    createOscillator() { const oscillator = node('oscillator'); oscillator.start = () => { oscillator.started = true; }; oscillator.stop = () => { oscillator.stopped = true; }; return oscillator; },
    createAnalyser() { const analyser = node('analyser'); analyser.frequencyBinCount = 256; return analyser; },
    createMediaStreamDestination: () => node('destination'), close: async () => {},
  };
  recorder.micSource = node('source'); recorder.setEffect('robot');
  const filters = nodes.filter(node => node.kind === 'filter');
  assert.deepEqual(filters.map(node => [node.type, node.frequency.value, node.Q.value]), [['highpass', 120, 0.7], ['peaking', 2400, 1.1], ['lowpass', 6500, 0.7]]);
  assert.equal(filters[1].gain.value, 4);
  const oscillator = recorder.robotOscillator;
  assert.equal(oscillator.type, 'sine'); assert.equal(oscillator.frequency.value, 52); assert.equal(oscillator.started, true);
  const depth = oscillator.connections[0]; assert.equal(depth.gain.value, 0.85);
  const ring = filters[2].connections.find(node => node.gain.value === 0);
  assert.equal(depth.connections[0], ring.gain);
  const distortion = ring.connections[0];
  assert.equal(distortion.curve.length, 1024); assert.equal(distortion.oversample, '2x');
  assert.ok(Math.abs(distortion.curve[0] - Math.tanh(-1.8)) < 1e-7);
  const wet = distortion.connections[0]; assert.equal(wet.gain.value, 0.82);
  const dry = filters[2].connections.find(node => node.gain.value === 0.18);
  const mix = wet.connections[0]; assert.equal(dry.connections[0], mix);
  const compressor = mix.connections[0];
  assert.deepEqual(['threshold', 'knee', 'ratio', 'attack', 'release'].map(name => compressor[name].value), [-24, 5, 8, 0.003, 0.08]);
  assert.equal(compressor.connections[0], recorder.captureAnalyser);
  assert.equal(recorder.captureAnalyser.connections[0], recorder.captureDestination);
  recorder.setEffect('normal');
  assert.equal(oscillator.stopped, true); assert.equal(oscillator.disconnected, true);
  assert.equal(recorder.robotOscillator, null);
});
