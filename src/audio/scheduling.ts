import { PPQ, ticksPerBeat } from '@core/model/timebase'
import type { ProjectState } from '@core/model/types'

/**
 * Pure scheduling math: project state + a time anchor -> what to play when.
 * Kept free of Web Audio objects so it is exhaustively testable.
 *
 * The anchor maps musical time to clock time: `anchorTicks` plays at
 * `anchorSec` (AudioContext seconds), and the mapping is linear at the
 * current tempo. Re-anchoring happens on play/seek/tempo-change.
 */

export function ticksPerSecond(tempo: number): number {
  return (tempo / 60) * PPQ
}

export interface ClipSchedule {
  readonly clipId: string
  readonly assetId: string
  readonly trackId: string
  /** Absolute clock time to start the source, >= anchorSec. */
  readonly when: number
  /** Offset into the asset, in seconds. */
  readonly offsetSec: number
  /** How long to play, in seconds. */
  readonly durationSec: number
}

export function scheduleClips(
  state: ProjectState,
  assetSeconds: (assetId: string) => number | null,
  anchorTicks: number,
  anchorSec: number
): ClipSchedule[] {
  const tps = ticksPerSecond(state.tempo)
  const out: ClipSchedule[] = []

  for (const clip of Object.values(state.clips)) {
    if (clip.assetId === null) continue
    if (!state.tracks[clip.trackId]) continue
    const bufferSec = assetSeconds(clip.assetId)
    if (bufferSec === null) continue // asset not available (yet): stays silent

    const clipStartSec = anchorSec + (clip.start - anchorTicks) / tps
    const clipEndSec = anchorSec + (clip.start + clip.duration - anchorTicks) / tps
    if (clipEndSec <= anchorSec) continue // entirely in the past

    const baseOffsetSec = clip.offset / tps
    const lateBy = Math.max(0, anchorSec - clipStartSec)
    const offsetSec = baseOffsetSec + lateBy
    const durationSec = clipEndSec - Math.max(clipStartSec, anchorSec)
    const playableSec = Math.min(durationSec, bufferSec - offsetSec)
    if (playableSec <= 0) continue // trimmed past the end of the source material

    out.push({
      clipId: clip.id,
      assetId: clip.assetId,
      trackId: clip.trackId,
      when: Math.max(clipStartSec, anchorSec),
      offsetSec,
      durationSec: playableSec
    })
  }
  return out
}

export interface MetronomeClick {
  readonly when: number
  readonly isDownbeat: boolean
}

/**
 * Clicks whose clock time falls in [fromSec, toSec). `fromBeatIndex` is the
 * absolute beat number to start from; returns clicks plus the next unplayed
 * beat index so the caller can iterate window by window.
 */
export function metronomeClicks(
  state: ProjectState,
  anchorTicks: number,
  anchorSec: number,
  fromBeatIndex: number,
  fromSec: number,
  toSec: number
): { clicks: MetronomeClick[]; nextBeatIndex: number } {
  const tps = ticksPerSecond(state.tempo)
  const beatTicks = ticksPerBeat(state.timeSignature)
  const beatsPerBar = state.timeSignature[0]
  const clicks: MetronomeClick[] = []

  let beat = Math.max(fromBeatIndex, 0)
  for (;;) {
    const when = anchorSec + (beat * beatTicks - anchorTicks) / tps
    if (when >= toSec) break
    if (when >= fromSec) clicks.push({ when, isDownbeat: beat % beatsPerBar === 0 })
    beat++
  }
  return { clicks, nextBeatIndex: beat }
}

/** First beat index at or after the given tick position. */
export function beatIndexAt(state: ProjectState, ticks: number): number {
  return Math.ceil(ticks / ticksPerBeat(state.timeSignature))
}
