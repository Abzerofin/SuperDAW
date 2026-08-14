/**
 * Live input routing: turning a capture stream into the exact channels a
 * track should hear and record.
 *
 * An interface presents N hardware inputs as one multi-channel stream; a
 * track wants one of them (mono) or a pair (stereo). A splitter/merger tap
 * does that selection without copying audio, and the SAME tap shape feeds
 * both monitoring and recording, so what you hear is what gets captured.
 *
 * These are the semantics the SEAM promises (backend.ts `openInput`): the
 * Web Audio backend builds the tap below, and the native engine's `input`
 * node reproduces the identical selection rule inside its duplex callback.
 * Which device/channels a track uses is per-machine, so it never enters the
 * project document (see renderer/state/trackInputs.ts).
 */

export type InputChannelMode = 'mono' | 'stereo'

export interface InputChannelConfig {
  readonly mode: InputChannelMode
  /** 0-based index of the first hardware channel to take. */
  readonly channel: number
}

export const DEFAULT_INPUT_CHANNELS: InputChannelConfig = { mode: 'mono', channel: 0 }

export interface InputTap {
  /** Stereo output carrying only the selected channel(s). */
  readonly output: AudioNode
  /** Channels the stream actually offers (what the UI can choose from). */
  readonly channelCount: number
  dispose(): void
}

/** Channels a capture stream actually provides (1 if it won't say). */
export function streamChannelCount(stream: MediaStream): number {
  const track = stream.getAudioTracks()[0]
  const count = track?.getSettings().channelCount
  return Math.max(1, Math.min(32, count ?? 1))
}

/** Human label for a channel selection, e.g. "Input 1" / "Inputs 1-2". */
export function channelLabel(config: InputChannelConfig): string {
  return config.mode === 'mono'
    ? `Input ${config.channel + 1}`
    : `Inputs ${config.channel + 1}-${config.channel + 2}`
}

/**
 * Build the selection tap. Mono feeds the chosen channel to both sides
 * (centred, so panning still decides placement); stereo takes the chosen
 * channel and the next one.
 */
export function buildInputTap(
  ctx: AudioContext,
  stream: MediaStream,
  config: InputChannelConfig
): InputTap {
  const channelCount = streamChannelCount(stream)
  const source = ctx.createMediaStreamSource(stream)
  const splitter = ctx.createChannelSplitter(channelCount)
  const merger = ctx.createChannelMerger(2)
  source.connect(splitter)

  const left = Math.min(Math.max(0, config.channel), channelCount - 1)
  const right =
    config.mode === 'stereo' ? Math.min(left + 1, channelCount - 1) : left
  splitter.connect(merger, left, 0)
  splitter.connect(merger, right, 1)

  return {
    output: merger,
    channelCount,
    dispose() {
      source.disconnect()
      splitter.disconnect()
      merger.disconnect()
    }
  }
}
