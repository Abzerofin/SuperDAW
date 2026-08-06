import { TransportBar } from './components/TransportBar'
import { TimelineView } from './components/timeline/TimelineView'
import { BottomDock } from './components/BottomDock'
import { ActivityFeed } from './components/ActivityFeed'
import { ChatPanel } from './components/ChatPanel'
import { StatusBar } from './components/StatusBar'
import { HomeScreen } from './components/home/HomeScreen'
import { SettingsWindow } from './components/settings/SettingsWindow'
import { CommandPalette } from './components/palette/CommandPalette'
import { RoutingPanel } from './components/routing/RoutingPanel'
import { usePanels } from './state/panels'
import { useAppShell } from './state/appShell'
import { useGlobalShortcuts } from './lib/shortcuts'

export default function App(): React.JSX.Element {
  const shell = useAppShell()
  const panelState = usePanels()
  useGlobalShortcuts()

  if (shell.view === 'home') {
    return (
      <>
        <HomeScreen />
        <SettingsWindow />
      </>
    )
  }

  return (
    <div className="app">
      <TransportBar />
      <div className="app-main">
        <div className="app-center">
          <TimelineView />
          <BottomDock />
        </div>
        {panelState.rightPanel === 'activity' && <ActivityFeed />}
        {panelState.rightPanel === 'chat' && <ChatPanel />}
      </div>
      <StatusBar />
      <SettingsWindow />
      <CommandPalette />
      <RoutingPanel />
    </div>
  )
}
