import { useProjectState } from '@/state/hooks'
import { autoFormForTrack, editorFormFor, editorUi, useEditorUi } from '@/state/editorUi'

/**
 * The Piano / Steps switch in the clip editor's head. The form normally
 * follows the track's instrument (drum kits get the grid); picking the
 * other one here pins it for this track, and picking the instrument's own
 * form again hands control back to the instrument.
 */
export function EditorFormSwitch(): React.JSX.Element {
  const state = useProjectState()
  const ui = useEditorUi()
  const trackId = ui.clipId ? (state.clips[ui.clipId]?.trackId ?? null) : null
  const form = editorFormFor(state, ui.clipId)
  const auto = autoFormForTrack(state, trackId)

  return (
    <div className="fx-waves">
      {(['piano', 'steps'] as const).map((option) => (
        <button
          key={option}
          className={`fx-wave fx-inst-kind ${form === option ? 'fx-wave-active' : ''}`}
          title={
            option === 'piano'
              ? `Piano roll — notes on a keyboard grid${auto === 'piano' ? ' (this instrument’s own form)' : ''}`
              : `Step grid — drum-machine steps${auto === 'steps' ? ' (this instrument’s own form)' : ''}`
          }
          onClick={() => editorUi.setForm(option === auto ? null : option)}
        >
          {option === 'piano' ? 'PIANO' : 'STEPS'}
        </button>
      ))}
    </div>
  )
}
