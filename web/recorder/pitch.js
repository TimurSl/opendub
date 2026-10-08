export function detectVoicedPitch(samples, sampleRate, { minimumFrequency = 70, maximumFrequency = 1000, confidenceThreshold = 0.8 } = {}) {
  if (!samples?.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const count = samples.length;
  const meanStride = Math.max(1, Math.floor(count / 512));
  let mean = 0; let meanCount = 0;
  for (let index = 0; index < count; index += meanStride) { mean += samples[index]; meanCount++; }
  mean /= Math.max(1, meanCount);

  const stride = Math.max(1, Math.floor(sampleRate / 24000));
  let energy = 0; let energyCount = 0;
  for (let index = 0; index < count; index += stride) {
    const value = samples[index] - mean; energy += value * value; energyCount++;
  }
  const rms = Math.sqrt(energy / Math.max(1, energyCount));
  if (!Number.isFinite(rms) || rms < 0.009) return null;

  const maximumLag = Math.min(Math.floor(count / 2), Math.floor(sampleRate / minimumFrequency));
  const minimumLag = Math.max(2, Math.floor(sampleRate / maximumFrequency));
  if (maximumLag <= minimumLag) return null;

  // A global autocorrelation maximum favors longer subharmonic periods. The
  // cumulative-mean normalized difference below selects the first confident
  // period trough instead, which keeps pure tones and voiced fundamentals on
  // their actual note.
  const difference = new Float64Array(maximumLag + 1);
  const normalized = new Float64Array(maximumLag + 1);
  for (let lag = 1; lag <= maximumLag; lag++) {
    let sum = 0;
    for (let index = 0; index < count - lag; index += stride) {
      const delta = (samples[index] - mean) - (samples[index + lag] - mean);
      sum += delta * delta;
    }
    difference[lag] = sum;
  }
  let cumulative = 0;
  for (let lag = 1; lag <= maximumLag; lag++) {
    cumulative += difference[lag];
    normalized[lag] = cumulative > 1e-12 ? difference[lag] * lag / cumulative : 1;
  }
  const differenceThreshold = 1 - confidenceThreshold;
  let bestLag = 0;
  for (let lag = minimumLag; lag <= maximumLag; lag++) {
    if (normalized[lag] > differenceThreshold) continue;
    while (lag < maximumLag && normalized[lag + 1] < normalized[lag]) lag++;
    bestLag = lag;
    break;
  }
  if (!bestLag) return null;

  // Parabolic interpolation keeps a sub-sample estimate near note boundaries.
  const before = normalized[Math.max(1, bestLag - 1)];
  const center = normalized[bestLag];
  const after = normalized[Math.min(maximumLag, bestLag + 1)];
  const denominator = before - 2 * center + after;
  const correction = Math.abs(denominator) > 1e-9 ? Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / denominator)) : 0;
  const frequency = sampleRate / (bestLag + correction);
  const confidence = 1 - center;
  return Number.isFinite(frequency) && frequency >= minimumFrequency && frequency <= maximumFrequency
    ? { frequency, confidence, rms }
    : null;
}

export function chromaticSnapSemitones(frequency, reference = 440) {
  if (!Number.isFinite(frequency) || frequency <= 0 || !Number.isFinite(reference) || reference <= 0) return 0;
  const midi = Math.round(69 + 12 * Math.log2(frequency / reference));
  const target = reference * Math.pow(2, (midi - 69) / 12);
  return 12 * Math.log2(target / frequency);
}
