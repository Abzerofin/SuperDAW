import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjectState } from '@/state/hooks'
import { projectStore } from '@/state/projectStore'
import { transport } from '@/state/transport'
import { panels } from '@/state/panels'
import { paletteUi, usePaletteUi } from '@/state/paletteUi'
import { settingsUi } from '@/state/settingsUi'
import { selection } from '@/state/selection'
import { routingUi } from '@/state/routingUi'
import { commentUi } from '@/state/commentUi'
import { appShell } from '@/state/appShell'
import { audioEngine } from '@/state/audioInstance'
import {
  closeProject,
  exportWav,
  newProject,
  openProject,
  saveProject
} from '@/lib/projectFile'
import { createTrack, loadTrackPreset } from '@/lib/trackActions'

/**
 * The universal command palette (Ctrl+P). Entries derive live from the
 * document (tracks, plugins, assets, comments) plus static commands; every
 * action calls the SAME functions the menus and shortcuts use, so nothing
 * here is a new mutation path — palette edits are undoable and
 * collaborative like any other.
 */

interface PaletteEntry {
  readonly id: string
  readonly category: string
  readonly label: string
  readonly detail?: string
  readonly action: () => void
}

/** Substring beats word-prefix beats in-order subsequence; -1 = no match. */
function score(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (q.length === 0) return 0
  const sub = t.indexOf(q)
  if (sub !== -1) return 100 - sub
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length ? 10 : -1
}

export function CommandPalette(): React.JSX.Element | null {
  const ui = usePaletteUi()
  const state = useProjectState()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ui.isOpen) {
      setQuery('')
      setCursor(0)
    }
  }, [ui.isOpen])

  const entries = useMemo<PaletteEntry[]>(() => {
    if (!ui.isOpen) return []
    const out: PaletteEntry[] = []
    const cmd = (label: string, action: () => void, detail?: string): void => {
      out.push({ id: `cmd:${label}`, category: 'Command', label, detail, action })
    }

    cmd(transport.isPlaying ? 'Stop' : 'Play', () => transport.toggle(), 'Space')
    cmd('Return to start', () => transport.setPosition(0))
    cmd('Toggle metronome', () => audioEngine.setMetronome(!audioEngine.metronomeEnabled))
    cmd('Undo', () => projectStore.undo(), 'Ctrl+Z')
    cmd('Redo', () => projectStore.redo(), 'Ctrl+Y')
    cmd('New audio track', () => createTrack('audio'))
    cmd('New MIDI track', () => createTrack('midi'))
    cmd('New folder track', () => createTrack('folder'))
    cmd('Load track preset…', () => void loadTrackPreset())
    cmd('Save project', () => void saveProject(), 'Ctrl+S')
    cmd('Save project as…', () => void saveProject(true), 'Ctrl+Shift+S')
    cmd('Open project…', () => void openProject(), 'Ctrl+O')
    cmd('New project', () => newProject(), 'Ctrl+Shift+N')
    cmd('Export WAV…', () => void exportWav())
    cmd('Close project', () => closeProject())
    cmd('Return to Home', () => appShell.goHome())
    cmd('Toggle mixer', () => panels.togglePanel('mixer'))
    cmd('Toggle File Bay', () => panels.togglePanel('files'))
    cmd('Toggle chat', () => panels.togglePanel('chat'))
    cmd('Toggle lyrics', () => panels.togglePanel('lyrics'))
    cmd('Toggle activity feed', () => panels.togglePanel('activity'))

    out.push({
      id: 'settings:general',
      category: 'Settings',
      label: 'Settings: General',
      action: () => settingsUi.open('general')
    })
    out.push({
      id: 'settings:audio',
      category: 'Settings',
      label: 'Settings: Audio',
      detail: 'Input/output devices',
      action: () => settingsUi.open('audio')
    })

    for (const id of state.trackOrder) {
      const track = state.tracks[id]
      if (!track) continue
      out.push({
        id: `track:${id}`,
        category: 'Track',
        label: track.name,
        detail: `${track.kind}${track.frozenAssetId ? ' · frozen' : ''} — open FX`,
        action: () => {
          selection.selectTrack(id)
          panels.openPanel('effects')
        }
      })
      out.push({
        id: `mixer:${id}`,
        category: 'Mixer',
        label: `${track.name} strip`,
        detail: 'open in mixer',
        action: () => panels.openPanel('mixer')
      })
      out.push({
        id: `routing:${id}`,
        category: 'Routing',
        label: `${track.name} routing`,
        action: () => routingUi.open(id)
      })
    }

    for (const instance of Object.values(state.plugins)) {
      const track = state.tracks[instance.trackId]
      out.push({
        id: `plugin:${instance.id}`,
        category: 'Plugin',
        label: instance.descriptor.name,
        detail: track ? `on ${track.name}` : undefined,
        action: () => {
          selection.selectTrack(instance.trackId)
          panels.openPanel('effects')
        }
      })
    }

    for (const node of Object.values(state.files)) {
      if (node.kind === 'folder') continue
      out.push({
        id: `asset:${node.id}`,
        category: 'Asset',
        label: node.name,
        detail: node.kind,
        action: () => panels.openPanel('files')
      })
    }

    for (const comment of Object.values(state.comments)) {
      if (comment.parentId !== null) continue
      out.push({
        id: `comment:${comment.id}`,
        category: 'Comment',
        label: comment.text.length > 60 ? `${comment.text.slice(0, 60)}…` : comment.text,
        detail: `by ${comment.authorName}`,
        action: () => commentUi.open(comment.anchor)
      })
    }

    return out
  }, [ui.isOpen, state])

  const results = useMemo(() => {
    const scored = entries
      .map((entry) => ({ entry, s: score(query, `${entry.category} ${entry.label}`) }))
      .filter((r) => r.s >= 0)
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, 40).map((r) => r.entry)
  }, [entries, query])

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, results.length - 1)))
  }, [results.length])

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    listRef.current
      ?.querySelector('.palette-row-active')
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!ui.isOpen) return null

  const run = (entry: PaletteEntry | undefined): void => {
    if (!entry) return
    paletteUi.close()
    entry.action()
  }

  return (
    <div className="palette-backdrop" onPointerDown={() => paletteUi.close()}>
      <div className="palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder="Search commands, tracks, plugins, assets, comments…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') paletteUi.close()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(results.length - 1, c + 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(0, c - 1))
            }
            if (e.key === 'Enter') run(results[cursor])
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">No matches</div>}
          {results.map((entry, i) => (
            <button
              key={entry.id}
              className={`palette-row ${i === cursor ? 'palette-row-active' : ''}`}
              onPointerMove={() => setCursor(i)}
              onClick={() => run(entry)}
            >
              <span className="palette-cat">{entry.category}</span>
              <span className="palette-label">{entry.label}</span>
              {entry.detail && <span className="palette-detail">{entry.detail}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
