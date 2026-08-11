import type { CSSProperties } from 'react'

/**
 * Fixed-position style for a right-click menu at a pointer point. Every
 * position property the base `.menu-panel` rule sets is overridden here —
 * top AND bottom — so the style works no matter which menu class it lands
 * on (a stylesheet `top` surviving under an inline `bottom` once pinned
 * the File Bay's menu below the viewport, reading as "right-click does
 * nothing").
 *
 * The menu opens downward while the estimated height fits the space under
 * the pointer, upward when it doesn't and there is more room above, and
 * scrolls internally when neither side can hold it. `estWidth`/`estHeight`
 * only steer the flip — a wrong guess degrades to a scrollbar, never to an
 * off-screen menu.
 */
export function contextMenuStyle(
  x: number,
  y: number,
  estWidth = 208,
  estHeight = 320
): CSSProperties {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const openUp = estHeight > vh - y - 8 && y > vh / 2
  return {
    position: 'fixed',
    left: Math.max(0, Math.min(x, vw - estWidth)),
    top: openUp ? 'auto' : y,
    bottom: openUp ? Math.max(8, vh - y + 2) : 'auto',
    maxHeight: openUp ? y - 6 : vh - y - 8,
    overflowY: 'auto'
  }
}
