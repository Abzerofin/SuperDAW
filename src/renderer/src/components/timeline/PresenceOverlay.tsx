import { useEffect, useReducer } from 'react'
import { useCollab } from '@/state/collab'
import { LANE_H } from './geometry'

/**
 * Ephemeral collaborator visuals over the timeline. Deliberately sparse:
 * a collaborator's cursor is a colored caret with a name — what they have
 * selected or are doing in detail is never displayed, only the motion.
 * Isolated components so 20 Hz presence traffic re-renders only these
 * layers, never the timeline itself.
 */

interface OverlayProps {
  pxPerTick: number
  /** Content-space y of each track lane (automation lanes shift these). */
  trackTops: number[]
}

export function RemoteCursors({ pxPerTick, trackTops }: OverlayProps): React.JSX.Element {
  const collab = useCollab()
  const [, force] = useReducer((c: number) => c + 1, 0)
  // Sweep stale cursors even when no new presence arrives.
  useEffect(() => {
    const timer = setInterval(force, 2000)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      {collab.remoteCursors().map((cursor) => (
        <div
          key={cursor.userId}
          className="remote-cursor"
          style={{
            left: cursor.ticks * pxPerTick,
            top: trackTops[Math.min(cursor.trackIndex, trackTops.length - 1)] ?? 0,
            '--user-color': collab.colorFor(cursor.userId)
          } as React.CSSProperties}
        >
          <div className="remote-cursor-caret" />
          <div className="remote-cursor-tag">{collab.nameFor(cursor.userId)}</div>
        </div>
      ))}
    </>
  )
}

export function PingOverlay({ pxPerTick, trackTops }: OverlayProps): React.JSX.Element {
  const collab = useCollab()
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => {
    const timer = setInterval(force, 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      {collab.pings().map((ping) => (
        <div
          key={ping.pingId}
          className="ping"
          style={{
            left: ping.ticks * pxPerTick,
            top:
              ping.trackIndex === null
                ? 8
                : (trackTops[Math.min(ping.trackIndex, trackTops.length - 1)] ?? 0) + LANE_H / 2,
            '--user-color': collab.colorFor(ping.userId)
          } as React.CSSProperties}
        >
          <div className="ping-ring" />
          <div className="ping-ring ping-ring-late" />
          <div className="ping-label">
            {collab.nameFor(ping.userId)} · {ping.label}
          </div>
        </div>
      ))}
    </>
  )
}
