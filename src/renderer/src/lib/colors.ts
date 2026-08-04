/** Muted, professional track color palette. Assigned round-robin. */
export const TRACK_COLORS = [
  '#e8875b', // orange
  '#5b8def', // blue
  '#6fbf73', // green
  '#c678dd', // purple
  '#56b6c2', // teal
  '#d19a66', // amber
  '#e06c75', // red
  '#98c379' // lime
] as const

export function nextTrackColor(existingCount: number): string {
  return TRACK_COLORS[existingCount % TRACK_COLORS.length]
}
