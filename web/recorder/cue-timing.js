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
