/**
 * Lets chrome outside the timeline (transport bar, palette) ask the
 * timeline to scroll somewhere. Ephemeral per-user view state — the
 * timeline registers itself while mounted and applies requests directly.
 */

type ScrollRequestListener = (ticks: number) => void

class TimelineViewport {
  private listeners = new Set<ScrollRequestListener>()

  onScrollRequest(listener: ScrollRequestListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Bring the given position into view (left-aligned). */
  scrollTo(ticks: number): void {
    for (const listener of this.listeners) listener(ticks)
  }
}

export const timelineViewport = new TimelineViewport()
