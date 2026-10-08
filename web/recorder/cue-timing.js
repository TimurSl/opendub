// The INI timestamps define the video cue, but the accompanying MP3 may
// contain a little more dialogue. Make that audible without allowing a bad
// asset to extend an individual take indefinitely (the server permits 2 s).
export const MAX_TAKE_TAIL_SECONDS = 2;
export const MAX_REFERENCE_OVERHANG_SECONDS = 1.25;

export function referenceOverhang(lineDuration, referenceDuration, postRollSeconds = 0.65) {
  if (![lineDuration, referenceDuration, postRollSeconds].every(Number.isFinite)) return 0;
  return Math.round(Math.max(0, Math.min(
    referenceDuration - lineDuration,
    MAX_REFERENCE_OVERHANG_SECONDS,
    MAX_TAKE_TAIL_SECONDS - postRollSeconds,
  )) * 1000) / 1000;
}

export function captureTail(overhangSeconds, postRollSeconds) {
  return Math.round(Math.max(0, Math.min(MAX_TAKE_TAIL_SECONDS, overhangSeconds + postRollSeconds)) * 1000) / 1000;
}

// The capture cursor, the progress bar and MediaRecorder's stop must share
// ONE monotonic deadline. Video.currentTime can run ahead of wall time.
export function capturePlan(captureStartMs, cueStartMs, lineSeconds, overhangSeconds, postRollSeconds) {
  const tail = captureTail(overhangSeconds, postRollSeconds);
  const deadlineMs = cueStartMs + (lineSeconds + tail) * 1000;
  return { tail, deadlineMs, duration: Math.max(0, (deadlineMs - captureStartMs) / 1000) };
}

export function recordedTail(captureStartMs, stopMs, leadInSeconds, lineSeconds) {
  return Math.round(Math.min(MAX_TAKE_TAIL_SECONDS, Math.max(0,
    (stopMs - captureStartMs) / 1000 - leadInSeconds - lineSeconds,
  )) * 1000) / 1000;
}
