import { useEffect } from 'react'

/**
 * Standard light-dismiss for menus and popovers: any pointerdown the
 * surface itself doesn't swallow (via stopPropagation) closes it, and so
 * does Escape. One hook so every menu in the app dismisses the same way.
 */
export function useDismiss(active: boolean, close: () => void): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
    // `close` is an inline arrow at every call site; re-subscribing per
    // render is cheap and keeps the captured state fresh.
  }, [active, close])
}
