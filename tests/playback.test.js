import test from 'node:test';
import assert from 'node:assert/strict';
import { audioWindow, DubPlayback } from '../web/playback/playback.js';

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test('future voice take starts at its Workshop timestamp on the shared audio clock', () => {
  const window = audioWindow(61.352, 2.888, 3.2, 0, 10);
  close(window.when, 71.352);
  assert.equal(window.offset, 0);
  close(window.duration, 2.888);
});

test('overlapping voices retain independent windows and mix on the same timeline', () => {
  const first = audioWindow(3, 3, 3, 0, 100);
  const second = audioWindow(4, 2.5, 2.5, 0, 100);
  assert.equal(first.when, 103);
  assert.equal(second.when, 104);
  assert.ok(first.when + first.duration > second.when);
  assert.equal(first.offset, 0);
  assert.equal(second.offset, 0);
});

test('late joining slices active backing and voices at the elapsed source position', () => {
  const backing = audioWindow(0, 120, 120, 62, 20);
  assert.deepEqual(backing, { when: 20, offset: 62, duration: 58 });
  const voice = audioWindow(61.352, 2.888, 3.2, 62, 20);
  assert.equal(voice.when, 20);
  close(voice.offset, 0.648);
  close(voice.duration, 2.24);
  const futureVoice = audioWindow(70, 2, 2, 62, 20);
  assert.deepEqual(futureVoice, { when: 28, offset: 0, duration: 2 });
});

test('voice scheduling clips an overlong take to its line and respects a short recording', () => {
  assert.deepEqual(audioWindow(4, 2, 20, 0, 10), { when: 14, offset: 0, duration: 2 });
  assert.deepEqual(audioWindow(4, 2, 0.8, 0, 10), { when: 14, offset: 0, duration: 0.8 });
});

test('finished or exhausted recordings are never scheduled with negative duration', () => {
  assert.equal(audioWindow(4, 2, 2, 6, 10), null);
  assert.equal(audioWindow(4, 2, 2, 12, 10), null);
  assert.equal(audioWindow(4, 10, 0.8, 5, 10), null);
  assert.equal(audioWindow(4, 2, 0, 0, 10), null);
});

function playerHarness(t, { fetcher, initialContextState = 'suspended', player = true } = {}) {
  const names = ['window', 'document', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName = tag; this.children = []; this.attributes = {}; this.readyState = 1; this.duration = 20; this.currentTime = 0; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    canPlayType() { return ''; }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    load() {}
  }
  class Context extends EventTarget {
    constructor() { super(); this.state = initialContextState; this.currentTime = 100; this.starts = []; }
    resume() { this.state = 'running'; this.dispatchEvent(new Event('statechange')); return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({ duration: 20 }); }
    createBufferSource() {
      const context = this;
      return { connect() {}, disconnect() {}, stop() {}, start(...args) { context.starts.push(args); } };
    }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const frames = new Map(); let frameId = 0;
  globalThis.window = new EventTarget(); globalThis.window.AudioContext = Context;
  globalThis.document = { createElement: tag => new Element(tag) };
  const fetched = [];
  globalThis.fetch = async url => {
    fetched.push(url);
    if (fetcher) return fetcher(url);
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
  };
  globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const root = new Element('div'); const errors = []; const client = { now: 10000, serverNow() { return this.now; } };
  const playback = new DubPlayback(root, client, error => errors.push(error.message), { player });
  t.after(() => {
    playback.stop();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  const state = ({ takeId = 'voice-one', playbackId = null, startsAt = 10000 } = {}) => ({ session: {
    id: 'room', pack: { id: 'pack', videoUrl: '/video', backingTrackUrl: '/backing', lines: [{ id: 'line', startTime: 2, endTime: 4, duration: 2 }] },
    lineTakes: takeId ? { line: { id: takeId, url: `/takes/${takeId}`, status: 'accepted' } } : {},
    playback: playbackId ? { id: playbackId, startsAt } : null,
  } });
  return { playback, root, errors, client, fetched, frames, state };
}

test('player viewer exposes one accessible control and preloads quietly before audio is unlocked', async (t) => {
  const { playback, root, fetched, state } = playerHarness(t);
  assert.deepEqual(root.children.map(child => child.tagName), ['video', 'div', 'p']);
  assert.equal(playback.actions.children.length, 1);
  assert.equal(playback.playButton.textContent, 'PLAY');
  assert.equal(playback.playButton.attributes['aria-pressed'], 'false');
  playback.setState(state());
  await playback.preparePlayer();
  assert.deepEqual(new Set(fetched), new Set(['/backing', '/takes/voice-one']));
  assert.equal(playback.status.textContent, '');
  assert.equal(playback.context.state, 'suspended');
  assert.equal(playback.runningId, null);
  assert.equal(playback.context.starts.length, 0);
  await playback.unlock();
  assert.equal(playback.context.state, 'running');
  assert.equal(playback.context.starts.length, 0); // READY never starts a movie.
});

test('player refreshes the video source when its URL changes within the same session and pack', (t) => {
  const { playback, state } = playerHarness(t);
  const initial = state();
  playback.setState(initial);
  assert.equal(playback.video.src, '/video');

  const refreshed = state();
  refreshed.session.pack.videoUrl = '/video.mp4';
  playback.setState(refreshed);

  assert.equal(playback.video.src, '/video.mp4');
});

test('host preview refreshes the video source when its URL changes within the same pack', (t) => {
  const { playback, state } = playerHarness(t, { player: false });
  const initial = state();
  playback.setState(initial);
  assert.equal(playback.video.src, '/video');

  const refreshed = state();
  refreshed.session.pack.videoUrl = '/video.mp4';
  playback.setState(refreshed);

  assert.equal(playback.video.src, '/video.mp4');
});

test('unlocked player starts automatically; PAUSE survives repeated snapshots and PLAY catches up', async (t) => {
  const { playback, client, state } = playerHarness(t);
  playback.setState(state());
  await playback.preparePlayer(); await playback.unlock();
  playback.setState(state({ playbackId: 'shared-movie', startsAt: 15000 }));
  assert.equal(playback.runningId, 'shared-movie');
  assert.equal(playback.playButton.textContent, 'PAUSE');
  assert.equal(playback.playButton.attributes['aria-pressed'], 'true');
  assert.deepEqual(playback.context.starts, [[105, 0, 20], [107, 0, 2]]);
  playback.pausePlayer();
  playback.setState(state({ playbackId: 'shared-movie', startsAt: 15000 }));
  await Promise.resolve();
  assert.equal(playback.runningId, null);
  assert.equal(playback.playButton.textContent, 'PLAY');
  assert.equal(playback.context.starts.length, 2);
  client.now = 17500; // Resume 2.5 seconds into the shared movie.
  await playback.playPlayer();
  assert.equal(playback.runningId, 'shared-movie');
  assert.deepEqual(playback.context.starts.slice(2), [[100, 2.5, 17.5], [100, 0.5, 1.5]]);
});

test('changing accepted takes during preparation retries the latest key and latest shared descriptor', async (t) => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const { playback, state, fetched } = playerHarness(t, {
    initialContextState: 'running',
    fetcher: url => url === '/takes/old-voice' ? delayed : Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
  });
  playback.setState(state({ takeId: 'old-voice', playbackId: 'old-playback' }));
  playback.setState(state({ takeId: 'new-voice', playbackId: 'new-playback', startsAt: 15000 }));
  release({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
  await playback.preparePlayer(); await Promise.resolve();
  assert.equal(playback.readyKey, playback.key());
  assert.ok(fetched.includes('/takes/new-voice'));
  assert.equal(playback.runningId, 'new-playback');
  assert.deepEqual(playback.context.starts, [[105, 0, 20], [107, 0, 2]]);
});

test('completed player playback remains stopped across snapshots and errors reveal no transport details', async (t) => {
  const { playback, state, frames } = playerHarness(t, { initialContextState: 'running' });
  playback.setState(state({ playbackId: 'movie' }));
  await playback.preparePlayer(); await Promise.resolve();
  playback.context.currentTime = 125;
  frames.get(playback.frame)();
  assert.equal(playback.runningId, null);
  assert.equal(playback.status.textContent, 'Movie finished.');
  const scheduled = playback.context.starts.length;
  playback.setState(state({ playbackId: 'movie' })); await Promise.resolve();
  assert.equal(playback.context.starts.length, scheduled);
  assert.equal(playback.playButton.textContent, 'PLAY');
});

test('player download errors are friendly and PLAY retries after the media becomes available', async (t) => {
  let available = false;
  const { playback, state, errors } = playerHarness(t, { initialContextState: 'running', fetcher: async () => {
    if (!available) throw new Error('HTTP 502 at /host/private/take.webm');
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
  } });
  playback.setState(state({ playbackId: 'movie' }));
  await assert.rejects(playback.preparePlayer()); await Promise.resolve();
  assert.ok(errors.length);
  assert.ok(errors.every(error => !/502|private|webm|HTTP/.test(error)));
  assert.equal(playback.playButton.textContent, 'PLAY');
  available = true;
  await playback.playPlayer();
  assert.equal(playback.runningId, 'movie');
});
