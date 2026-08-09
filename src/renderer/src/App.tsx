import { TransportBar } from './components/TransportBar'
import { TimelineView } from './components/timeline/TimelineView'
import { Dock } from './components/Dock'
import { UiPings } from './components/UiPings'
import { StatusBar } from './components/StatusBar'
import { HomeScreen } from './components/home/HomeScreen'
import { SettingsWindow } from './components/settings/SettingsWindow'
import { CommandPalette } from './components/palette/CommandPalette'
import { RoutingPanel } from './components/routing/RoutingPanel'
import { useAppShell } from './state/appShell'
import { useGlobalShortcuts } from './lib/shortcuts'

export default function App(): React.JSX.Element {
  const shell = useAppShell()
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
          <Dock side="bottom" />
        </div>
        <Dock side="right" />
      </div>
      <StatusBar />
      <SettingsWindow />
      <CommandPalette />
      <RoutingPanel />
      <UiPings />
    </div>
  )
}
