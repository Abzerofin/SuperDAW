import { itemHistory, useItemHistory, type HistoryKind } from '@/state/itemHistory'

/**
 * One item's session history: every state it moved through since the
 * project was opened, newest first, each with a ↩ that winds JUST this
 * item back (one ordinary op — undoable, synced). Shown inside the clip
 * menu, the track menu and FX cards.
 */
export function ItemHistory({
  kind,
  id,
  onRestored
}: {
  kind: HistoryKind
  id: string
  onRestored?: () => void
}): React.JSX.Element {
  const store = useItemHistory()
  const entries = store.historyOf(kind, id)

  if (entries.length === 0) {
    return <div className="item-history-empty">No changes this session.</div>
  }

  return (
    <div className="item-history">
      {entries.map((entry, i) => (
        <div key={`${entry.time}:${i}`} className="item-history-row">
          <span className="item-history-time mono">
            {new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span className="item-history-label" title={entry.label}>
            {entry.label}
          </span>
          <button
            className="item-history-restore"
            title="Wind this item back to how it was BEFORE this change"
            onClick={() => {
              itemHistory.restore(kind, id, entry)
              onRestored?.()
            }}
          >
            ↩
          </button>
        </div>
      ))}
    </div>
  )
}
