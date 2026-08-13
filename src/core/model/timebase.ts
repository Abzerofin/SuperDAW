/**
 * Musical time is stored in integer ticks at a fixed resolution (PPQ).
 * Integer ticks avoid floating-point drift and make operations from
 * different collaborators deterministic on every peer.
 */
export const PPQ = 960 // ticks per quarter note

export type TimeSignature = readonly [beatsPerBar: number, beatUnit: number]

export function ticksPerBeat(timeSignature: TimeSignature): number {
  return (PPQ * 4) / timeSignature[1]
}

export function ticksPerBar(timeSignature: TimeSignature): number {
  return ticksPerBeat(timeSignature) * timeSignature[0]
}

export function beatsToTicks(beats: number): number {
  return Math.round(beats * PPQ)
}

export function barsToTicks(bars: number, timeSignature: TimeSignature): number {
  return Math.round(bars * ticksPerBar(timeSignature))
}

export function snapTicks(ticks: number, gridTicks: number): number {
  return Math.round(ticks / gridTicks) * gridTicks
}

/**
 * Formats seconds as "m:ss.mmm" — the transport readout in Min:Sec mode.
 * Truncates rather than rounds, so a counter never shows a time the
 * playhead has not reached yet.
 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, seconds)
  const minutes = Math.floor(total / 60)
  const rest = total - minutes * 60
  const secs = Math.floor(rest)
  const millis = Math.floor((rest - secs) * 1000)
  return `${minutes}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/** Formats a tick position as "bar.beat.tick", 1-based, e.g. "5.2.480". */
export function formatPosition(ticks: number, timeSignature: TimeSignature): string {
  const perBeat = ticksPerBeat(timeSignature)
  const perBar = ticksPerBar(timeSignature)
  const clamped = Math.max(0, ticks)
  const bar = Math.floor(clamped / perBar)
  const beat = Math.floor((clamped - bar * perBar) / perBeat)
  const rem = Math.round(clamped - bar * perBar - beat * perBeat)
  return `${bar + 1}.${beat + 1}.${String(rem).padStart(3, '0')}`
}
