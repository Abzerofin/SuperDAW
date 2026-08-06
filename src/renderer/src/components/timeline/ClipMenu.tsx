import type { Clip } from '@core/model/types'
import { MAX_PITCH, MAX_STRETCH, MIN_PITCH, MIN_STRETCH, clipRate } from '@core/model/types'
import { ticksPerSecond } from '@audio/scheduling'
import { projectStore } from '@/state/projectStore'
import { assetStore } from '@/state/audioInstance'
import { selection } from '@/state/selection'
import { canSliceAtPlayhead, duplicateClip, sliceClipAtPlayhead } from '@/lib/clipActions'
import { TRACK_COLORS } from '@/lib/colors'

/**
 * Per-clip editing: slice, reverse, transpose, time-scale and colour.
 *
 * Pitch and length are RESAMPLING (tape/sampler behaviour) — the honest
 * mapping onto the buffer-source primitives; formant-preserving stretch
 * needs the dedicated DSP milestone. Each control is one gesture and one
 * operation, so everything here is undoable and syncs like any edit.
 */

const PITCH_STEP = 1 // semitone
const LENGTH_STEP = 1.25 // multiplicative, so up and down are symmetric

export function ClipMenu({
  clip,
  x,
  y,
  onClose
}: {
  clip: Clip
  x: number
  y: number
  onClose: () => void
}): React.JSX.Element {
  const isAudio = clip.assetId !== null
  const tempo = projectStore.state.tempo

  const setPlayback = (patch: Partial<Pick<Clip, 'reverse' | 'pitch' | 'stretch'>>): void => {
    projectStore.dispatch({
      type: 'clip/setPlayback',
      clipId: clip.id,
      reverse: patch.reverse ?? clip.reverse,
      pitch: patch.pitch ?? clip.pitch,
      stretch: patch.stretch ?? clip.stretch
    })
  }

  // How much timeline the clip's source material covers at the current rate.
  const assetSeconds = clip.assetId ? assetStore.getSeconds(clip.assetId) : null
  const materialTicks =
    assetSeconds !== null
      ? Math.max(1, Math.round((assetSeconds * ticksPerSecond(tempo)) / clipRate(clip)) - clip.offset)
      : null

  const fitClipToMaterial = (): void => {
    if (materialTicks === null) return
    projectStore.dispatch({
      type: 'clip/resize',
      clipId: clip.id,
      start: clip.start,
      duration: materialTicks,
      offset: clip.offset
    })
    onClose()
  }

  const row = (label: string, body: React.ReactNode): React.JSX.Element => (
    <div className="clipmenu-row">
      <span className="clipmenu-label">{label}</span>
      {body}
    </div>
  )

  return (
    <div className="clipmenu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="clipmenu-title">{clip.name}</div>

      <button
        className="menu-item"
        disabled={!canSliceAtPlayhead(clip.id)}
        title="Cut the clip in two at the playhead (Ctrl+E)"
        onClick={() => {
          sliceClipAtPlayhead(clip.id)
          onClose()
        }}
      >
        <span>Slice at playhead</span>
        <span className="menu-shortcut mono">Ctrl+E</span>
      </button>

      {isAudio && (
        <>
          <div className="menu-sep" />
          {row(
            'Reverse',
            <button
              className={`clipmenu-toggle ${clip.reverse ? 'clipmenu-toggle-on' : ''}`}
              title="Play the source material backwards"
              onClick={() => setPlayback({ reverse: !clip.reverse })}
            >
              {clip.reverse ? 'On' : 'Off'}
            </button>
          )}

          {row(
            'Pitch',
            <span className="clipmenu-stepper">
              <button
                title="Down a semitone"
                disabled={clip.pitch <= MIN_PITCH}
                onClick={() => setPlayback({ pitch: clip.pitch - PITCH_STEP })}
              >
                −
              </button>
              <span className="clipmenu-value mono">
                {clip.pitch > 0 ? '+' : ''}
                {clip.pitch} st
              </span>
              <button
                title="Up a semitone"
                disabled={clip.pitch >= MAX_PITCH}
                onClick={() => setPlayback({ pitch: clip.pitch + PITCH_STEP })}
              >
                +
              </button>
              <button
                className="clipmenu-reset"
                title="Back to original pitch"
                disabled={clip.pitch === 0}
                onClick={() => setPlayback({ pitch: 0 })}
              >
                ⟲
              </button>
            </span>
          )}

          {row(
            'Length',
            <span className="clipmenu-stepper">
              <button
                title="Shrink the material (plays faster, higher)"
                disabled={clip.stretch <= MIN_STRETCH}
                onClick={() => setPlayback({ stretch: clip.stretch / LENGTH_STEP })}
              >
                −
              </button>
              <span className="clipmenu-value mono">×{clip.stretch.toFixed(2)}</span>
              <button
                title="Extend the material (plays slower, lower)"
                disabled={clip.stretch >= MAX_STRETCH}
                onClick={() => setPlayback({ stretch: clip.stretch * LENGTH_STEP })}
              >
                +
              </button>
              <button
                className="clipmenu-reset"
                title="Back to original length"
                disabled={clip.stretch === 1}
                onClick={() => setPlayback({ stretch: 1 })}
              >
                ⟲
              </button>
            </span>
          )}

          <button
            className="menu-item"
            disabled={materialTicks === null || materialTicks === clip.duration}
            title="Resize the clip so the whole (stretched) material fits exactly"
            onClick={fitClipToMaterial}
          >
            <span>Fit clip to material</span>
          </button>
          <p className="clipmenu-note">
            Pitch and length resample the audio, like tape speed — they affect each other.
          </p>
        </>
      )}

      <div className="menu-sep" />
      <div className="clipmenu-colors">
        {TRACK_COLORS.map((color) => (
          <button
            key={color}
            className={`color-swatch ${clip.color === color ? 'color-swatch-active' : ''}`}
            style={{ background: color }}
            title={color}
            onClick={() => projectStore.dispatch({ type: 'clip/setColor', clipId: clip.id, color })}
          />
        ))}
        <button
          className={`color-swatch color-swatch-reset ${clip.color === null ? 'color-swatch-active' : ''}`}
          title="Use the track colour"
          onClick={() => projectStore.dispatch({ type: 'clip/setColor', clipId: clip.id, color: null })}
        >
          ×
        </button>
      </div>

      <div className="menu-sep" />
      <button
        className="menu-item"
        onClick={() => {
          duplicateClip(clip.id)
          onClose()
        }}
      >
        <span>Duplicate</span>
        <span className="menu-shortcut mono">Ctrl+D</span>
      </button>
      <button
        className="menu-item"
        onClick={() => {
          selection.select(null)
          projectStore.dispatch({ type: 'clip/delete', clipId: clip.id })
          onClose()
        }}
      >
        <span>Delete</span>
        <span className="menu-shortcut mono">Del</span>
      </button>
    </div>
  )
}
