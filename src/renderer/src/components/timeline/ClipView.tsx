import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Clip } from '@core/model/types'
import { ticksPerSecond } from '@audio/scheduling'
import type { ProjectAsset } from '@audio/assets'
import { assetStore } from '@/state/audioInstance'
import { LANE_H } from './geometry'

interface Props {
  clip: Clip
  trackColor: string
  trackIndex: number
  /** Preview overrides while this clip is being dragged. */
  preview: { start: number; duration: number; offset: number; trackIndex: number } | null
  selected: boolean
  dimmed: boolean
  pxPerTick: number
  tempo: number
  /** Open (unresolved) comment threads on this clip. */
  commentCount: number
  onPointerDown: (e: React.PointerEvent, mode: 'move' | 'resize-l' | 'resize-r') => void
  onOpenComments: () => void
}

export function ClipView({
  clip,
  trackColor,
  trackIndex,
  preview,
  selected,
  dimmed,
  pxPerTick,
  tempo,
  commentCount,
  onPointerDown,
  onOpenComments
}: Props): React.JSX.Element {
  const start = preview?.start ?? clip.start
  const duration = preview?.duration ?? clip.duration
  const offset = preview?.offset ?? clip.offset
  const lane = preview?.trackIndex ?? trackIndex
  const color = clip.color ?? trackColor

  const asset = useSyncExternalStore(assetStore.subscribe, () =>
    clip.assetId ? assetStore.get(clip.assetId) : undefined
  )

  const width = Math.max(4, duration * pxPerTick - 1)
  const height = LANE_H - 8

  return (
    <div
      className={`clip ${selected ? 'clip-selected' : ''} ${preview ? 'clip-dragging' : ''} ${
        dimmed ? 'clip-dimmed' : ''
      }`}
      style={{
        left: start * pxPerTick,
        top: lane * LANE_H + 4,
        width,
        height,
        '--clip-color': color
      } as React.CSSProperties}
      onPointerDown={(e) => onPointerDown(e, 'move')}
    >
      {asset?.peaks && (
        <Waveform asset={asset} width={width} height={height} offset={offset} duration={duration} tempo={tempo} />
      )}
      <div className="clip-name">
        {clip.name}
        {clip.assetId !== null && !asset && <span className="clip-downloading"> · downloading…</span>}
      </div>
      {commentCount > 0 && (
        <button
          className="clip-comments"
          title="View comments"
          onPointerDown={(e) => {
            e.stopPropagation()
            onOpenComments()
          }}
        >
          {commentCount}
        </button>
      )}
      <div className="clip-handle clip-handle-l" onPointerDown={(e) => onPointerDown(e, 'resize-l')} />
      <div className="clip-handle clip-handle-r" onPointerDown={(e) => onPointerDown(e, 'resize-r')} />
    </div>
  )
}

interface WaveformProps {
  asset: ProjectAsset
  width: number
  height: number
  offset: number
  duration: number
  tempo: number
}

function Waveform({ asset, width, height, offset, duration, tempo }: WaveformProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    canvas.width = w
    canvas.height = h
    const g = canvas.getContext('2d')
    if (!g) return

    const peaks = asset.peaks
    if (!peaks) return
    const tps = ticksPerSecond(tempo)
    const fromSec = offset / tps
    const spanSec = duration / tps
    const mid = h / 2
    const amp = mid - 2

    g.clearRect(0, 0, w, h)
    g.fillStyle = 'rgba(255, 255, 255, 0.55)'
    for (let x = 0; x < w; x++) {
      const sec = fromSec + (x / w) * spanSec
      const bucket = Math.floor(sec * asset.peaksPerSecond)
      if (bucket < 0 || bucket * 2 + 1 >= peaks.length) continue // silence past source end
      const min = peaks[bucket * 2]
      const max = peaks[bucket * 2 + 1]
      g.fillRect(x, mid - max * amp, 1, Math.max(1, (max - min) * amp))
    }
  }, [asset, width, height, offset, duration, tempo])

  return <canvas ref={canvasRef} className="clip-wave" />
}
