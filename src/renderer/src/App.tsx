import { LegalGate } from './components/LegalGate'
import { useLegalGate } from './state/legalGate'
import { TransportBar } from './components/TransportBar'
import { TimelineView } from './components/timeline/TimelineView'
import { Dock } from './components/Dock'
import { UiPings } from './components/UiPings'
import { StatusBar } from './components/StatusBar'
import { HomeScreen } from './components/home/HomeScreen'
import { SettingsWindow } from './components/settings/SettingsWindow'
import { CommandPalette } from './components/palette/CommandPalette'
import { RoutingPanel } from './components/routing/RoutingPanel'
import { AssetDownloadPrompt } from './components/collab/AssetDownloadPrompt'
import { HistoryPopover } from './components/history/HistoryPopover'
import { FloatingEffects } from './components/fx/FloatingEffects'
import { GameInviteNotification } from './components/game/GameInviteNotification'
import { useEffect } from 'react'
import { useAppShell } from './state/appShell'
import { useGlobalShortcuts } from './lib/shortcuts'
import { installMiddleMouse } from './lib/middleMouse'
import { panels } from './state/panels'

export default function App(): React.JSX.Element {
  const shell = useAppShell()
  const legal = useLegalGate()
  useGlobalShortcuts()
  // Middle button: hold-drag pans any [data-pan] panel, plain click pings.
  useEffect(() => installMiddleMouse(), [])
  // A project always opens with the communication panels tucked away; the
  // buttons' notification bubbles say when they are worth opening.
  useEffect(() => {
    if (shell.view === 'project') {
      panels.closePanel('chat')
      panels.closePanel('activity')
    }
  }, [shell.view])

  if (!legal.accepted) {
    return <LegalGate />
  }

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
      <AssetDownloadPrompt />
      <FloatingEffects />
      <HistoryPopover />
      <UiPings />
      <GameInviteNotification />
    </div>
  )
}
