import { useState } from 'react'
import { formatPosition } from '@core/model/timebase'
import { ticksPerSecond } from '@audio/scheduling'
import { appShell, useAppShell } from '@/state/appShell'
import { useRecentProjects, type RecentProject } from '@/state/recentProjects'
import { useSessionFile } from '@/state/sessionFile'
import { useProjectState } from '@/state/hooks'
import { settingsUi } from '@/state/settingsUi'
import { newProject, openProject, openRecentProject } from '@/lib/projectFile'
import { recentProjects } from '@/state/recentProjects'

/**
 * The launcher: shown before any project is open (and via "Return to
 * Home"). Recent projects are indexed locally at save/open time — no
 * accounts, no cloud; a future account system would only swap the storage
 * behind the recents index.
 */
export function HomeScreen(): React.JSX.Element {
  const shell = useAppShell()
  const recents = useRecentProjects()
  const { dirty } = useSessionFile()
  const currentName = useProjectState().name
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const filtered = q ? recents.filter((r) => r.name.toLowerCase().includes(q)) : recents

  const join = (): void => {
    // Joining replaces the document with the host's snapshot; an empty
    // scratch project is the natural place to do that from.
    if (!shell.projectOpen) newProject()
    appShell.enterProject({ collab: true })
  }

  return (
    <div className="home">
      <div className="home-header">
        <div className="home-brand">SuperDAW</div>
        <div className="home-tagline">Collaboration-first digital audio workstation</div>
        <button
          className="home-settings"
          title="Settings"
          onClick={() => settingsUi.open()}
        >
          ⚙
        </button>
      </div>

      <div className="home-main">
        <div className="home-actions">
          {shell.projectOpen && (
            <button className="home-action home-action-resume" onClick={() => appShell.enterProject()}>
              <span className="home-action-title">Back to “{currentName}”</span>
              <span className="home-action-sub">{dirty ? 'Unsaved changes' : 'Continue where you left off'}</span>
            </button>
          )}
          <button className="home-action" onClick={() => newProject()}>
            <span className="home-action-title">New Project</span>
            <span className="home-action-sub">Start with an empty timeline</span>
          </button>
          <button className="home-action" onClick={() => void openProject()}>
            <span className="home-action-title">Open Project…</span>
            <span className="home-action-sub">Browse for a .sdaw file</span>
          </button>
          <button className="home-action" onClick={join}>
            <span className="home-action-title">Join Collaboration</span>
            <span className="home-action-sub">Enter a session join code</span>
          </button>
        </div>

        <div className="home-recents">
          <div className="home-recents-head">
            <h2>Recent Projects</h2>
            <input
              className="home-search"
              placeholder="Search projects…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {filtered.length === 0 ? (
            <div className="home-empty">
              {recents.length === 0
                ? 'Projects you open or save will appear here.'
                : 'No projects match the search.'}
            </div>
          ) : (
            <table className="home-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Last opened</th>
                  <th>Tempo</th>
                  <th>Time sig.</th>
                  <th>Duration</th>
                  <th>Tracks</th>
                  <th>Plugins</th>
                  <th />
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry) => (
                  <RecentRow key={(entry.path ?? '') + entry.name} entry={entry} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="home-footer">Projects are local .sdaw files — no account required.</div>
    </div>
  )
}

function formatLastOpened(ms: number): string {
  const delta = Date.now() - ms
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} d ago`
  return new Date(ms).toLocaleDateString()
}

/** Timeline length as m:ss (from ticks at the project tempo). */
function formatDuration(entry: RecentProject): string {
  if (entry.durationTicks <= 0) return '—'
  const seconds = entry.durationTicks / ticksPerSecond(entry.tempo)
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function RecentRow({ entry }: { entry: RecentProject }): React.JSX.Element {
  const bars = formatPosition(entry.durationTicks, entry.timeSignature).split('.')[0]
  const missingAssets = entry.missingAssets ?? 0
  const missingPlugins = entry.missingPlugins ?? 0
  const warnings: string[] = []
  if (missingAssets > 0) warnings.push(`${missingAssets} missing asset${missingAssets === 1 ? '' : 's'}`)
  if (missingPlugins > 0) warnings.push(`${missingPlugins} plugin${missingPlugins === 1 ? '' : 's'} unavailable here`)
  const created = entry.createdAt ? `Created ${new Date(entry.createdAt).toLocaleDateString()}` : ''
  return (
    <tr
      className="home-row"
      title={[entry.path ?? 'Saved from the browser — opens via the file picker', created]
        .filter(Boolean)
        .join('\n')}
      onClick={() => void openRecentProject(entry)}
    >
      <td className="home-row-name">{entry.name}</td>
      <td className="home-dim">{formatLastOpened(entry.lastOpened)}</td>
      <td className="home-dim mono">{entry.tempo} BPM</td>
      <td className="home-dim mono">
        {entry.timeSignature[0]}/{entry.timeSignature[1]}
      </td>
      <td className="home-dim mono" title={`${bars} bars`}>
        {formatDuration(entry)}
      </td>
      <td className="home-dim mono">{entry.trackCount}</td>
      <td className="home-dim mono">{entry.pluginCount ?? 0}</td>
      <td>
        {warnings.length > 0 && (
          <span className="home-warn" title={warnings.join(' · ')}>
            ⚠
          </span>
        )}
      </td>
      <td>
        <button
          className="home-row-remove"
          title="Remove from this list (the file is not deleted)"
          onClick={(e) => {
            e.stopPropagation()
            recentProjects.remove(entry)
          }}
        >
          ×
        </button>
      </td>
    </tr>
  )
}
