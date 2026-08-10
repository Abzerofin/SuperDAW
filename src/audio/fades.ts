import type { Clip } from '@core/model/types'
import { clipFadeRamps, fadeCurve } from './scheduling'

/**
 * Applies a clip's fade envelope to a per-clip GainNode. Shared by the
 * live engine and the offline renderers so bounces match playback
 * exactly. The math (windows, raised-cosine curve) is pure and tested in
 * scheduling.ts; this file only talks to the AudioParam.
 */
export function applyClipFades(
  gain: AudioParam,
  clip: Clip,
  tempo: number,
  anchorTicks: number,
  anchorSec: number
): void {
  const ramps = clipFadeRamps(clip, tempo, anchorTicks, anchorSec)
  if (ramps.length === 0) return

  // Envelope value at the anchor: inside a ramp → its interpolated value;
  // otherwise 1 (sources are silent outside the clip window anyway).
  let atAnchor = 1
  for (const ramp of ramps) {
    if (anchorSec >= ramp.startSec && anchorSec < ramp.endSec) {
      const phase = (anchorSec - ramp.startSec) / (ramp.endSec - ramp.startSec)
      atAnchor = ramp.from + (ramp.to - ramp.from) * (1 - Math.cos(Math.PI * phase)) / 2
    } else if (anchorSec >= ramp.endSec) {
      atAnchor = ramp.to
    }
  }
  gain.setValueAtTime(atAnchor, anchorSec)

  for (const ramp of ramps) {
    if (ramp.endSec <= anchorSec) continue
    const start = Math.max(ramp.startSec, anchorSec)
    const phase0 = (start - ramp.startSec) / (ramp.endSec - ramp.startSec)
    try {
      gain.setValueCurveAtTime(fadeCurve(ramp.from, ramp.to, phase0), start, ramp.endSec - start)
    } catch {
      // Some engines reject a curve that abuts other events (the spec
      // allows an event exactly AT the curve start, but implementations
      // have differed). A linear ramp is an acceptable stand-in — and
      // infinitely better than letting the exception abort the whole
      // scheduling pass and silence the rest of the song.
      gain.linearRampToValueAtTime(ramp.to, ramp.endSec)
    }
  }
}
