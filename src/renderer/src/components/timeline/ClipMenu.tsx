import { useSyncExternalStore } from 'react'
import type { Clip } from '@core/model/types'
import {
  MAX_PITCH,
  MAX_STRETCH,
  MIN_PITCH,
  MIN_STRETCH,
  clipPlaybackRate,
  clipWarpFactor,
  takeGroupMembers
} from '@core/model/types'
import {
  buildActivateTakeOp,
  buildFlattenTakesOp,
  buildGroupTakesOp,
  buildUngroupTakesOp,
  overlappingClips
} from '@core/ops/takes'
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
import { takeLanesUi, useTakeLanesUi } from '@/state/takeLanesUi'
import { EditableValue } from '../controls/EditableValue'
import { historyUi } from '@/state/historyUi'
import { editorUi } from '@/state/editorUi'
import { collab, useCollab } from '@/state/collab'

/**
 * Per-clip editing: slice, reverse, transpose, time-scale and colour.
 *
 * Pitch and length default to RESAMPLING (tape/sampler behaviour); the
 * Warp toggle switches the clip to the phase-vocoder path, where length
 * changes keep the pitch and pitch changes keep the timing (Clip.warp).
 * Each control is one gesture and one operation, so everything here is
 * undoable and syncs like any edit.
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
  const takeUi = useTakeLanesUi()
  // Take-group actions: membership, or the candidates a "Group as takes"
  // would gather (a same-track multi-selection, else the clips overlapping
  // this one). All the ops are built by the pure core builders.
  const takeMembers = clip.takeGroupId
    ? takeGroupMembers(projectStore.state, clip.takeGroupId)
    : []
  const takeIndex = takeMembers.findIndex((m) => m.id === clip.id)
  const groupCandidates = ((): string[] => {
    if (clip.takeGroupId || clip.isPattern) return []
    const selected = [...selection.selectedClipIds]
    if (
      selected.length > 1 &&
      selected.includes(clip.id) &&
      selected.every((id) => projectStore.state.clips[id]?.trackId === clip.trackId)
    ) {
      return selected
    }
    return [clip.id, ...overlappingClips(projectStore.state, clip).map((c) => c.id)]
  })()
  const dispatchAndClose = (op: ReturnType<typeof buildActivateTakeOp>): void => {
    if (op) projectStore.dispatch(op)
    onClose()
  }
  // The asset can land while the menu is open — the Download item reacts.
  const asset = useSyncExternalStore(assetStore.subscribe, () =>
    clip.assetId ? assetStore.get(clip.assetId) : undefined
  )
  const missingAsset = clip.assetId !== null && !asset
  const progress = clip.assetId ? collabState.assetProgress.get(clip.assetId) : undefined

  const setPlayback = (
    patch: Partial<Pick<Clip, 'reverse' | 'pitch' | 'stretch' | 'warp'>>
  ): void => {
    projectStore.dispatch({
      type: 'clip/setPlayback',
      clipId: clip.id,
      reverse: patch.reverse ?? clip.reverse,
      pitch: patch.pitch ?? clip.pitch,
      stretch: patch.stretch ?? clip.stretch,
      warp: patch.warp ?? clip.warp ?? false
    })
  }

  // How much timeline the clip's source material covers at the current
  // playback settings (warped material is warpFactor× the source, read at
  // the pitch-only rate — for tape clips this reduces to 1/clipRate).
  const assetSeconds = clip.assetId ? assetStore.getSeconds(clip.assetId) : null
  const materialTicks =
    assetSeconds !== null
      ? Math.max(
          1,
          Math.round(
            (assetSeconds * ticksPerSecond(tempo) * clipWarpFactor(clip)) /
              clipPlaybackRate(clip)
          ) - clip.offset
        )
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
      style={contextMenuStyle(x, y, 240, isAudio ? 620 : 380)}
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

      {clip.takeGroupId && (
        <>
          <button
            className="menu-item"
            disabled={clip.takeActive === true}
            title="Make this the take that sounds — the rest of its group goes silent"
            onClick={() => dispatchAndClose(buildActivateTakeOp(projectStore.state, clip.id))}
          >
            <span>
              Use this take{takeIndex >= 0 ? ` (T${takeIndex + 1}/${takeMembers.length})` : ''}
            </span>
          </button>
          <button
            className="menu-item"
            title={
              takeUi.isOpen(clip.trackId)
                ? 'Collapse the take lanes back into the track row'
                : 'Show each take of this track in its own lane — click a take to choose it'
            }
            onClick={() => {
              takeLanesUi.toggle(clip.trackId)
              onClose()
            }}
          >
            <span>{takeUi.isOpen(clip.trackId) ? 'Hide take lanes' : 'Show take lanes'}</span>
          </button>
          <button
            className="menu-item"
            title="Keep this take, delete the group's other takes (one undo restores them all)"
            onClick={() => dispatchAndClose(buildFlattenTakesOp(projectStore.state, clip.id))}
          >
            <span>Flatten takes (keep this take)</span>
          </button>
          <button
            className="menu-item"
            title="Dissolve the take group — every take becomes an ordinary clip and sounds again"
            onClick={() =>
              dispatchAndClose(
                clip.takeGroupId
                  ? buildUngroupTakesOp(projectStore.state, clip.takeGroupId)
                  : null
              )
            }
          >
            <span>Ungroup takes</span>
          </button>
          <div className="menu-sep" />
        </>
      )}
      {!clip.takeGroupId && groupCandidates.length > 1 && (
        <>
          <button
            className="menu-item"
            title="Treat these overlapping clips as alternative takes of one region — this clip stays audible, the others go silent until chosen"
            onClick={() =>
              dispatchAndClose(buildGroupTakesOp(projectStore.state, groupCandidates, clip.id))
            }
          >
            <span>Group as takes ({groupCandidates.length})</span>
          </button>
          <div className="menu-sep" />
        </>
      )}

      {!isAudio && (
        <button
          className="menu-item"
          // Which editor opens is the TRACK's business: a drum track gets
          // the step grid, a MIDI track the piano roll. One entry, because
          // there is no longer a choice to offer here.
          title="Edit this clip's notes"
          onClick={() => {
            editorUi.open(clip.id)
            onClose()
          }}
        >
          <span>Edit notes</span>
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
          <button
            className="menu-item"
            title={
              clip.warp
                ? 'Back to tape-style resampling (pitch and length affect each other)'
                : 'Phase-vocoder playback: length keeps the pitch, pitch keeps the timing'
            }
            onClick={() => setPlayback({ warp: !(clip.warp ?? false) })}
          >
            <span>{clip.warp ? '✓ Warp (keep pitch)' : 'Warp (keep pitch)'}</span>
          </button>
          <p className="clipmenu-note">
            {clip.warp
              ? 'Warp is on: length and pitch are independent (the audio is re-timed, not resampled).'
              : 'Pitch and length resample the audio, like tape speed — they affect each other.'}
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
