import { useEffect, useRef } from 'react'
import { historyUi, useHistoryUi } from '@/state/historyUi'
import { ItemHistory } from './ItemHistory'

const POPOVER_W = 300

/**
 * The floating per-item history panel. One instance lives at the app
 * root; the clip menu, track menu and FX cards open it. Stays up while
 * entries are restored (so a few steps back is a few clicks), closes on
 * ×, Escape, or any click outside it.
 */
export function HistoryPopover(): React.JSX.Element | null {
  const target = useHistoryUi().current
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!target) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') historyUi.close()
    }
    const onPointerDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) historyUi.close()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [target])

  if (!target) return null

  const left = Math.max(8, Math.min(target.x, window.innerWidth - POPOVER_W - 8))
  const top = Math.max(8, Math.min(target.y, window.innerHeight - 120))

  return (
    <div className="history-popover" ref={ref} style={{ left, top, width: POPOVER_W }}>
      <div className="history-popover-head">
        <span className="history-popover-title" title={target.title}>
          History · {target.title}
        </span>
        <button
          className="proll-close"
          title="Close (Esc)"
          onClick={() => historyUi.close()}
        >
          ×
        </button>
      </div>
      <ItemHistory kind={target.kind} id={target.id} />
      <div className="history-popover-note statusbar-dim">
        This session&apos;s changes to this item — ↩ winds just it back.
      </div>
    </div>
  )
}
