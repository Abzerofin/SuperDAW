import { useEffect, useReducer } from 'react'
import { collab, useCollab } from '@/state/collab'
import { onMiddleClick } from '@/lib/middleMouse'

/**
 * Middle-CLICK pings for everything OUTSIDE the timeline grid (the grid
 * anchors its own pings to musical time). Any element carrying
 * `data-ping` (a human label) can be pinged; `data-ping-id` additionally
 * names a stable anchor so peers ring the same element in THEIR layout.
 * Titled controls with no data-ping fall back to a label-only ping.
 * Clicks arrive through lib/middleMouse, which separates them from
 * middle-DRAG panning and honors the Settings ping toggle.
 *
 * One component does both halves: the middle-click subscriber that SENDS,
 * and the fixed-position overlay that DRAWS anchored rings and label-only
 * notices.
 */

export function UiPings(): React.JSX.Element {
  const collabState = useCollab()
  const [, force] = useReducer((c: number) => c + 1, 0)
  // Anchored rings track their element, which can move (scroll, resize),
  // and pings expire on their own clock — tick while any are alive.
  useEffect(() => {
    if (collabState.pings().every((p) => p.uiTarget === undefined)) return
    const timer = setInterval(force, 400)
    return () => clearInterval(timer)
  })

  useEffect(
    () =>
      onMiddleClick(({ target }) => {
        const tagged = target.closest?.('[data-ping]')
        if (tagged) {
          collab.uiPing(
            tagged.getAttribute('data-ping-id'),
            tagged.getAttribute('data-ping') ?? 'here'
          )
          return true
        }
        // The timeline grid runs its own tick-anchored ping handler.
        if (target.closest?.('.timeline-grid')) return false
        const titled = target.closest?.('[title]') as HTMLElement | null
        const label = titled?.title.split(/[·.(—]/)[0].trim().slice(0, 48)
        if (!label) return false
        collab.uiPing(null, label)
        return true
      }),
    []
  )

  const uiPings = collabState.pings().filter((p) => p.uiTarget !== undefined)
  const loose: typeof uiPings = []
  const anchored: Array<{ ping: (typeof uiPings)[number]; x: number; y: number }> = []
  for (const ping of uiPings) {
    const el =
      typeof ping.uiTarget === 'string'
        ? document.querySelector(`[data-ping-id="${CSS.escape(ping.uiTarget)}"]`)
        : null
    const rect = el?.getBoundingClientRect()
    if (rect && rect.width > 0 && rect.height > 0) {
      anchored.push({ ping, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
    } else {
      // No anchor here (different layout, panel closed) — label still lands.
      loose.push(ping)
    }
  }

  return (
    <>
      {anchored.map(({ ping, x, y }) => (
        <div
          key={ping.pingId}
          className="ping ping-fixed"
          style={{ left: x, top: y, '--user-color': collab.colorFor(ping.userId) } as React.CSSProperties}
        >
          <div className="ping-ring" />
          <div className="ping-ring ping-ring-late" />
          <div className="ping-label">
            {collab.nameFor(ping.userId)} · {ping.label}
          </div>
        </div>
      ))}
      {loose.map((ping, i) => (
        <div
          key={ping.pingId}
          className="ping ping-fixed ping-loose"
          style={{
            left: '50%',
            bottom: 56 + i * 34,
            '--user-color': collab.colorFor(ping.userId)
          } as React.CSSProperties}
        >
          <div className="ping-label">
            {collab.nameFor(ping.userId)} · {ping.label}
          </div>
        </div>
      ))}
    </>
  )
}
