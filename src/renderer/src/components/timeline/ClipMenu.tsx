import { useSyncExternalStore } from 'react'
import type { Clip } from '@core/model/types'
import { MAX_PITCH, MAX_STRETCH, MIN_PITCH, MIN_STRETCH, clipRate } from '@core/model/types'
import { ticksPerSecond } from '@audio/scheduling'
import { projectStore } from '@/state/projectStore'
import { assetStore } from '@/state/audioInstance'
import { selection } from '@/state/selection'
import { transport } from '@/state/transport'
import {
  canSliceAtEditPoint,
  duplicateClip,
  sliceClipAtEditPoint,
  sliceSelectionIntoEqualParts
} from '@/lib/clipActions'
import {
  canSliceAtTransients,
  sliceClipAtTransients,
  sliceClipToSampler
} from '@/lib/sliceActions'
import { TRACK_COLORS } from '@/lib/colors'
import { contextMenuStyle } from '@/lib/contextMenu'
import { EditableValue } from '../controls/EditableValue'
import { historyUi } from '@/state/historyUi'
import { stepSeqUi } from '@/state/stepSeqUi'
import { collab, useCollab } from '@/state/collab'

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
  const collabState = useCollab()
  // The asset can land while the menu is open — the Download item reacts.
  const asset = useSyncExternalStore(assetStore.subscribe, () =>
    clip.assetId ? assetStore.get(clip.assetId) : undefined
  )
  const missingAsset = clip.assetId !== null && !asset
  const progress = clip.assetId ? collabState.assetProgress.get(clip.assetId) : undefined

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
    <div
      className="clipmenu"
      style={contextMenuStyle(x, y, 240, isAudio ? 560 : 320)}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <input
        key={clip.id}
        className="clipmenu-title clipmenu-title-input"
        title="Clip name — click to rename"
        defaultValue={clip.name}
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation() // typing must not trigger app shortcuts
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.currentTarget.value = clip.name
            e.currentTarget.blur()
          }
        }}
        onBlur={(e) => {
          const name = e.target.value.trim()
          if (name && name !== clip.name) {
            projectStore.dispatch({ type: 'clip/rename', clipId: clip.id, name })
          }
        }}
      />

      {missingAsset && (
        <>
          <button
            className="menu-item"
            disabled={progress !== undefined || collabState.mode === 'off'}
            title={
              collabState.mode === 'off'
                ? "This clip's audio isn't on this machine — join the session it came from to fetch it"
                : "Fetch this clip's audio from the session"
            }
            onClick={() => {
              if (clip.assetId) collab.requestAsset(clip.assetId)
            }}
          >
            <span>
              {progress
                ? `Downloading… ${progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : 0}%`
                : 'Download audio'}
            </span>
          </button>
          <div className="menu-sep" />
        </>
      )}

      {!isAudio && (
        <button
          className="menu-item"
          title="Program this clip as a beat grid — rows are the drum pads (or pitches), columns are steps"
          onClick={() => {
            stepSeqUi.open(clip.id)
            onClose()
          }}
        >
          <span>Step sequencer</span>
        </button>
      )}

      <button
        className="menu-item"
        disabled={!canSliceAtEditPoint(clip.id)}
        title="Cut the clip in two at the edit point — the marker if one is pinned (Shift+click the timeline), otherwise the playhead"
        onClick={() => {
          sliceClipAtEditPoint(clip.id)
          onClose()
        }}
      >
        <span>Slice at {transport.markerTicks !== null ? 'marker' : 'playhead'}</span>
        <span className="menu-shortcut mono">Ctrl+E</span>
      </button>

      {row(
        'Slice equally',
        <span className="clipmenu-parts">
          {[2, 3, 4, 6, 8].map((parts) => (
            <button
              key={parts}
              disabled={clip.duration < parts}
              title={`Cut into ${parts} equal parts (press ${parts})`}
              onClick={() => {
                sliceSelectionIntoEqualParts(parts)
                onClose()
              }}
            >
              {parts}
            </button>
          ))}
        </span>
      )}

      {isAudio && (
        <>
          <button
            className="menu-item"
            disabled={!canSliceAtTransients(clip.id)}
            title="Cut the clip at its detected transients — every hit becomes its own clip (one undo)"
            onClick={() => {
              sliceClipAtTransients(clip.id)
              onClose()
            }}
          >
            <span>Slice at transients</span>
          </button>
          <button
            className="menu-item"
            disabled={missingAsset}
            title="New MIDI track: the sampler plays this audio in slices (keys from C1), with a clip replaying the original groove"
            onClick={() => {
              sliceClipToSampler(clip.id)
              onClose()
            }}
          >
            <span>Slice to sampler track</span>
          </button>
        </>
      )}

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
              <EditableValue
                className="clipmenu-value"
                text={`${clip.pitch > 0 ? '+' : ''}${clip.pitch} st`}
                title="Pitch in semitones — click to type it"
                parse={(raw) => {
                  const n = Math.round(Number(raw.replace(/st/i, '').trim()))
                  return Number.isFinite(n) ? Math.min(MAX_PITCH, Math.max(MIN_PITCH, n)) : null
                }}
                onCommit={(pitch) => setPlayback({ pitch })}
              />
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
              <EditableValue
                className="clipmenu-value"
                text={`×${clip.stretch.toFixed(2)}`}
                title="Time factor — click to type it (1 = original length)"
                parse={(raw) => {
                  const n = Number(raw.replace(/[×x]/i, '').trim())
                  return Number.isFinite(n) && n > 0
                    ? Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, n))
                    : null
                }}
                onCommit={(stretch) => setPlayback({ stretch })}
              />
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

      <div className="menu-sep" />
      <button
        className="menu-item"
        title="This clip's changes this session — wind it back without touching anything else"
        onClick={(e) => {
          historyUi.open({ kind: 'clip', id: clip.id, title: clip.name, x: e.clientX, y: e.clientY })
          onClose()
        }}
      >
        <span>History…</span>
      </button>
    </div>
  )
}
