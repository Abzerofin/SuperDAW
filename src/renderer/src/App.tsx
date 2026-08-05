import { useState } from 'react'
import { TransportBar } from './components/TransportBar'
import { TimelineView } from './components/timeline/TimelineView'
import { FileBay } from './components/bay/FileBay'
import { ActivityFeed } from './components/ActivityFeed'
import { StatusBar } from './components/StatusBar'
import { useGlobalShortcuts } from './lib/shortcuts'

export default function App(): React.JSX.Element {
  const [activityOpen, setActivityOpen] = useState(true)
  const [bayOpen, setBayOpen] = useState(true)
  useGlobalShortcuts()

  return (
    <div className="app">
      <TransportBar
        activityOpen={activityOpen}
        onToggleActivity={() => setActivityOpen((v) => !v)}
        bayOpen={bayOpen}
        onToggleBay={() => setBayOpen((v) => !v)}
      />
      <div className="app-main">
        <div className="app-center">
          <TimelineView />
          {bayOpen && <FileBay />}
        </div>
        {activityOpen && <ActivityFeed />}
      </div>
      <StatusBar />
    </div>
  )
}
