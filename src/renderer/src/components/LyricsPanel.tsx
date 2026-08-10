import { useEffect, useRef, useState } from 'react'
import { useProjectState } from '@/state/hooks'
import { projectStore } from '@/state/projectStore'

/**
 * Lyrics tab — one shared text saved with the project. Edits stay local
 * while the textarea is focused (draft) and dispatch as a single
 * project/setLyrics op on blur, so an editing session is one undo step
 * and remote edits never fight the caret mid-line.
 */
export function LyricsPanel(): React.JSX.Element {
  const lyrics = useProjectState().lyrics
  const [draft, setDraftState] = useState<string | null>(null)
  // Ref shadows the draft so commit reads the live value even when the
  // blur fires in the same tick as a state change (Escape, unmount).
  const draftRef = useRef<string | null>(null)
  const setDraft = (value: string | null): void => {
    draftRef.current = value
    setDraftState(value)
  }

  const commit = (): void => {
    const value = draftRef.current
    if (value !== null && value !== projectStore.state.lyrics) {
      projectStore.dispatch({ type: 'project/setLyrics', lyrics: value })
    }
    setDraft(null)
  }

  // Closing the panel mid-edit must not drop the session's text.
  useEffect(() => () => commit(), []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="activity lyrics">
      <div className="activity-header">Lyrics</div>
      <textarea
        className="lyrics-text"
        value={draft ?? lyrics}
        placeholder="Write lyrics here — saved with the project"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
    </aside>
  )
}
