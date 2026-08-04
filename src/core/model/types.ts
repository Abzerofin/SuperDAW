import type { TimeSignature } from './timebase'

export type TrackId = string
export type ClipId = string
export type TrackKind = 'audio' | 'midi'

export interface Clip {
  readonly id: ClipId
  readonly trackId: TrackId
  readonly name: string
  /** Timeline position in ticks. */
  readonly start: number
  /** Length in ticks. */
  readonly duration: number
  /**
   * Audio asset this clip plays, or null (empty/MIDI clip). Asset binary
   * data is a separate system from project state (see ARCHITECTURE.md);
   * the document only ever references assets by id.
   */
  readonly assetId: string | null
  /** Offset into the source material, in ticks (grows when trimming the left edge). */
  readonly offset: number
  /** null = inherit the track color. */
  readonly color: string | null
}

export interface Track {
  readonly id: TrackId
  readonly kind: TrackKind
  readonly name: string
  readonly color: string
  readonly muted: boolean
  readonly soloed: boolean
}

export interface ProjectState {
  readonly name: string
  readonly tempo: number
  readonly timeSignature: TimeSignature
  readonly tracks: Readonly<Record<TrackId, Track>>
  readonly trackOrder: readonly TrackId[]
  readonly clips: Readonly<Record<ClipId, Clip>>
}

export function createEmptyProject(name: string): ProjectState {
  return {
    name,
    tempo: 120,
    timeSignature: [4, 4],
    tracks: {},
    trackOrder: [],
    clips: {}
  }
}

export function clipsOfTrack(state: ProjectState, trackId: TrackId): Clip[] {
  return Object.values(state.clips).filter((c) => c.trackId === trackId)
}
