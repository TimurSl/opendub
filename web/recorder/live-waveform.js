// Collect extrema from the actual post-effect capture path, not the raw mic meter.
// Sparse peaks occupy fixed time bins, so the take grows across the reference as recorded.
export const LIVE_WAVEFORM_HZ = 60;
export function createLivePeaks(maxDuration, binsPerSecond = LIVE_WAVEFORM_HZ) {
  const count = Math.min(18000, Math.max(1, Math.ceil(maxDuration * binsPerSecond)));
  return { minima: new Float32Array(count), maxima: new Float32Array(count), recorded: new Uint8Array(count), binsPerSecond };
}
export function appendLivePeaks(peaks, seconds, samples) {
  if (!peaks || !Number.isFinite(seconds) || seconds < 0 || !samples?.length) return;
  const index = Math.min(peaks.recorded.length - 1, Math.floor(seconds * peaks.binsPerSecond));
  let minimum = 0; let maximum = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) continue;
    minimum = Math.min(minimum, sample); maximum = Math.max(maximum, sample);
  }
  if (!peaks.recorded[index]) { peaks.minima[index] = minimum; peaks.maxima[index] = maximum; peaks.recorded[index] = 1; }
  else { peaks.minima[index] = Math.min(peaks.minima[index], minimum); peaks.maxima[index] = Math.max(peaks.maxima[index], maximum); }
}
