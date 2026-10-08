// The INI cue defines what the viewer can see/hear. A longer reference MP3
// must not silently extend the take into a frozen frame.
export const MAX_TAKE_TAIL_SECONDS = 2;

export function captureTail(postRollSeconds) {
  if (!Number.isFinite(postRollSeconds)) return 0;
  return Math.round(Math.max(0, Math.min(MAX_TAKE_TAIL_SECONDS, postRollSeconds)) * 1000) / 1000;
}

// The capture cursor, progress bar and MediaRecorder stop share one monotonic
// deadline. Video.currentTime and decoded MP3 length do not change it.
export function capturePlan(captureStartMs, cueStartMs, lineSeconds, postRollSeconds) {
  const tail = captureTail(postRollSeconds);
  const deadlineMs = cueStartMs + (lineSeconds + tail) * 1000;
  return { tail, deadlineMs, duration: Math.max(0, (deadlineMs - captureStartMs) / 1000) };
}

export function recordedTail(captureStartMs, stopMs, leadInSeconds, lineSeconds) {
  return Math.round(Math.min(MAX_TAKE_TAIL_SECONDS, Math.max(0,
    (stopMs - captureStartMs) / 1000 - leadInSeconds - lineSeconds,
  )) * 1000) / 1000;
}
