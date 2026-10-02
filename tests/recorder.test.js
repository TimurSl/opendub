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
  getContext() { return { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} }; }
}
const line = { id: 'own-line', character: 'Actor', startTime: 10, endTime: 12, duration: 2, referenceAudio: '/reference' };
const pack = { id: 'pack', videoUrl: '/video' };
const candidate = id => ({ id, playerId: 'player', status: 'recorded', url: '/takes/' + id });
const snapshot = take => ({ session: { lineTakes: { [line.id]: take } } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, handle) {
  const originals = Object.fromEntries(['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const elements = new Map(); const frames = new Map(); let frameId = 0;
  const document = new EventTarget(); document.hidden = false;
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const window = new EventTarget(); window.matchMedia = () => ({ matches: false }); window.isSecureContext = true;
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { value: callback => { frames.set(++frameId, callback); return frameId; }, configurable: true });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: id => frames.delete(id), configurable: true });
  const calls = []; const client = new EventTarget(); client.state = { viewer: { playerId: 'player' } };
  client.request = async (path, body, options) => {
    calls.push({ path, body, options });
    return handle ? handle(path, body, options, calls.length) : {};
  };
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
