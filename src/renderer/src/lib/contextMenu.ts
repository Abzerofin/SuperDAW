import type { CSSProperties } from 'react'

/**
 * Fixed-position style for a right-click menu at a pointer point. In the
 * lower part of the viewport the menu opens UPWARD — dock tabs and bay
 * tiles sit at the bottom of the screen, where a downward menu would be
 * clipped by the window edge — and it hugs the right edge when needed
 * (menus are min-width 200px, see .menu-panel).
 */
export function contextMenuStyle(x: number, y: number): CSSProperties {
  const openUp = y > window.innerHeight * 0.6
  return {
    left: Math.min(x, window.innerWidth - 208),
    ...(openUp ? { bottom: window.innerHeight - y + 2 } : { top: y })
  }
}
