// Clips are the recording tasks of a pack. Redub requests (votes) float a clip to the top of the
// host's list and grid: more requests first, then the pack's own order. Pure, so both views and
// the tests share one rule.
export function rankClips(lines, votes = {}) {
  return lines
    .map((line, index) => ({ line, index, count: votes[line.id]?.count ?? 0 }))
    .sort((a, b) => b.count - a.count || a.index - b.index);
}

// Position of every clip id after ranking, for CSS `order` on rows that are updated in place
// (re-creating an <audio> element would stop playback).
export function clipOrder(lines, votes = {}) {
  return new Map(rankClips(lines, votes).map(({ line }, rank) => [line.id, rank]));
}

export function requestSummary(votes = {}) {
  const counts = Object.values(votes).map(vote => vote.count);
  return { clips: counts.length, requests: counts.reduce((sum, count) => sum + count, 0) };
}
