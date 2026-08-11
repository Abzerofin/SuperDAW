import { useEffect, useRef } from 'react'
import type { Track } from '@core/model/types'
import type { InputChannelMode } from '@audio/input'
import { useAudioDevices, audioDevices } from '@/state/audioDevices'
import { trackInputs, useTrackInputs, type MidiChannelChoice } from '@/state/trackInputs'
import { midiInputs, useMidiInputs } from '@/state/midiInputs'
import { trackInputUi } from '@/state/trackInputUi'
import { recording, useRecording } from '@/state/recording'

/**
 * A track's recording input. Audio tracks: which device, which hardware
 * channel(s), and monitoring. MIDI tracks: which MIDI device and channel
 * feed the track. All per-machine settings (see state/trackInputs) —
 * nothing here touches the project document. Closes on ×, Esc, or a click
 * outside.
 */
export function TrackInputPanel({ track }: { track: Track }): React.JSX.Element {
  const devices = useAudioDevices()
  const inputs = useTrackInputs()
  const midi = useMidiInputs()
  const rec = useRecording()
  const isMidi = track.kind === 'midi'
  const config = inputs.configOf(track.id)
  const available = inputs.channelsAvailable(track.id)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isMidi) void midiInputs.ensure()
    else void audioDevices.refresh(false)
  }, [isMidi])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) trackInputUi.close()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') trackInputUi.close()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  // Offer the channels the open stream reports; before one exists, assume a
  // stereo device so the choice is still visible (it re-reads on connect).
  const channelCount = available ?? 2
  const options: Array<{ mode: InputChannelMode; channel: number; label: string }> = []
  for (let ch = 0; ch < channelCount; ch++) {
    options.push({ mode: 'mono', channel: ch, label: `Mono · Input ${ch + 1}` })
  }
  for (let ch = 0; ch + 1 < channelCount; ch++) {
    options.push({ mode: 'stereo', channel: ch, label: `Stereo · Inputs ${ch + 1}-${ch + 2}` })
  }
  const selected = `${config.channels.mode}:${config.channels.channel}`

  if (isMidi) {
    return (
      <div
        className="fx-panel track-input-panel"
        ref={rootRef}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="fx-head">
          <span className="fx-title">
            <span className="proll-dot" style={{ background: track.color }} />
            MIDI input · {track.name}
          </span>
          <button className="proll-close" title="Close (Esc)" onClick={() => trackInputUi.close()}>
            ×
          </button>
        </div>

        <div className="track-input-body">
          <label className="track-input-field">
            <span>Device</span>
            <select
              value={config.midiInputId ?? ''}
              onChange={(e) =>
                void trackInputs.setConfig(track.id, { midiInputId: e.target.value || null })
              }
            >
              <option value="">
                Default{midi.selectedInputId ? ' (from Settings)' : ' (all devices)'}
              </option>
              {midi.inputs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>

          <label className="track-input-field">
            <span>Channel</span>
            <select
              value={config.midiChannel === 'all' ? 'all' : String(config.midiChannel)}
              onChange={(e) => {
                const channel: MidiChannelChoice =
                  e.target.value === 'all' ? 'all' : Number(e.target.value)
                void trackInputs.setConfig(track.id, { midiChannel: channel })
              }}
            >
              <option value="all">All channels</option>
              {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
                <option key={ch} value={String(ch)}>
                  Channel {ch}
                </option>
              ))}
            </select>
          </label>

          <div className="track-input-row">
            <button
              className={`corner-btn ${rec.isArmed(track.id) ? 'track-input-armed' : ''}`}
              title="Arm this track for recording"
              onClick={() => recording.toggleArm(track.id)}
            >
              ● {rec.isArmed(track.id) ? 'Armed' : 'Arm'}
            </button>
          </div>

          <p className="track-input-note">
            {!midi.supported
              ? 'Web MIDI is not available in this browser.'
              : midi.status === 'denied'
                ? 'MIDI access was denied — allow it to play and record from a keyboard.'
                : midi.inputs.length === 0
                  ? 'No MIDI devices connected. Playing works the moment one is plugged in.'
                  : `${midi.inputs.length} MIDI device${midi.inputs.length === 1 ? '' : 's'} connected — play to hear this track's instrument.`}
            {' '}MIDI settings stay on this machine — they are never saved into the project.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      className="fx-panel track-input-panel"
      ref={rootRef}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="fx-head">
        <span className="fx-title">
          <span className="proll-dot" style={{ background: track.color }} />
          Input · {track.name}
        </span>
        <button className="proll-close" title="Close (Esc)" onClick={() => trackInputUi.close()}>
          ×
        </button>
      </div>

      <div className="track-input-body">
        <label className="track-input-field">
          <span>Device</span>
          <select
            value={config.deviceId ?? ''}
            onChange={(e) =>
              void trackInputs.setConfig(track.id, { deviceId: e.target.value || null })
            }
          >
            <option value="">Default{devices.inputDeviceId ? ' (from Settings)' : ''}</option>
            {devices.inputs
              .filter((d) => d.deviceId !== '')
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
          </select>
        </label>

        <label className="track-input-field">
          <span>Channels</span>
          <select
            value={selected}
            onChange={(e) => {
              const [mode, channel] = e.target.value.split(':')
              void trackInputs.setConfig(track.id, {
                channels: { mode: mode as InputChannelMode, channel: Number(channel) }
              })
            }}
          >
            {options.map((o) => (
              <option key={`${o.mode}:${o.channel}`} value={`${o.mode}:${o.channel}`}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <div className="track-input-row">
          <button
            className={`corner-btn track-input-monitor ${config.monitor ? 'track-input-monitor-on' : ''}`}
            title="Hear the live input through this track's effects and fader. Use headphones — monitoring through speakers can feed back."
            onClick={() => void trackInputs.toggleMonitor(track.id)}
          >
            {config.monitor ? '◉ Monitoring' : '◎ Monitor'}
          </button>
          <button
            className={`corner-btn ${rec.isArmed(track.id) ? 'track-input-armed' : ''}`}
            title="Arm this track for recording"
            onClick={() => recording.toggleArm(track.id)}
          >
            ● {rec.isArmed(track.id) ? 'Armed' : 'Arm'}
          </button>
        </div>

        <p className="track-input-note">
          {available === null
            ? 'Channel list updates once the device opens (monitor or arm to connect).'
            : `Device reports ${available} channel${available === 1 ? '' : 's'}.`}
          {' '}Input settings stay on this machine — they are never saved into the project.
        </p>
        {inputs.lastError && <p className="track-input-error">{inputs.lastError}</p>}
      </div>
    </div>
  )
}
