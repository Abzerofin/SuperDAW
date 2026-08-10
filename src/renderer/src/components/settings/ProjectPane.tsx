import { useEffect, useState } from 'react'
import { PPQ } from '@core/model/timebase'
import {
  LOUDNESS_PRESETS,
  type ProjectExportBitDepth,
  type ProjectExportFormat,
  type ProjectSettings,
  type SnapChoice
} from '@core/model/projectSettings'
import { useProjectState } from '@/state/hooks'
import { projectStore } from '@/state/projectStore'
import { useAppShell } from '@/state/appShell'

/**
 * Project-scoped settings — the ONE pane in this window that edits the
 * DOCUMENT, not the app. Every control dispatches a `project/updateSettings`
 * op (one gesture = one op), so changes are undoable, appear in the
 * activity feed, sync to collaborators and save into the .sdaw file.
 */

function update(patch: Partial<ProjectSettings>): void {
  projectStore.dispatch({ type: 'project/updateSettings', patch })
}

const GRID_LABELS: ReadonlyArray<{ value: SnapChoice; label: string }> = [
  { value: 'auto', label: 'Auto — follows zoom' },
  { value: 'bar', label: 'Bar' },
  { value: 'beat', label: 'Beat' },
  { value: '1/8', label: '1/8 note' },
  { value: '1/16', label: '1/16 note' },
  { value: 'off', label: 'Off' }
]

/**
 * A numeric setting that commits ON BLUR or Enter — typing is local state,
 * the dispatch is one op per gesture, exactly like fader drags.
 */
function NumberField({
  id,
  value,
  min,
  max,
  step,
  suffix,
  onCommit
}: {
  id: string
  value: number
  min: number
  max: number
  step: number
  suffix: string
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = (): void => {
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) {
      setText(String(value))
      return
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    setText(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <div className="settings-trim-row">
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      <span className="settings-dim">{suffix}</span>
    </div>
  )
}

export function ProjectPane(): React.JSX.Element {
  const state = useProjectState()
  const shell = useAppShell()
  const settings = state.settings

  if (!shell.projectOpen) {
    return (
      <div className="settings-pane">
        <h2>Project</h2>
        <p className="settings-dim">
          Open a project to edit its settings. Everything on this page belongs to the song
          itself — it saves into the project file and syncs to collaborators.
        </p>
      </div>
    )
  }

  const msPerTick = 60000 / (state.tempo * PPQ)
  const fadeMs = Math.round(settings.defaultFadeTicks * msPerTick * 10) / 10

  return (
    <div className="settings-pane">
      <h2>Project</h2>
      <p className="settings-dim">
        These settings belong to “{state.name}” — they save into the project file, sync to
        collaborators, and every change here is undoable (Ctrl+Z).
      </p>

      <div className="settings-field">
        <label htmlFor="settings-loudness">Loudness target</label>
        <div className="settings-preset-row">
          {LOUDNESS_PRESETS.map((preset) => (
            <button
              key={preset.label}
              className={`corner-btn ${
                settings.loudnessTargetLufs === preset.lufs ? 'settings-preset-active' : ''
              }`}
              title={`${preset.lufs} LUFS`}
              onClick={() => update({ loudnessTargetLufs: preset.lufs })}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="settings-trim-row">
          <input
            id="settings-loudness"
            type="number"
            min={-36}
            max={0}
            step={0.5}
            // Uncontrolled-with-key: retyping is rare here, presets do the work.
            key={settings.loudnessTargetLufs ?? 'none'}
            defaultValue={settings.loudnessTargetLufs ?? ''}
            placeholder="none"
            onBlur={(e) => {
              const raw = e.target.value.trim()
              if (raw === '') {
                if (settings.loudnessTargetLufs !== null) update({ loudnessTargetLufs: null })
                return
              }
              const parsed = Number(raw)
              if (Number.isFinite(parsed) && parsed !== settings.loudnessTargetLufs) {
                update({ loudnessTargetLufs: parsed })
              }
            }}
          />
          <span className="settings-dim">LUFS</span>
          {settings.loudnessTargetLufs !== null && (
            <button className="corner-btn" onClick={() => update({ loudnessTargetLufs: null })}>
              Clear
            </button>
          )}
        </div>
        <p className="settings-dim">
          The integrated loudness this mix is aiming for. Every export measures the bounce
          (BS.1770) and reports how far it landed from this number in the status bar.
        </p>
      </div>

      <div className="settings-field">
        <label htmlFor="settings-default-fade">Default clip micro-fade</label>
        <NumberField
          id="settings-default-fade"
          value={settings.defaultFadeTicks}
          min={0}
          max={PPQ * 4}
          step={12}
          suffix={`ticks${settings.defaultFadeTicks > 0 ? ` ≈ ${fadeMs} ms at ${state.tempo} BPM` : ' — off'}`}
          onCommit={(value) => update({ defaultFadeTicks: value })}
        />
        <p className="settings-dim">
          Stamped on newly imported audio clips as fade-in/out — the classic anti-click
          micro-fade (try 24 ticks ≈ 12 ms at 120 BPM). Existing clips are never touched.
        </p>
      </div>

      <div className="settings-field">
        <label htmlFor="settings-swing">Quantize swing</label>
        <NumberField
          id="settings-swing"
          value={settings.swingPercent}
          min={0}
          max={100}
          step={1}
          suffix="% — 0 is straight, ~66 is triplet feel"
          onCommit={(value) => update({ swingPercent: value })}
        />
      </div>

      <div className="settings-field">
        <label htmlFor="settings-strength">Quantize strength</label>
        <NumberField
          id="settings-strength"
          value={Math.round(settings.quantizeStrength * 100)}
          min={0}
          max={100}
          step={5}
          suffix="% — 100 snaps fully, 50 moves halfway"
          onCommit={(value) => update({ quantizeStrength: value / 100 })}
        />
      </div>

      <div className="settings-field">
        <label htmlFor="settings-humanize">Humanize amount</label>
        <NumberField
          id="settings-humanize"
          value={settings.humanizeTicks}
          min={1}
          max={PPQ}
          step={6}
          suffix={`ticks (± per note; ${PPQ} = a quarter note)`}
          onCommit={(value) => update({ humanizeTicks: value })}
        />
        <p className="settings-dim">
          Swing and strength shape Q (quantize); humanize is the jitter H applies. Both act on
          the selected clips&apos; notes.
        </p>
      </div>

      <div className="settings-field">
        <label htmlFor="settings-default-grid">Default snap grid</label>
        <select
          id="settings-default-grid"
          value={settings.defaultGrid}
          onChange={(e) => update({ defaultGrid: e.target.value as SnapChoice })}
        >
          {GRID_LABELS.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        <p className="settings-dim">
          Seeds everyone&apos;s snap grid when they open this project; switching the grid in the
          transport afterwards stays personal, exactly like zoom.
        </p>
      </div>

      <div className="settings-field">
        <label htmlFor="settings-export-format">Export format</label>
        <div className="settings-trim-row">
          <select
            id="settings-export-format"
            value={settings.exportFormat}
            onChange={(e) => update({ exportFormat: e.target.value as ProjectExportFormat })}
          >
            <option value="wav">WAV — lossless</option>
            <option value="mp3">MP3 — 192 kbps, ~10× smaller</option>
          </select>
          <select
            id="settings-export-depth"
            value={String(settings.exportBitDepth)}
            disabled={settings.exportFormat !== 'wav'}
            title={settings.exportFormat !== 'wav' ? 'MP3 encodes from float — bit depth applies to WAV' : undefined}
            onChange={(e) =>
              update({ exportBitDepth: Number(e.target.value) as ProjectExportBitDepth })
            }
          >
            <option value="16">16-bit</option>
            <option value="24">24-bit</option>
          </select>
        </div>
        <p className="settings-dim">
          What File ▸ Export bounces. 16-bit is the CD/distribution standard; 24-bit is for
          stems and mastering handoff. Track exports use the same bit depth.
        </p>
      </div>
    </div>
  )
}
