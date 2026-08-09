import { useEffect, useReducer } from 'react'
import { useCollab } from '@/state/collab'

/**
 * Ephemeral collaborator visuals over the timeline. Deliberately sparse:
 * a collaborator's cursor is their literal pointer (an arrow with a name)
 * plus a faint full-lane caret marking the beat they're over — what they
 * have selected or are doing in detail is never displayed, only the motion.
 * Isolated components so 20 Hz presence traffic re-renders only these
 * layers, never the timeline itself.
 */

interface OverlayProps {
  pxPerTick: number
  /** Content-space y of each track lane (automation lanes shift these). */
  trackTops: number[]
  /** Row height in px, so carets and pings match compact mode. */
  laneHeight: number
}

export function RemoteCursors({ pxPerTick, trackTops, laneHeight }: OverlayProps): React.JSX.Element {
  const collab = useCollab()
  const [, force] = useReducer((c: number) => c + 1, 0)
  // Sweep stale cursors even when no new presence arrives.
  useEffect(() => {
    const timer = setInterval(force, 2000)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      {collab.remoteCursors().map((cursor) => {
        const laneTop = trackTops[Math.min(cursor.trackIndex, trackTops.length - 1)] ?? 0
        // The literal pointer: yFrac places it within the lane. Older peers
        // don't send it; they keep the plain caret with the tag beside it.
        const hasPointer = cursor.yFrac !== undefined
        const pointerY = laneTop + Math.min(1.5, Math.max(0, cursor.yFrac ?? 0)) * laneHeight
        return (
          <div key={cursor.userId}>
            <div
              className={`remote-cursor ${hasPointer ? 'remote-cursor-quiet' : ''}`}
              style={{
                left: cursor.ticks * pxPerTick,
                top: laneTop,
                '--user-color': collab.colorFor(cursor.userId),
                '--lane-height': `${laneHeight}px`
              } as React.CSSProperties}
            >
              <div className="remote-cursor-caret" />
              {!hasPointer && (
                <div className="remote-cursor-tag">{collab.nameFor(cursor.userId)}</div>
              )}
            </div>
            {hasPointer && (
              <div
                className="remote-pointer"
                style={{
                  left: cursor.ticks * pxPerTick,
                  top: pointerY,
                  '--user-color': collab.colorFor(cursor.userId)
                } as React.CSSProperties}
              >
                <svg className="remote-pointer-arrow" viewBox="0 0 16 16" width="14" height="14">
                  <path d="M1 1 L6.5 14.5 L8.6 8.6 L14.5 6.5 Z" />
                </svg>
                <div className="remote-cursor-tag remote-pointer-tag">
                  {collab.nameFor(cursor.userId)}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

export function PingOverlay({ pxPerTick, trackTops, laneHeight }: OverlayProps): React.JSX.Element {
  const collab = useCollab()
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => {
    const timer = setInterval(force, 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      {collab
        .pings()
        // UI pings anchor to elements and are drawn by UiPings, not here.
        .filter((ping) => ping.uiTarget === undefined)
        .map((ping) => (
          <div
            key={ping.pingId}
            className="ping"
            style={{
              left: ping.ticks * pxPerTick,
              top:
                ping.trackIndex === null
                  ? 8
                  : (trackTops[Math.min(ping.trackIndex, trackTops.length - 1)] ?? 0) + laneHeight / 2,
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
