import type { Clip } from '@core/model/types'
import { LANE_H } from './geometry'

interface Props {
  clip: Clip
  trackColor: string
  trackIndex: number
  /** Preview overrides while this clip is being dragged. */
  preview: { start: number; duration: number; trackIndex: number } | null
  selected: boolean
  dimmed: boolean
  pxPerTick: number
  onPointerDown: (e: React.PointerEvent, mode: 'move' | 'resize-l' | 'resize-r') => void
}

export function ClipView({
  clip,
  trackColor,
  trackIndex,
  preview,
  selected,
  dimmed,
  pxPerTick,
  onPointerDown
}: Props): React.JSX.Element {
  const start = preview?.start ?? clip.start
  const duration = preview?.duration ?? clip.duration
  const lane = preview?.trackIndex ?? trackIndex
  const color = clip.color ?? trackColor

  return (
    <div
      className={`clip ${selected ? 'clip-selected' : ''} ${preview ? 'clip-dragging' : ''} ${
        dimmed ? 'clip-dimmed' : ''
      }`}
      style={{
        left: start * pxPerTick,
        top: lane * LANE_H + 4,
        width: Math.max(4, duration * pxPerTick - 1),
        height: LANE_H - 8,
        '--clip-color': color
      } as React.CSSProperties}
      onPointerDown={(e) => onPointerDown(e, 'move')}
    >
      <div className="clip-name">{clip.name}</div>
      <div className="clip-handle clip-handle-l" onPointerDown={(e) => onPointerDown(e, 'resize-l')} />
      <div className="clip-handle clip-handle-r" onPointerDown={(e) => onPointerDown(e, 'resize-r')} />
    </div>
  )
}
