import { useProjectState } from '@/state/hooks'
import { useSelectedClipId, useSelectedTrackId } from '@/state/selection'
import { panels, usePanels } from '@/state/panels'
import { pianoRollUi, usePianoRollUi } from '@/state/pianoRollUi'
import { FileBay } from './bay/FileBay'
import { EffectsDock } from './fx/EffectsDock'
import { MixerPanel } from './mixer/MixerPanel'
import { PianoRoll } from './pianoroll/PianoRoll'

/**
 * The bottom dock: its tab strip sits at the foot of the timeline, directly
 * above whichever panel is open, so the label and the thing it opens stay
 * together. Clicking the open tab closes the dock (the strip stays).
 */
export function BottomDock(): React.JSX.Element {
  const panelState = usePanels()
  const rollState = usePianoRollUi()

  return (
    <>
      <div className="dock-tabs">
        <button
          className={`dock-tab ${panelState.bottomPanel === 'files' ? 'dock-tab-active' : ''}`}
          title="File Bay — imported audio and MIDI"
          onClick={() => panels.toggleBottom('files')}
        >
          Files
        </button>
        <button
          className={`dock-tab ${panelState.bottomPanel === 'mixer' ? 'dock-tab-active' : ''}`}
          title="Mixer — faders, pans and inserts for every track"
          onClick={() => panels.toggleBottom('mixer')}
        >
          Mixer
        </button>
        <EffectsTab />
        <PianoTab />
      </div>

      {panelState.bottomPanel === 'files' && <FileBay />}
      {panelState.bottomPanel === 'mixer' && <MixerPanel />}
      {panelState.bottomPanel === 'effects' && <EffectsDock />}
      {panelState.bottomPanel === 'pianoroll' && rollState.clipId && (
        <PianoRoll clipId={rollState.clipId} />
      )}
    </>
  )
}

function EffectsTab(): React.JSX.Element {
  const panelState = usePanels()
  const selectedTrackId = useSelectedTrackId()
  const state = useProjectState()
  const track = selectedTrackId ? state.tracks[selectedTrackId] : undefined
  return (
    <button
      className={`dock-tab ${panelState.bottomPanel === 'effects' ? 'dock-tab-active' : ''}`}
      title={
        track
          ? `Effects — ${track.name}'s insert chain`
          : 'Effects — select a track to edit its insert chain'
      }
      onClick={() => panels.toggleBottom('effects')}
    >
      Effects
    </button>
  )
}

function PianoTab(): React.JSX.Element {
  const rollState = usePianoRollUi()
  const panelState = usePanels()
  const state = useProjectState()
  const selectedClipId = useSelectedClipId()

  // A MIDI clip is "editable" when it's already open in the roll, or the
  // current selection can be opened.
  const selectedClip = selectedClipId ? state.clips[selectedClipId] : undefined
  const selectedMidiClipId =
    selectedClip && state.tracks[selectedClip.trackId]?.kind === 'midi'
      ? selectedClip.id
      : null
  const openable = rollState.clipId ?? selectedMidiClipId

  return (
    <button
      className={`dock-tab ${panelState.bottomPanel === 'pianoroll' ? 'dock-tab-active' : ''}`}
      disabled={openable === null}
      title={
        openable === null
          ? 'Piano roll — select or double-click a MIDI clip to edit its notes'
          : 'Toggle piano roll'
      }
      onClick={() => {
        if (panelState.bottomPanel === 'pianoroll') {
          panels.toggleBottom('pianoroll')
        } else if (selectedMidiClipId && selectedMidiClipId !== rollState.clipId) {
          pianoRollUi.open(selectedMidiClipId)
        } else if (rollState.clipId !== null) {
          panels.toggleBottom('pianoroll')
        }
      }}
    >
      Piano
    </button>
  )
}
