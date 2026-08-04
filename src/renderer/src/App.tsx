import { useState } from 'react'
import { TransportBar } from './components/TransportBar'
import { TimelineView } from './components/timeline/TimelineView'
import { ActivityFeed } from './components/ActivityFeed'
import { StatusBar } from './components/StatusBar'
import { useGlobalShortcuts } from './lib/shortcuts'

export default function App(): React.JSX.Element {
  const [activityOpen, setActivityOpen] = useState(true)
  useGlobalShortcuts()

  return (
    <div className="app">
      <TransportBar activityOpen={activityOpen} onToggleActivity={() => setActivityOpen((v) => !v)} />
      <div className="app-main">
        <TimelineView />
        {activityOpen && <ActivityFeed />}
      </div>
      <StatusBar />
    </div>
  )
}
