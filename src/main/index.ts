import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { asBuffer, writeFileAtomic } from './atomicWrite'
import { readAppData, setAppData } from './appData'
import { registerCollabIpc } from './collabServer'
import { registerRecoveryIpc } from './recovery'
import { registerVst3Ipc } from './vst3'
import { checkForUpdates } from './updater'
import { ensureScanned } from './pluginScan'

const PROJECT_FILTERS = [{ name: 'SuperDAW Project', extensions: ['sdaw'] }]

function registerAppDataIpc(): void {
  ipcMain.handle('appdata:get', async (_event, key: string): Promise<unknown> => {
    return (await readAppData())[key] ?? null
  })

  ipcMain.handle('appdata:set', async (_event, key: string, value: unknown): Promise<void> => {
    await setAppData(key, value)
  })
}

function registerIpc(): void {
  // Save project bytes. Shows a Save dialog unless a known path is passed
  // (plain Ctrl+S re-save). Returns the path written, or null if cancelled.
  ipcMain.handle(
    'project:save',
    async (
      event,
      args: { data: Uint8Array; path: string | null; defaultName: string }
    ): Promise<string | null> => {
      let filePath = args.path
      if (!filePath) {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) return null
        const result = await dialog.showSaveDialog(win, {
          defaultPath: args.defaultName,
          filters: PROJECT_FILTERS
        })
        if (result.canceled || !result.filePath) return null
        filePath = result.filePath
      }
      await writeFileAtomic(filePath, asBuffer(args.data))
      return filePath
    }
  )

  ipcMain.handle(
    'project:open',
    async (event): Promise<{ path: string; name: string; data: Uint8Array } | null> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return null
      const result = await dialog.showOpenDialog(win, {
        filters: PROJECT_FILTERS,
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const path = result.filePaths[0]
      // A Buffer IS a Uint8Array; returning it directly avoids copying the
      // whole project file before the IPC clone (which copies once anyway).
      const data = await readFile(path)
      return { path, name: basename(path), data }
    }
  )

  // Open a project by known path (the home screen's recent list / Open
  // Recent menu). Null when the file is gone — the renderer prunes it.
  ipcMain.handle(
    'project:open-path',
    async (_event, path: string): Promise<{ path: string; name: string; data: Uint8Array } | null> => {
      try {
        const data = await readFile(path)
        return { path, name: basename(path), data }
      } catch {
        return null
      }
    }
  )

  // Generic single-file picker (e.g. track presets). Null = cancelled.
  ipcMain.handle(
    'file:open',
    async (
      event,
      args: { filterName: string; ext: string }
    ): Promise<{ path: string; name: string; data: Uint8Array } | null> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return null
      const result = await dialog.showOpenDialog(win, {
        filters: [{ name: args.filterName, extensions: [args.ext] }],
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const path = result.filePaths[0]
      const data = await readFile(path)
      return { path, name: basename(path), data }
    }
  )

  // Arbitrary byte export (WAV mixdowns). Always shows a save dialog.
  ipcMain.handle(
    'file:export',
    async (
      event,
      args: { data: Uint8Array; defaultName: string; filterName: string; ext: string }
    ): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return null
      const result = await dialog.showSaveDialog(win, {
        defaultPath: args.defaultName,
        filters: [{ name: args.filterName, extensions: [args.ext] }]
      })
      if (result.canceled || !result.filePath) return null
      await writeFileAtomic(result.filePath, asBuffer(args.data))
      return result.filePath
    }
  )
}

/** Renderer-reported unsaved-changes flag, per window. */
const dirtyWindows = new Set<number>()

function registerCloseGuard(win: BrowserWindow): void {
  let closing = false
  // Captured now: by the time 'closed' fires the window is destroyed and
  // touching win.webContents throws "Object has been destroyed".
  const webContentsId = win.webContents.id

  win.on('close', (e) => {
    if (closing || !dirtyWindows.has(webContentsId)) return
    e.preventDefault()
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        message: 'Save changes before closing?',
        detail: 'The project has unsaved changes.',
        buttons: ['Save', 'Discard', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
      .then(({ response }) => {
        // The dialog is async: the window can be gone by the time it
        // resolves (app quit, window closed another way).
        if (win.isDestroyed()) return
        if (response === 2) return // Cancel
        if (response === 1) {
          closing = true
          win.close()
          return
        }
        // Save: ask the renderer (it owns the project bytes), close on success.
        const onSaveDone = (_event: Electron.IpcMainEvent, saved: boolean): void => {
          if (!saved) return // user cancelled the save dialog — stay open
          ipcMain.removeListener('project:save-done', onSaveDone)
          if (win.isDestroyed()) return
          closing = true
          win.close()
        }
        // `once` would leave a stale listener behind whenever the renderer
        // reports a cancelled save, so the handler is removed explicitly:
        // on cancel it stays armed for the next attempt, and 'closed'
        // clears it if the window goes away first.
        ipcMain.on('project:save-done', onSaveDone)
        win.once('closed', () => ipcMain.removeListener('project:save-done', onSaveDone))
        win.webContents.send('project:save-request')
      })
  })

  win.on('closed', () => dirtyWindows.delete(webContentsId))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#141518',
    title: 'SuperDAW',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      // A DAW's AudioContext must never be gated on a user gesture.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  // Guarded: a window closed while still loading is already destroyed by
  // the time this fires, and show() would throw in the main process.
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  registerCloseGuard(win)

  // External links open in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.on('project:set-dirty', (event, dirty: boolean) => {
  if (dirty) dirtyWindows.add(event.sender.id)
  else dirtyWindows.delete(event.sender.id)
})

app.whenReady().then(() => {
  // No menu bar in production — everything is in-app (dev keeps the
  // default menu for DevTools/reload).
  if (!process.env['ELECTRON_RENDERER_URL']) Menu.setApplicationMenu(null)
  registerIpc()
  registerAppDataIpc()
  registerCollabIpc()
  registerRecoveryIpc()
  registerVst3Ipc()
  createWindow()
  checkForUpdates()
  // Warm the plugin index in the background. It runs out of process and
  // is cached, so this costs nothing on a normal launch but means the
  // first plugin browse is instant instead of loading every bundle then.
  void ensureScanned()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
