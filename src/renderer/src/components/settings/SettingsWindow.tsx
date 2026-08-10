import { useEffect, useState } from 'react'
import { audioEngine } from '@/state/audioInstance'
import { audioDevices, useAudioDevices } from '@/state/audioDevices'
import { collab, useCollab } from '@/state/collab'
import {
  IMPLEMENTED_SECTIONS,
  settingsUi,
  useSettingsUi,
  type SettingsSection
} from '@/state/settingsUi'
import { preferences, usePreferences, type TempoConformChoice } from '@/state/preferences'
import { PluginsPane } from './PluginsPane'
import { ThemesPane } from './ThemesPane'

/**
 * The settings window: an in-app overlay (professional, no OS dialogs)
 * with a section sidebar built for expansion — General and Audio are live,
 * the rest are placeholders that gain panes without touching this shell.
 * Everything here is app-level state, fully independent of project files.
 */

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'audio', label: 'Audio' },
  { id: 'themes', label: 'Themes' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts' },
  { id: 'collaboration', label: 'Collaboration' },
  { id: 'plugins', label: 'Plugins' }
]

export function SettingsWindow(): React.JSX.Element | null {
  const ui = useSettingsUi()

  useEffect(() => {
    if (!ui.isOpen) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') settingsUi.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ui.isOpen])

  if (!ui.isOpen) return null

  return (
    <div className="settings-backdrop" onPointerDown={() => settingsUi.close()}>
      <div className="settings-window" onPointerDown={(e) => e.stopPropagation()}>
        <div className="settings-sidebar">
          <div className="settings-title">Settings</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings-nav ${ui.section === s.id ? 'settings-nav-active' : ''} ${
                IMPLEMENTED_SECTIONS.has(s.id) ? '' : 'settings-nav-future'
              }`}
              onClick={() => settingsUi.setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="settings-body">
          <button className="settings-close" title="Close (Esc)" onClick={() => settingsUi.close()}>
            ×
          </button>
          {ui.section === 'general' && <GeneralPane />}
          {ui.section === 'audio' && <AudioPane />}
          {ui.section === 'themes' && <ThemesPane />}
          {ui.section === 'collaboration' && <CollaborationPane />}
          {ui.section === 'plugins' && <PluginsPane />}
          {!IMPLEMENTED_SECTIONS.has(ui.section) && (
            <div className="settings-pane">
              <h2>{SECTIONS.find((s) => s.id === ui.section)?.label}</h2>
              <p className="settings-dim">Coming in a future milestone.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CollaborationPane(): React.JSX.Element {
  const collabState = useCollab()
  usePreferences()
  const [url, setUrl] = useState(collab.relayUrl)
  const inSession = collabState.mode !== 'off'

  return (
    <div className="settings-pane">
      <h2>Collaboration</h2>
      <div className="settings-field">
        <label htmlFor="settings-auto-download">File downloads</label>
        <select
          id="settings-auto-download"
          value={preferences.autoDownloadAssets ? 'auto' : 'ask'}
          onChange={(e) => preferences.set('autoDownloadAssets', e.target.value === 'auto')}
        >
          <option value="ask">Ask before downloading collaborators&apos; files</option>
          <option value="auto">Download automatically</option>
        </select>
        <p className="settings-dim">
          When collaborators share audio, their files must transfer to your machine before those
          clips make sound. Until a file arrives its clips play silently, so waiting is always
          safe.
        </p>
      </div>
      <div className="settings-field">
        <label htmlFor="settings-relay-url">Relay server</label>
        <input
          id="settings-relay-url"
          className="mono"
          value={url}
          disabled={inSession}
          placeholder="ws://localhost:8787"
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => collab.setRelayUrl(url)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') collab.setRelayUrl(url)
          }}
        />
        <p className="settings-dim">
          Where “Start collaboration” and internet join codes connect. Everyone in a session must
          point at the same relay — run one with <span className="mono">npm run relay</span> and use
          that machine&apos;s address (a VPN address like Tailscale&apos;s works without touching
          your router). Leave empty to reset to the default.
          {inSession && ' Leave the session to change this.'}
        </p>
      </div>
      <div className="settings-field">
        <label>LAN sessions</label>
        <p className="settings-dim">
          “Start LAN-only session” needs no relay: it serves directly from this machine and the join
          code carries its address. A VPN counts as a LAN — if this machine is on one, the code
          advertises that address so peers off your physical network can still reach it.
        </p>
      </div>
    </div>
  )
}

function GeneralPane(): React.JSX.Element {
  useCollab()
  usePreferences()
  const [name, setName] = useState(collab.displayName)

  return (
    <div className="settings-pane">
      <h2>General</h2>
      <div className="settings-field">
        <label htmlFor="settings-tempo-conform">Tempo changes</label>
        <select
          id="settings-tempo-conform"
          value={preferences.tempoConform}
          onChange={(e) => preferences.set('tempoConform', e.target.value as TempoConformChoice)}
        >
          <option value="ask">Ask what to do with audio</option>
          <option value="always">Always stretch audio to the new tempo</option>
          <option value="never">Never stretch audio</option>
        </select>
        <p className="settings-dim">
          What changing the project BPM does to existing audio clips. Stretching is tape-style
          (speed and pitch change together). Individual tracks can be conformed any time from the
          track&apos;s ⋯ menu.
        </p>
      </div>
      <div className="settings-field">
        <label htmlFor="settings-count-in">Recording count-in</label>
        <select
          id="settings-count-in"
          value={String(preferences.countInBars)}
          onChange={(e) => preferences.set('countInBars', Number(e.target.value) as 0 | 1 | 2)}
        >
          <option value="0">Off — record immediately</option>
          <option value="1">1 bar of clicks before recording</option>
          <option value="2">2 bars of clicks before recording</option>
        </select>
        <p className="settings-dim">
          The metronome counts you in from a standing start; punching in while the song is
          already playing always records immediately.
        </p>
      </div>
      <div className="settings-field">
        <label htmlFor="settings-middle-ping">Middle-click ping</label>
        <select
          id="settings-middle-ping"
          value={preferences.middleClickPing ? 'on' : 'off'}
          onChange={(e) => preferences.set('middleClickPing', e.target.value === 'on')}
        >
          <option value="on">On — a middle click pings collaborators</option>
          <option value="off">Off</option>
        </select>
        <p className="settings-dim">
          Holding the middle button and dragging always pans, whatever this is set to.
        </p>
      </div>
      <div className="settings-field">
        <label htmlFor="settings-display-name">Display name</label>
        <input
          id="settings-display-name"
          value={name}
          maxLength={24}
          // Locked mid-session, matching the Collaboration panel: the host
          // stamps your name into the roster at join time and there is no
          // rename message, so editing it here would leave the old name on
          // your cursor while chat and comments used the new one.
          disabled={collab.mode !== 'off'}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => collab.setDisplayName(name)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') collab.setDisplayName(name)
          }}
        />
        <p className="settings-dim">
          {collab.mode === 'off'
            ? 'Shown to collaborators in sessions, on your cursor and in chat.'
            : 'Shown to collaborators — leave the session to change it.'}
        </p>
      </div>
      <div className="settings-field">
        <label>Projects</label>
        <p className="settings-dim">
          Projects are local .sdaw files — no account, no cloud. Collaboration sessions run over a
          join code from the Collab menu.
        </p>
      </div>
      <div className="settings-field">
        <label>About</label>
        <p className="settings-dim">
          SuperDAW — free software under the{' '}
          <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noreferrer">
            GNU GPL v3
          </a>
          . Source:{' '}
          <a href="https://github.com/Abzerofin/SuperDAW" target="_blank" rel="noreferrer">
            github.com/Abzerofin/SuperDAW
          </a>
          . Music you make with it is yours.
        </p>
      </div>
    </div>
  )
}

function AudioPane(): React.JSX.Element {
  const devices = useAudioDevices()
  // The context reports the live sample rate / channel layout; creating it
  // here is safe (it starts suspended until the first transport gesture).
  const [info, setInfo] = useState(audioEngine.contextInfo())
  useEffect(() => {
    audioEngine.ensureContext()
    setInfo(audioEngine.contextInfo())
    void audioDevices.refresh(false)
  }, [])

  return (
    <div className="settings-pane">
      <h2>Audio</h2>

      {!devices.labelsVisible && (
        <div className="settings-field">
          <button className="corner-btn" onClick={() => void devices.revealLabels()}>
            Show device names…
          </button>
          <p className="settings-dim">
            The browser hides device names until microphone access is granted once.
          </p>
        </div>
      )}

      <div className="settings-field">
        <label htmlFor="settings-output">Output device</label>
        <select
          id="settings-output"
          value={devices.outputDeviceId ?? ''}
          onChange={(e) => void devices.setOutput(e.target.value || null)}
        >
          <option value="">System default</option>
          {devices.outputs
            .filter((d) => d.deviceId !== '')
            .map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
        </select>
        <p className="settings-dim">Switches live — playback keeps running.</p>
      </div>

      <div className="settings-field">
        <label htmlFor="settings-input">Input device</label>
        <select
          id="settings-input"
          value={devices.inputDeviceId ?? ''}
          onChange={(e) => void devices.setInput(e.target.value || null)}
        >
          <option value="">System default</option>
          {devices.inputs
            .filter((d) => d.deviceId !== '')
            .map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
        </select>
        <p className="settings-dim">Used when recording armed tracks.</p>
      </div>

      <div className="settings-field">
        <label>Engine</label>
        {info ? (
          <div className="settings-info mono">
            <span>Sample rate</span>
            <span>{info.sampleRate} Hz</span>
            <span>Output channels</span>
            <span>{info.outputChannels}</span>
            {info.baseLatencySec !== null && (
              <>
                <span>Output latency</span>
                <span>
                  ≈ {Math.round(info.baseLatencySec * 1000 * 10) / 10} ms (
                  {Math.round(info.baseLatencySec * info.sampleRate)} frames)
                </span>
              </>
            )}
          </div>
        ) : (
          <p className="settings-dim">The audio engine has not started yet.</p>
        )}
        <p className="settings-dim">
          If a selected device disappears, SuperDAW falls back to the closest available one and
          notes it in the status bar.
        </p>
      </div>
    </div>
  )
}
