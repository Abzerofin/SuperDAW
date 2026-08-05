import { TransportBar } from './components/TransportBar'
import { TimelineView } from './components/timeline/TimelineView'
import { FileBay } from './components/bay/FileBay'
import { MixerPanel } from './components/mixer/MixerPanel'
import { ActivityFeed } from './components/ActivityFeed'
import { ChatPanel } from './components/ChatPanel'
import { StatusBar } from './components/StatusBar'
import { usePanels } from './state/panels'
import { useGlobalShortcuts } from './lib/shortcuts'

export default function App(): React.JSX.Element {
  const panelState = usePanels()
  useGlobalShortcuts()

  return (
    <div className="app">
      <TransportBar />
      <div className="app-main">
        <div className="app-center">
          <TimelineView />
          {panelState.bottomPanel === 'files' && <FileBay />}
          {panelState.bottomPanel === 'mixer' && <MixerPanel />}
        </div>
        {panelState.rightPanel === 'activity' && <ActivityFeed />}
        {panelState.rightPanel === 'chat' && <ChatPanel />}
      </div>
      <StatusBar />
    </div>
  )
}
