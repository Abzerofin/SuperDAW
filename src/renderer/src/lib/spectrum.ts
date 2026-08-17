import { FMAX, FMIN, freqToX, xToFreq } from './biquad'

/**
 * Pure layout math for the master spectrum analyzer popover: FFT bin ↔
 * log-frequency x position (20 Hz–20 kHz, same axis as the EQ curves) and
 * dB ↔ y, plus the peak-hold decay step. No canvas, no audio — everything
 * here is unit-testable headless; the popover only paints what these say.
 */

/** Display floor: getFloatFrequencyData readings below this pin to the bottom. */
export const SPECTRUM_FLOOR_DB = -90
/** Display ceiling (0 dBFS at the top edge). */
export const SPECTRUM_CEIL_DB = 0
/**
 * dB the peak-hold trace loses per painted frame — ~20 dB/s at 60 fps,
 * the classic slow-falling analyzer ghost.
 */
export const PEAK_DECAY_DB_PER_FRAME = 0.33

/** Center frequency of an FFT bin (binCount = fftSize / 2). */
export function binFrequency(bin: number, binCount: number, sampleRate: number): number {
  return (bin * (sampleRate / 2)) / binCount
}

/**
 * x position of an FFT bin on the log 20 Hz–20 kHz axis. Bins outside the
 * audible window clamp to the edges (bin 0 is DC — it pins to the left).
 */
export function binToX(bin: number, binCount: number, sampleRate: number, width: number): number {
  const f = Math.min(FMAX, Math.max(FMIN, binFrequency(bin, binCount, sampleRate)))
  return freqToX(f, width)
}

/**
 * Fractional FFT bin under an x position — the paint loop's per-column
 * lookup (interpolate between floor and ceil for a smooth low end, where
 * one pixel spans less than a bin). Clamped to the last real bin.
 */
export function xToBin(x: number, width: number, binCount: number, sampleRate: number): number {
  const bin = (xToFreq(x, width) / (sampleRate / 2)) * binCount
  return Math.min(binCount - 1, Math.max(0, bin))
}

/** y for a dB value: ceiling at the top, floor at the bottom, clamped. */
export function dbToY(db: number, height: number): number {
  const clamped = Math.min(SPECTRUM_CEIL_DB, Math.max(SPECTRUM_FLOOR_DB, db))
  return ((SPECTRUM_CEIL_DB - clamped) / (SPECTRUM_CEIL_DB - SPECTRUM_FLOOR_DB)) * height
}

/**
 * Advance the peak-hold trace one frame, in place: each column keeps the
 * larger of the live value and its previous value minus one frame of
 * decay. -Infinity live values (silent bins) simply let the hold fall.
 */
export function decayPeakHold(
  peaks: Float32Array,
  live: Float32Array,
  decayDb: number = PEAK_DECAY_DB_PER_FRAME
): void {
  for (let i = 0; i < peaks.length; i++) {
    const fallen = peaks[i] - decayDb
    peaks[i] = live[i] > fallen ? live[i] : fallen
  }
}
