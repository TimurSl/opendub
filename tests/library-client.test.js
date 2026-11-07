import test from 'node:test';
import assert from 'node:assert/strict';
import { filterEntries, replaySession, clock } from '../web/admin/library.js';

const entries = [
  { id: 'a', pack: { id: 'p1' }, players: [{ id: 'u1' }, { id: 'u2' }], starred: true },
  { id: 'b', pack: { id: 'p2' }, players: [{ id: 'u2' }], starred: false },
  { id: 'c', damaged: true },
];

test('library filters combine pack, player and starred, and damaged entries only show unfiltered', () => {
  assert.deepEqual(filterEntries(entries).map(e => e.id), ['a', 'b', 'c']);
  assert.deepEqual(filterEntries(entries, { pack: 'p2' }).map(e => e.id), ['b']);
  assert.deepEqual(filterEntries(entries, { player: 'u2' }).map(e => e.id), ['a', 'b']);
  assert.deepEqual(filterEntries(entries, { player: 'u2', starred: true }).map(e => e.id), ['a']);
  assert.deepEqual(filterEntries(entries, { starred: true, pack: 'p9' }), []);
});

test('replaySession adapts a saved entry to what final playback expects', () => {
  const session = replaySession({
    id: 'entry1234', pack: { id: 'p1' }, replay: { videoUrl: '/library-media/entry1234/video', backingTrackUrl: '/library-media/entry1234/backing' },
    lines: [
      { id: 'l1', character: 'Alice', startTime: 1, endTime: 3, take: { srcId: 't1', url: '/library-media/entry1234/line-0.media', leadIn: 0.2, tail: 0.1, recorder: { id: 'u1', nickname: 'Ada' } } },
      { id: 'l2', character: 'Bob', startTime: 4, endTime: 5, take: null },
    ],
  });
  assert.equal(session.matchId, 'library:entry1234');
  assert.equal(session.playback, null);
  assert.deepEqual(Object.keys(session.lineTakes), ['l1'], 'lines without takes are skipped');
  assert.equal(session.lineTakes.l1.status, 'accepted');
  assert.equal(session.lineTakes.l1.url, '/library-media/entry1234/line-0.media');
  assert.equal(session.pack.lines[0].duration, 2);
  assert.equal(session.pack.videoUrl, '/library-media/entry1234/video');
});

test('clock formats durations', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(65.4), '1:05');
  assert.equal(clock(-3), '0:00');
});
