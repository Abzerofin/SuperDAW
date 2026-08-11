import { PPQ, ticksPerBeat } from '@core/model/timebase'
import type { Clip, ProjectState } from '@core/model/types'
import { clipRate, isClipLooped } from '@core/model/types'
import { synthIsAudible } from '@core/model/effects'

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
  /**
   * Offset into the buffer, in BUFFER seconds. For a reversed clip this is
   * measured in the reversed copy of the asset (see `reverse`).
   */
  readonly offsetSec: number
  /**
   * How much BUFFER material to consume, in buffer seconds. Real elapsed
   * time is `durationSec / rate`, which is the clip's timeline window.
   */
  readonly durationSec: number
  /** Playback rate (resampling): pitch and stretch combined. 1 = untouched. */
  readonly rate: number
  /** Play from the reversed copy of the asset. */
  readonly reverse: boolean
}

/** One repeat of a looped clip, as its own timeline window. */
export interface ClipSegment {
  /** Absolute timeline start, in ticks. */
  readonly start: number
  /** Ticks of this repeat (the final one may be cut short by the clip end). */
  readonly duration: number
}

/**
 * A clip as the list of timeline windows it actually plays: one window for
 * an ordinary clip, one per repeat for a looped clip. Every window replays
 * the SAME material from the clip's offset — this is the single definition
 * of looping shared by the engine, the offline render and the UI preview.
 */
export function clipSegments(clip: Clip): ClipSegment[] {
  if (!isClipLooped(clip)) return [{ start: clip.start, duration: clip.duration }]
  const out: ClipSegment[] = []
  for (let into = 0; into < clip.duration; into += clip.loopLength) {
    out.push({
      start: clip.start + into,
      duration: Math.min(clip.loopLength, clip.duration - into)
    })
  }
  return out
}

/**
 * Bounds on which sources a pass INCLUDES, by their start tick — the
 * windowed (linear, non-cycling) scheduler's primitive. Unlike
 * `untilTicks`, a window never cuts material: a source starting inside the
 * window plays to its natural end, so the horizon can advance in slices
 * without ever splitting a note or a clip across a seam. Slices partition
 * the timeline exactly (start ∈ [startFromTicks, startBeforeTicks)), so a
 * source is scheduled by exactly one slice.
 */
export interface ScheduleWindow {
  /**
   * Only sources starting at/after this tick. Omitted on the initial pass
   * so material already sounding at the anchor is picked up (with the
   * usual mid-source offset); set on top-up slices, which must not
   * re-schedule what previous passes already queued.
   */
  readonly startFromTicks?: number
  /** Only sources starting before this tick (the lookahead horizon). */
  readonly startBeforeTicks: number
}

/**
 * Upcoming clip sources.
 *
 * `untilTicks` bounds the pass at a musical position — the loop region's
 * end when cycling, so one iteration's sources never bleed past the wrap
 * point (see AudioEngine's loop scheduling). `window`, by contrast, bounds
 * which sources START in this pass without cutting their material — the
 * two are used by different scheduling modes and never combined.
 */
export function scheduleClips(
  state: ProjectState,
  assetSeconds: (assetId: string) => number | null,
  anchorTicks: number,
  anchorSec: number,
  untilTicks = Number.POSITIVE_INFINITY,
  window?: ScheduleWindow
): ClipSchedule[] {
  const tps = ticksPerSecond(state.tempo)
  const out: ClipSchedule[] = []

  // Frozen tracks play their pre-rendered asset as one source from tick 0
  // (the render bakes clips, notes, inserts and volume automation), which
  // is the entire CPU point of freezing. As one long source "starting" at
  // tick 0 it belongs to the initial windowed pass only — top-up slices
  // (start bound > 0) must not schedule it again.
  const frozenInWindow =
    window === undefined ||
    ((window.startFromTicks ?? Number.NEGATIVE_INFINITY) <= 0 && window.startBeforeTicks > 0)
  for (const track of Object.values(state.tracks)) {
    if (!track.frozenAssetId || !frozenInWindow) continue
    const bufferSec = assetSeconds(track.frozenAssetId)
    if (bufferSec === null) continue // still transferring: silent until it lands
    const startSec = anchorSec + (0 - anchorTicks) / tps
    if (startSec + bufferSec <= anchorSec) continue
    const lateBy = Math.max(0, anchorSec - startSec)
    // A bounded pass (loop iteration) cuts the render at the region's end.
    const limitSec = anchorSec + (untilTicks - anchorTicks) / tps
    const playable = Math.min(bufferSec - lateBy, limitSec - Math.max(startSec, anchorSec))
    if (playable <= 0) continue
    out.push({
      clipId: `frozen:${track.id}`,
      assetId: track.frozenAssetId,
      trackId: track.id,
      when: Math.max(startSec, anchorSec),
      offsetSec: lateBy,
      durationSec: playable,
      // The render already baked in every clip's playback settings.
      rate: 1,
      reverse: false
    })
  }
  const limitSec = anchorSec + (untilTicks - anchorTicks) / tps

  for (const clip of Object.values(state.clips)) {
    if (clip.assetId === null) continue
    const track = state.tracks[clip.trackId]
    if (!track || track.frozenAssetId !== null) continue // frozen: render replaces live clips
    const bufferSec = assetSeconds(clip.assetId)
    if (bufferSec === null) continue // asset not available (yet): stays silent

    // Pitch/stretch resample, so timeline seconds and buffer seconds differ
    // by `rate`: covering T seconds of timeline consumes T * rate of buffer.
    const rate = clipRate(clip)

    // A looped clip is scheduled as one source per repeat; each replays the
    // same material from the clip's offset in its own timeline window.
    for (const segment of clipSegments(clip)) {
      // Windowed pass: each repeat is its own source with its own start, so
      // the window admits repeats individually — exactly one slice each.
      if (
        window !== undefined &&
        (segment.start < (window.startFromTicks ?? Number.NEGATIVE_INFINITY) ||
          segment.start >= window.startBeforeTicks)
      ) {
        continue
      }
      const segStartSec = anchorSec + (segment.start - anchorTicks) / tps
      const segEndSec = anchorSec + (segment.start + segment.duration - anchorTicks) / tps
      if (segEndSec <= anchorSec) continue // entirely in the past
      if (segStartSec >= limitSec) continue // beyond this pass's window

      // The segment's whole region in the buffer, before any lateness.
      const regionOffsetSec = (clip.offset / tps) * rate
      const wantedSec = (Math.min(segEndSec, limitSec) - segStartSec) * rate
      const regionLengthSec = Math.min(wantedSec, bufferSec - regionOffsetSec)
      if (regionLengthSec <= 0) continue // trimmed past the end of the source material

      // Starting mid-segment skips proportionally more buffer material.
      const lateBufferSec = Math.max(0, anchorSec - segStartSec) * rate
      const playableSec = regionLengthSec - lateBufferSec
      if (playableSec <= 0) continue

      // Reversed clips read the same region out of the mirrored copy, so the
      // region's start counts back from the end of the buffer.
      const offsetSec = clip.reverse
        ? bufferSec - regionOffsetSec - regionLengthSec + lateBufferSec
        : regionOffsetSec + lateBufferSec

      out.push({
        clipId: clip.id,
        assetId: clip.assetId,
        trackId: clip.trackId,
        when: Math.max(segStartSec, anchorSec),
        offsetSec: Math.max(0, offsetSec),
        durationSec: playableSec,
        rate,
        reverse: clip.reverse
      })
    }
  }
  return out
}

// ---------- Track loops (per-user audition; see AudioEngine) ----------

export interface TrackLoopSpan {
  /** Timeline extent of the track's clips, in ticks. */
  readonly start: number
  readonly end: number
}

/** The region a track loop repeats: the extent of the track's clips. */
export function trackLoopSpan(state: ProjectState, trackId: string): TrackLoopSpan | null {
  let start = Number.POSITIVE_INFINITY
  let end = 0
  for (const clip of Object.values(state.clips)) {
    if (clip.trackId !== trackId) continue
    start = Math.min(start, clip.start)
    end = Math.max(end, clip.start + clip.duration)
  }
  if (!Number.isFinite(start) || end <= start) return null
  return { start, end }
}

/**
 * One ghost repeat of a looping track: a state holding ONLY that track's
 * clips, shifted `shiftTicks` later. Notes ride along (they are
 * clip-relative), every other track drops out, and automation is cleared —
 * it stays on the real timeline rather than repeating. Feeding this
 * through the ordinary schedule functions is what keeps track loops and
 * normal playback mathematically identical.
 */
export function trackLoopRepeatState(
  state: ProjectState,
  trackId: string,
  shiftTicks: number
): ProjectState {
  const track = state.tracks[trackId]
  const clips: Record<string, Clip> = {}
  for (const clip of Object.values(state.clips)) {
    if (clip.trackId === trackId) clips[clip.id] = { ...clip, start: clip.start + shiftTicks }
  }
  return {
    ...state,
    tracks: track ? { [trackId]: track } : {},
    clips,
    automation: {}
  }
}

/**
 * One repeat of a pad-launched clip loop: a state holding ONLY that clip,
 * moved so its material starts `atTicks`. Notes ride along (clip-relative),
 * every other clip and track drops out, and automation stays on the real
 * timeline (cleared here). Same trick as trackLoopRepeatState: feeding this
 * through the ordinary schedule functions keeps pad launches mathematically
 * identical to normal playback — inserts, fades, per-clip looping included.
 */
export function padClipRepeatState(
  state: ProjectState,
  clipId: string,
  atTicks: number
): ProjectState {
  const clip = state.clips[clipId]
  const track = clip ? state.tracks[clip.trackId] : undefined
  return {
    ...state,
    tracks: track ? { [track.id]: track } : {},
    clips: clip ? { [clipId]: { ...clip, start: atTicks } } : {},
    automation: {}
  }
}

export interface NoteSchedule {
  readonly trackId: string
  /** Owning clip — lets the engine route the voice through its fade envelope. */
  readonly clipId: string
  readonly pitch: number
  /** Normalized 0..1 from MIDI velocity. */
  readonly velocity: number
  /** Absolute clock time, >= anchorSec. */
  readonly startSec: number
  readonly endSec: number
}

/**
 * Upcoming synth notes. Note times are clip-relative; notes are clipped to
 * their clip's window (shortening a clip mutes notes past its end) and, when
 * given, to `untilTicks` — the loop region's end while cycling. A note
 * already sounding at the anchor restarts from its attack — acceptable
 * chase behavior for a synth.
 */
export function scheduleNotes(
  state: ProjectState,
  anchorTicks: number,
  anchorSec: number,
  untilTicks = Number.POSITIVE_INFINITY,
  window?: ScheduleWindow
): NoteSchedule[] {
  const tps = ticksPerSecond(state.tempo)
  const out: NoteSchedule[] = []

  // Segments per clip, computed once per pass — a looped clip's tiling is
  // identical for all of its notes, and recomputing it per note made a
  // busy looped MIDI track allocate segment lists in the hundreds of
  // thousands per scheduling pass.
  const segmentsByClip = new Map<string, ReturnType<typeof clipSegments>>()

  for (const note of Object.values(state.notes)) {
    const clip = state.clips[note.clipId]
    if (!clip) continue
    const track = state.tracks[clip.trackId]
    if (!track || track.kind !== 'midi') continue
    if (track.frozenAssetId !== null) continue // frozen: the render replaces the synth
    // Removed or bypassed instrument: the notes stay in the document, they
    // just make no sound. Gated here so playback and offline renders agree.
    if (!synthIsAudible(track.synth)) continue

    let segments = segmentsByClip.get(clip.id)
    if (!segments) segmentsByClip.set(clip.id, (segments = clipSegments(clip)))

    // A looped clip plays its notes once per repeat; a note is cut at its
    // segment's end just as it is cut at an ordinary clip's end.
    for (const segment of segments) {
      if (note.start >= segment.duration) continue // past this repeat's window
      const absStart = segment.start + note.start
      // Windowed pass: a note plays in the slice its START falls in, and
      // rings to its natural end — never re-attacked at a horizon seam.
      if (
        window !== undefined &&
        (absStart < (window.startFromTicks ?? Number.NEGATIVE_INFINITY) ||
          absStart >= window.startBeforeTicks)
      ) {
        continue
      }
      const absEnd = Math.min(absStart + note.duration, segment.start + segment.duration, untilTicks)
      if (absEnd <= absStart) continue // entirely past the segment end / window
      if (absEnd <= anchorTicks) continue // in the past
      if (absStart >= untilTicks) continue // starts beyond this pass's window

      out.push({
        trackId: track.id,
        clipId: clip.id,
        pitch: note.pitch,
        velocity: note.velocity / 127,
        startSec: anchorSec + (Math.max(absStart, anchorTicks) - anchorTicks) / tps,
        endSec: anchorSec + (absEnd - anchorTicks) / tps
      })
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec)
}

// ---------- Clip fades (pure math; applied by audio/fades.ts) ----------

/**
 * Fade lengths clamped against the clip's CURRENT duration. The document
 * may hold larger values after a shrink (clip/resize deliberately leaves
 * fades untouched so undo restores them exactly); consumers always clamp.
 */
export function effectiveFades(clip: Clip): { fadeInTicks: number; fadeOutTicks: number } {
  const fadeInTicks = Math.min(Math.max(0, clip.fadeIn), clip.duration)
  const fadeOutTicks = Math.min(Math.max(0, clip.fadeOut), clip.duration - fadeInTicks)
  return { fadeInTicks, fadeOutTicks }
}

export interface FadeRamp {
  /** Absolute clock time the ramp starts/ends. */
  readonly startSec: number
  readonly endSec: number
  readonly from: number
  readonly to: number
}

/** A clip's fade envelope as absolute-clock ramps (0–2 entries). */
export function clipFadeRamps(
  clip: Clip,
  tempo: number,
  anchorTicks: number,
  anchorSec: number
): FadeRamp[] {
  const { fadeInTicks, fadeOutTicks } = effectiveFades(clip)
  if (fadeInTicks <= 0 && fadeOutTicks <= 0) return []
  const tps = ticksPerSecond(tempo)
  const at = (ticks: number): number => anchorSec + (ticks - anchorTicks) / tps
  const ramps: FadeRamp[] = []
  if (fadeInTicks > 0) {
    ramps.push({ startSec: at(clip.start), endSec: at(clip.start + fadeInTicks), from: 0, to: 1 })
  }
  const end = clip.start + clip.duration
  if (fadeOutTicks > 0) {
    ramps.push({ startSec: at(end - fadeOutTicks), endSec: at(end), from: 1, to: 0 })
  }
  return ramps
}

/**
 * Raised-cosine segment for a fade ramp starting at phase `phase0` (0..1,
 * for ramps already underway at the anchor). Smooth and click-free at both
 * ends — the "smooth curve" a linear ramp is not.
 */
export function fadeCurve(from: number, to: number, phase0 = 0, samples = 33): Float32Array {
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) {
    const phase = phase0 + ((1 - phase0) * i) / (samples - 1)
    const shaped = (1 - Math.cos(Math.PI * phase)) / 2
    out[i] = from + (to - from) * shaped
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
