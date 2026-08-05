import { useActivity } from '@/state/hooks'
import { useCollab } from '@/state/collab'

export function ActivityFeed(): React.JSX.Element {
  const activity = useActivity()
  const collab = useCollab()
  const newestFirst = [...activity].reverse()

  return (
    <aside className="activity">
      <div className="activity-header">Activity</div>
      <div className="activity-list">
        {newestFirst.length === 0 && <div className="activity-empty">No activity yet</div>}
        {newestFirst.map((entry) => (
          <div className="activity-entry" key={entry.id}>
            <div className="activity-meta">
              <span className="activity-user" style={{ color: collab.colorFor(entry.userId) }}>
                {collab.nameFor(entry.userId)}
              </span>
              <span className="activity-time mono">{formatTime(entry.time)}</span>
            </div>
            <div className="activity-text">{entry.text}</div>
          </div>
        ))}
      </div>
    </aside>
  )
}

function formatTime(time: number): string {
  const d = new Date(time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
