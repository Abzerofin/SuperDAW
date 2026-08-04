import { useProjectState } from '@/state/hooks'

export function StatusBar(): React.JSX.Element {
  const state = useProjectState()
  const trackCount = state.trackOrder.length
  const clipCount = Object.keys(state.clips).length

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        <span className="statusbar-project">{state.name}</span>
        <span className="statusbar-dim">Local project</span>
      </div>
      <div className="statusbar-hint statusbar-dim">
        Drop audio files on a track · Double-click a lane to add a clip · Ctrl+Wheel to zoom
      </div>
      <div className="statusbar-right statusbar-dim mono">
        {trackCount} tracks · {clipCount} clips
      </div>
    </div>
  )
}
