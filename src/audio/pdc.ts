import type { TrackId } from '@core/model/types'

/**
 * Plugin-delay compensation.
 *
 * A plugin that reports latency (a look-ahead limiter, a linear-phase EQ)
 * puts its track late by exactly that much. PDC delays everything else to
 * match, so the mix stays aligned. Nothing in SuperDAW did this before
 * live external inserts existed, because nothing in the graph reported any
 * latency: the builtin effects are Web Audio primitives, and Web Audio
 * reports none for them — not even for the compressor's internal 6 ms
 * look-ahead. Keeping builtins at zero here is therefore not an oversight
 * but the parity rule: bounces run through those same primitives, so
 * compensating something Web Audio does not compensate would make live
 * playback disagree with the bounce.
 *
 * This module is pure — tracks, parents, and one latency number each in;
 * two delay figures per track out — so the folder-bus reasoning can be
 * tested without a backend, and so the same answers are available to any
 * caller that needs them.
 *
 * ## Why two delays per track
 *
 * A track's chain input is fed by two different things: the track's OWN
 * sources, and every child track's output (folders ARE buses, so a child's
 * panner feeds its parent's chain input). Those need different amounts of
 * compensation, so one delay node cannot serve both.
 *
 *   depth(T)  = how late the LATEST thing arriving at T's input is, i.e.
 *               max over children C of (depth(C) + latency(C)); 0 with no
 *               children, since a track's own sources start on time.
 *   source(T) = depth(T)                  — T's own sources wait for them
 *   output(T) = depth(parent) − depth(T) − latency(T)
 *
 * `output` is applied AFTER the track's inserts, fader and pan, which is
 * the placement that preserves the relationship between a track's audio
 * and its own automation: delay the finished signal and its automation
 * envelope moves with it. `source` sits before the inserts because there
 * is nowhere later that could delay a folder's own material without also
 * delaying its children.
 */

export interface PdcTrack {
  readonly id: TrackId
  /** Folder bus this track feeds; null (or unknown) = master. */
  readonly parentId: TrackId | null
  /** Samples this track's own insert chain delays its signal by. */
  readonly latencySamples: number
}

export interface PdcDelays {
  /** Applied to the track's OWN sources, ahead of its inserts. */
  readonly sourceSamples: number
  /** Applied to the track's output, after pan, ahead of its bus. */
  readonly outputSamples: number
}

export interface PdcPlan {
  readonly byTrack: ReadonlyMap<TrackId, PdcDelays>
  /**
   * What the whole mix ends up delayed by — the deepest latent path. The
   * price of compensation, and what the drawn playhead has to account for.
   */
  readonly totalSamples: number
}

const ZERO: PdcDelays = { sourceSamples: 0, outputSamples: 0 }

export function computePdc(tracks: readonly PdcTrack[]): PdcPlan {
  const byId = new Map<TrackId, PdcTrack>()
  for (const track of tracks) byId.set(track.id, track)

  // A parentId naming a track that is not here routes to master, exactly
  // as the engine's own busFor() decides it.
  const parentOf = (track: PdcTrack): TrackId | null =>
    track.parentId !== null && byId.has(track.parentId) ? track.parentId : null

  const children = new Map<TrackId | null, PdcTrack[]>()
  for (const track of tracks) {
    const key = parentOf(track)
    const list = children.get(key)
    if (list) list.push(track)
    else children.set(key, [track])
  }

  const depths = new Map<TrackId, number>()
  const visiting = new Set<TrackId>()
  const depthOf = (id: TrackId | null): number => {
    if (id !== null) {
      const known = depths.get(id)
      if (known !== undefined) return known
      // A parent cycle cannot be dispatched, but a hostile document is not
      // a reason to hang: break it at zero rather than recurse forever.
      if (visiting.has(id)) return 0
      visiting.add(id)
    }
    let deepest = 0
    for (const child of children.get(id) ?? []) {
      deepest = Math.max(deepest, depthOf(child.id) + Math.max(0, child.latencySamples))
    }
    if (id !== null) {
      visiting.delete(id)
      depths.set(id, deepest)
    }
    return deepest
  }

  const totalSamples = depthOf(null)
  const byTrack = new Map<TrackId, PdcDelays>()
  for (const track of tracks) {
    const own = depthOf(track.id)
    const parentId = parentOf(track)
    const parentDepth = parentId === null ? totalSamples : depthOf(parentId)
    const output = parentDepth - own - Math.max(0, track.latencySamples)
    const delays: PdcDelays = {
      sourceSamples: own,
      // Never negative by construction (a parent's depth includes this
      // child's own path); clamped anyway so a hostile document cannot
      // ask for a negative delay.
      outputSamples: Math.max(0, output)
    }
    if (delays.sourceSamples !== 0 || delays.outputSamples !== 0) byTrack.set(track.id, delays)
  }
  return { byTrack, totalSamples }
}

/** A track's delays out of a plan, defaulting to none. */
export function pdcDelaysOf(plan: PdcPlan, trackId: TrackId): PdcDelays {
  return plan.byTrack.get(trackId) ?? ZERO
}
