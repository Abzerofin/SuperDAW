import type { Clip } from '@core/model/types'
import { applyParamEvents, type ParamEvent } from './backend'
import { clipFadeRamps, fadeCurve } from './scheduling'

/**
 * A clip's fade envelope as backend param events — the currency the
 * engine schedules through IAudioBackend — with `applyClipFades` kept as
 * the direct-AudioParam form for the offline renderers (render.ts stays
 * on Web Audio permanently; both forms share applyParamEvents, so bounces
 * match playback exactly). The math (windows, raised-cosine curve) is
 * pure and tested in scheduling.ts.
 */
export function clipFadeEvents(
  clip: Clip,
  tempo: number,
  anchorTicks: number,
  anchorSec: number
): ParamEvent[] {
  const ramps = clipFadeRamps(clip, tempo, anchorTicks, anchorSec)
  if (ramps.length === 0) return []

  // Envelope value at the anchor: inside a ramp → its interpolated value;
  // otherwise 1 (sources are silent outside the clip window anyway).
  let atAnchor = 1
  for (const ramp of ramps) {
    if (anchorSec >= ramp.startSec && anchorSec < ramp.endSec) {
      const phase = (anchorSec - ramp.startSec) / (ramp.endSec - ramp.startSec)
      atAnchor = ramp.from + ((ramp.to - ramp.from) * (1 - Math.cos(Math.PI * phase))) / 2
    } else if (anchorSec >= ramp.endSec) {
      atAnchor = ramp.to
    }
  }
  const events: ParamEvent[] = [{ kind: 'setValue', value: atAnchor, time: anchorSec }]

  for (const ramp of ramps) {
    if (ramp.endSec <= anchorSec) continue
    const start = Math.max(ramp.startSec, anchorSec)
    const phase0 = (start - ramp.startSec) / (ramp.endSec - ramp.startSec)
    // The curve-vs-abutting-events quirk (some engines reject a curve that
    // abuts other events) is handled in applyParamEvents' setCurve case.
    events.push({
      kind: 'setCurve',
      curve: fadeCurve(ramp.from, ramp.to, phase0),
      time: start,
      duration: ramp.endSec - start
    })
  }
  return events
}

/** Direct-AudioParam form, for the offline render graph. */
export function applyClipFades(
  gain: AudioParam,
  clip: Clip,
  tempo: number,
  anchorTicks: number,
  anchorSec: number
): void {
  applyParamEvents(gain, clipFadeEvents(clip, tempo, anchorTicks, anchorSec))
}
