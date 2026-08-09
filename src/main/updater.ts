import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Check GitHub Releases for a newer build; if one exists, download it and
 * install on quit (a native OS notification tells the user it's ready). A
 * no-op for unpackaged runs — `electron .` from source, `npm run dev` —
 * since there is no installed app for it to replace.
 *
 * Works against an unsigned build: NSIS's own updater does not require a
 * code-signing certificate. A cert only removes the SmartScreen prompt a
 * stranger sees on their FIRST download from the website — it has no
 * bearing on whether updates themselves work.
 */
export function checkForUpdates(): void {
  if (!app.isPackaged) return
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('error', (error) => {
    console.error('[updater]', error)
  })
  void autoUpdater.checkForUpdatesAndNotify()
}
