// Collect extrema from the actual post-effect capture path, not the raw mic meter.
// Sparse peaks occupy fixed time bins, so the take grows across the reference as recorded.
export const LIVE_WAVEFORM_HZ = 60;
export function createLivePeaks(maxDuration, binsPerSecond = LIVE_WAVEFORM_HZ) {
  const count = Math.min(18000, Math.max(1, Math.ceil(maxDuration * binsPerSecond)));
  return { minima: new Float32Array(count), maxima: new Float32Array(count), recorded: new Uint8Array(count), binsPerSecond, peak: 0 };
}
export function appendLivePeaks(peaks, seconds, samples) {
  if (!peaks || !Number.isFinite(seconds) || seconds < 0 || !samples?.length) return;
  const index = Math.min(peaks.recorded.length - 1, Math.floor(seconds * peaks.binsPerSecond));
  let minimum = 0; let maximum = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) continue;
    minimum = Math.min(minimum, sample); maximum = Math.max(maximum, sample);
  }
  peaks.peak = Math.max(peaks.peak || 0, -minimum, maximum);
  if (!peaks.recorded[index]) { peaks.minima[index] = minimum; peaks.maxima[index] = maximum; peaks.recorded[index] = 1; }
  else { peaks.minima[index] = Math.min(peaks.minima[index], minimum); peaks.maxima[index] = Math.max(peaks.maxima[index], maximum); }
}

// Quiet microphones and softly mastered references would otherwise draw as an
// almost flat 1–2px line. Each waveform is scaled so its loudest peak fills the
// canvas; the gain is capped so silence or a noise floor is never blown up
// into a solid block.
export const WAVEFORM_MAX_GAIN = 10;
export function waveformGain(peak, maxGain = WAVEFORM_MAX_GAIN) {
  if (!Number.isFinite(peak) || peak <= 0) return 1;
  return 1 / Math.max(peak, 1 / maxGain);
}
export function samplePeak(samples, start = 0, end = samples?.length ?? 0) {
  let peak = 0;
  if (!samples) return peak;
  const last = Math.min(samples.length, end);
  for (let index = Math.max(0, start); index < last; index++) {
    const value = Math.abs(samples[index]);
    if (value > peak && Number.isFinite(value)) peak = value;
  }
  return peak;
}
export function livePeak(peaks) {
  if (!peaks) return 0;
  if (Number.isFinite(peaks.peak)) return peaks.peak;
  let peak = 0;
  for (let bin = 0; bin < peaks.recorded.length; bin++) {
    if (!peaks.recorded[bin]) continue;
    peak = Math.max(peak, Math.abs(peaks.minima[bin]), Math.abs(peaks.maxima[bin]));
  }
  return peak;
}
