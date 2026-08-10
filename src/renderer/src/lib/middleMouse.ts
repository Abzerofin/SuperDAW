import { preferences } from '@/state/preferences'

/**
 * One global middle-button policy:
 * - HOLDING the button and dragging pans whatever panel is under the
 *   pointer — any scroll container marked `data-pan` — regardless of the
 *   ping preference.
 * - A plain CLICK (press and release without moving) is a collaboration
 *   ping, when enabled in Settings ▸ General. Consumers (UiPings, the
 *   timeline grid) subscribe via onMiddleClick.
 */

const SLOP_PX = 4

export interface MiddleClick {
  readonly target: Element
  readonly clientX: number
  readonly clientY: number
}

type Handler = (click: MiddleClick) => boolean | void

const handlers = new Set<Handler>()

/** Register a middle-CLICK consumer. Returning true claims the click. */
export function onMiddleClick(handler: Handler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

/** Install the window-level listeners. Returns the uninstaller. */
export function installMiddleMouse(): () => void {
  let gesture: {
    pane: HTMLElement | null
    target: Element
    startX: number
    startY: number
    lastX: number
    lastY: number
    dragged: boolean
  } | null = null

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 1) return
    const target = e.target as Element
    gesture = {
      pane: (target.closest?.('[data-pan]') as HTMLElement | null) ?? null,
      target,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      dragged: false
    }
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (!gesture) return
    if (
      !gesture.dragged &&
      Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > SLOP_PX
    ) {
      gesture.dragged = true
      document.body.classList.add('middle-panning')
    }
    if (gesture.dragged && gesture.pane) {
      gesture.pane.scrollLeft -= e.clientX - gesture.lastX
      gesture.pane.scrollTop -= e.clientY - gesture.lastY
    }
    gesture.lastX = e.clientX
    gesture.lastY = e.clientY
  }

  const finish = (e: PointerEvent): void => {
    if (!gesture || e.button !== 1) return
    const g = gesture
    gesture = null
    document.body.classList.remove('middle-panning')
    if (!g.dragged && preferences.middleClickPing) {
      const click: MiddleClick = { target: g.target, clientX: e.clientX, clientY: e.clientY }
      for (const handler of handlers) if (handler(click) === true) break
    }
  }

  const onPointerCancel = (): void => {
    gesture = null
    document.body.classList.remove('middle-panning')
  }

  // Browsers arm middle-click autoscroll on MOUSEdown; preventing the
  // pointer event alone does not stop it everywhere.
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault()
  }

  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', finish, true)
  window.addEventListener('pointercancel', onPointerCancel, true)
  window.addEventListener('mousedown', onMouseDown, true)
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', finish, true)
    window.removeEventListener('pointercancel', onPointerCancel, true)
    window.removeEventListener('mousedown', onMouseDown, true)
    document.body.classList.remove('middle-panning')
  }
}
