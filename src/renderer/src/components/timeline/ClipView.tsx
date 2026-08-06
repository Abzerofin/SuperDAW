import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Clip, Note } from '@core/model/types'
import { clipRate, MIN_LOOP_TICKS } from '@core/model/types'
import { effectiveFades, ticksPerSecond } from '@audio/scheduling'
import type { ProjectAsset } from '@audio/assets'
import { assetStore } from '@/state/audioInstance'
import { projectStore } from '@/state/projectStore'
import { capturePointer } from '@/lib/pointer'

interface Props {
  clip: Clip
  trackColor: string
  trackIndex: number
  /** Preview overrides while this clip is being dragged. */
  preview: {
    start: number
    duration: number
    offset: number
    loopLength: number
    stretch: number
    trackIndex: number
  } | null
  selected: boolean
  dimmed: boolean
  pxPerTick: number
  tempo: number
  /** Content-space y of each track lane (automation lanes shift these). */
  laneTops: number[]
  /** Row height in px (compact mode shrinks it). */
  laneHeight: number
  /** Open (unresolved) comment threads on this clip. */
  commentCount: number
  /** This clip's notes (MIDI clips); empty for audio. */
  notes: Note[]
  /** Fade handles are shown and draggable (audio clip on an unfrozen track). */
  fadesEditable: boolean
  onPointerDown: (
    e: React.PointerEvent,
    mode: 'move' | 'resize-l' | 'resize-r' | 'loop-r' | 'stretch-r'
  ) => void
  onOpenComments: () => void
  /** Right-click: the clip menu (slice, reverse, pitch, length, colour). */
  onContextMenu: (e: React.MouseEvent) => void
  /** Double-click action (MIDI: open the piano roll). */
  onOpenEditor?: () => void
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
  laneTops,
  laneHeight,
  commentCount,
  notes,
  fadesEditable,
  onPointerDown,
  onOpenComments,
  onContextMenu,
  onOpenEditor
}: Props): React.JSX.Element {
  const start = preview?.start ?? clip.start
  const duration = preview?.duration ?? clip.duration
  const offset = preview?.offset ?? clip.offset
  const loopLength = preview?.loopLength ?? clip.loopLength
  const stretch = preview?.stretch ?? clip.stretch
  const lane = preview?.trackIndex ?? trackIndex
  const color = clip.color ?? trackColor
  const looped = loopLength >= MIN_LOOP_TICKS && loopLength < duration
  const repeats = looped ? duration / loopLength : 1

  const asset = useSyncExternalStore(assetStore.subscribe, () =>
    clip.assetId ? assetStore.get(clip.assetId) : undefined
  )

  const width = Math.max(4, duration * pxPerTick - 1)
  const height = laneHeight - 8


  // Fade handle drag: local preview, ONE clip/setFades op on release.
  const [fadeDrag, setFadeDrag] = useState<{
    side: 'in' | 'out'
    originX: number
    origTicks: number
    ticks: number
  } | null>(null)
  const stored = effectiveFades({ ...clip, duration })
  const fadeInTicks =
    fadeDrag?.side === 'in' ? fadeDrag.ticks : stored.fadeInTicks
  const fadeOutTicks =
    fadeDrag?.side === 'out' ? fadeDrag.ticks : stored.fadeOutTicks

  const beginFadeDrag = (e: React.PointerEvent, side: 'in' | 'out'): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    capturePointer(e)
    setFadeDrag({
      side,
      originX: e.clientX,
      origTicks: side === 'in' ? stored.fadeInTicks : stored.fadeOutTicks,
      ticks: side === 'in' ? stored.fadeInTicks : stored.fadeOutTicks
    })
  }
  const moveFadeDrag = (e: React.PointerEvent): void => {
    if (!fadeDrag) return
    e.stopPropagation()
    const dx = (e.clientX - fadeDrag.originX) / pxPerTick
    const raw = fadeDrag.side === 'in' ? fadeDrag.origTicks + dx : fadeDrag.origTicks - dx
    const limit =
      fadeDrag.side === 'in' ? duration - fadeOutTicks : duration - fadeInTicks
    setFadeDrag({ ...fadeDrag, ticks: Math.round(Math.min(limit, Math.max(0, raw))) })
  }
  const endFadeDrag = (e: React.PointerEvent): void => {
    if (!fadeDrag) return
    e.stopPropagation()
    if (fadeDrag.ticks !== fadeDrag.origTicks) {
      projectStore.dispatch({
        type: 'clip/setFades',
        clipId: clip.id,
        fadeIn: fadeDrag.side === 'in' ? fadeDrag.ticks : fadeInTicks,
        fadeOut: fadeDrag.side === 'out' ? fadeDrag.ticks : fadeOutTicks
      })
    }
    setFadeDrag(null)
  }

  return (
    <div
      className={`clip ${selected ? 'clip-selected' : ''} ${preview ? 'clip-dragging' : ''} ${
        dimmed ? 'clip-dimmed' : ''
      }`}
      style={{
        left: start * pxPerTick,
        top: (laneTops[lane] ?? 0) + 4,
        width,
        height,
        '--clip-color': color
      } as React.CSSProperties}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      onContextMenu={onContextMenu}
      onDoubleClick={(e) => {
        if (onOpenEditor) {
          e.stopPropagation()
          onOpenEditor()
        }
      }}
    >
      {asset?.peaks && (
        <Waveform
          asset={asset}
          width={width}
          height={height}
          offset={offset}
          duration={duration}
          tempo={tempo}
          rate={clipRate({ ...clip, stretch })}
          reverse={clip.reverse}
          loopTicks={looped ? loopLength : 0}
        />
      )}
      {looped &&
        Array.from({ length: Math.ceil(repeats) - 1 }, (_, i) => (
          <div
            key={i}
            className="clip-loop-divider"
            style={{ left: (i + 1) * loopLength * pxPerTick }}
          />
        ))}
      {(looped || clip.reverse || clip.pitch !== 0 || stretch !== 1) && (
        <div className="clip-badges mono">
          {looped && (
            <span title="Looped — repeats of the original material">
              ↻×{repeats % 1 === 0 ? repeats : repeats.toFixed(2)}
            </span>
          )}
          {clip.reverse && <span title="Reversed">◀</span>}
          {clip.pitch !== 0 && (
            <span title="Transposed">
              {clip.pitch > 0 ? '+' : ''}
              {clip.pitch}st
            </span>
          )}
          {stretch !== 1 && <span title="Time-scaled">×{stretch.toFixed(2)}</span>}
        </div>
      )}
      {notes.length > 0 && (
        <NotePreview
          notes={notes}
          duration={duration}
          loopTicks={looped ? loopLength : 0}
          width={width}
          height={height}
        />
      )}
      {(fadeInTicks > 0 || fadeOutTicks > 0) && (
        <FadeShade
          width={width}
          height={height}
          fadeInPx={fadeInTicks * pxPerTick}
          fadeOutPx={fadeOutTicks * pxPerTick}
        />
      )}
      {fadesEditable && (
        <>
          <div
            className="clip-fade-handle"
            style={{ left: Math.min(width - 10, fadeInTicks * pxPerTick) }}
            title="Fade in — drag"
            onPointerDown={(e) => beginFadeDrag(e, 'in')}
            onPointerMove={moveFadeDrag}
            onPointerUp={endFadeDrag}
          />
          <div
            className="clip-fade-handle clip-fade-handle-out"
            style={{ right: Math.min(width - 10, fadeOutTicks * pxPerTick) }}
            title="Fade out — drag"
            onPointerDown={(e) => beginFadeDrag(e, 'out')}
            onPointerMove={moveFadeDrag}
            onPointerUp={endFadeDrag}
          />
        </>
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
      {/* Right edge, stacked: loop (repeat), stretch (slower/faster), trim. */}
      <div
        className={`clip-handle clip-handle-loop ${clip.assetId === null ? 'clip-handle-half' : ''}`}
        title="Loop — drag right to repeat the clip"
        onPointerDown={(e) => onPointerDown(e, 'loop-r')}
      >
        ↻
      </div>
      {clip.assetId !== null && (
        <div
          className="clip-handle clip-handle-stretch"
          title="Stretch — drag to make the audio play slower (longer) or faster (shorter)"
          onPointerDown={(e) => onPointerDown(e, 'stretch-r')}
        >
          ↔
        </div>
      )}
      <div
        className={`clip-handle clip-handle-r ${clip.assetId === null ? 'clip-handle-half' : ''}`}
        title="Trim — lengthen or shorten the clip"
        onPointerDown={(e) => onPointerDown(e, 'resize-r')}
      />
    </div>
  )
}

/**
 * Shades the attenuated regions of a faded clip with the raised-cosine
 * curve the engine actually applies (see scheduling.fadeCurve).
 */
function FadeShade({
  width,
  height,
  fadeInPx,
  fadeOutPx
}: {
  width: number
  height: number
  fadeInPx: number
  fadeOutPx: number
}): React.JSX.Element {
  // The curve runs bottom (silent) to top (full); the shaded polygon is the
  // attenuated area between the curve and the clip's top edge.
  const curvePath = (fromX: number, toX: number, rising: boolean): string => {
    const points: string[] = []
    const steps = 16
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const gain = (1 - Math.cos(Math.PI * (rising ? t : 1 - t))) / 2
      points.push(`${fromX + (toX - fromX) * t},${(1 - gain) * height}`)
    }
    return `M ${fromX},0 L ${points.join(' L ')} L ${toX},0 Z`
  }
  return (
    <svg className="clip-fades" width={width} height={height}>
      {fadeInPx > 0 && <path className="clip-fade-shade" d={curvePath(0, fadeInPx, true)} />}
      {fadeOutPx > 0 && (
        <path className="clip-fade-shade" d={curvePath(width - fadeOutPx, width, false)} />
      )}
    </svg>
  )
}

/**
 * Tiny note rectangles inside a MIDI clip, spanning its pitch range. On a
 * clip that has been shortened, notes are cut at its end — mirroring
 * exactly what scheduleNotes will play.
 */
function NotePreview({
  notes,
  duration,
  loopTicks,
  width,
  height
}: {
  notes: Note[]
  duration: number
  /** Loop period in ticks (0 = not looped) — notes tile once per repeat. */
  loopTicks: number
  width: number
  height: number
}): React.JSX.Element {
  let min = 127
  let max = 0
  for (const note of notes) {
    if (note.pitch < min) min = note.pitch
    if (note.pitch > max) max = note.pitch
  }
  const span = Math.max(12, max - min + 1)
  const pad = 16 // clear of the name row
  const usable = Math.max(4, height - pad - 4)

  // One pass per repeat, mirroring scheduleNotes: each repeat replays the
  // pattern from its own start, cut at the period (and the clip end).
  const period = loopTicks > 0 ? loopTicks : duration
  const rects: React.JSX.Element[] = []
  for (let repeat = 0, into = 0; into < duration; repeat++, into += period) {
    const windowTicks = Math.min(period, duration - into)
    for (const note of notes) {
      if (note.start >= windowTicks) continue
      rects.push(
        <rect
          key={`${note.id}:${repeat}`}
          x={((into + note.start) / duration) * width}
          y={pad + ((max - note.pitch) / span) * usable}
          width={Math.max(
            2,
            (Math.min(note.duration, windowTicks - note.start) / duration) * width
          )}
          height={Math.max(2, usable / span)}
          rx={1}
        />
      )
    }
  }
  return (
    <svg className="clip-notes" width={width} height={height}>
      {rects}
    </svg>
  )
}

interface WaveformProps {
  asset: ProjectAsset
  width: number
  height: number
  offset: number
  duration: number
  tempo: number
  /** Resampling rate from pitch/stretch (1 = untouched). */
  rate: number
  /** Draw the region mirrored, as it will play. */
  reverse: boolean
  /** Loop period in ticks (0 = not looped) — the drawn region tiles per repeat. */
  loopTicks: number
}

function Waveform({
  asset,
  width,
  height,
  offset,
  duration,
  tempo,
  rate,
  reverse,
  loopTicks
}: WaveformProps): React.JSX.Element {
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
    const mid = h / 2
    const amp = mid - 2

    g.clearRect(0, 0, w, h)
    g.fillStyle = 'rgba(255, 255, 255, 0.55)'
    // The drawn region must match what scheduling will read: resampling
    // scales timeline position into buffer position, and a reversed clip
    // reads its region back-to-front.
    // A looped clip re-reads the same material every repeat: fold the
    // timeline position into the loop period before mapping to the buffer.
    const periodTicks = loopTicks > 0 ? loopTicks : duration
    const regionStartSec = (offset / tps) * rate
    const regionLenSec = (periodTicks / tps) * rate
    for (let x = 0; x < w; x++) {
      const posTicks = ((x / w) * duration) % periodTicks
      const intoRegionSec = (posTicks / tps) * rate
      const sec = reverse
        ? regionStartSec + regionLenSec - intoRegionSec
        : regionStartSec + intoRegionSec
      const bucket = Math.floor(sec * asset.peaksPerSecond)
      if (bucket < 0 || bucket * 2 + 1 >= peaks.length) continue // silence past source end
      const min = peaks[bucket * 2]
      const max = peaks[bucket * 2 + 1]
      g.fillRect(x, mid - max * amp, 1, Math.max(1, (max - min) * amp))
    }
  }, [asset, width, height, offset, duration, tempo, rate, reverse, loopTicks])

  return <canvas ref={canvasRef} className="clip-wave" />
}
