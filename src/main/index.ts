import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { registerCollabIpc } from './collabServer'

const PROJECT_FILTERS = [{ name: 'SuperDAW Project', extensions: ['sdaw'] }]

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
      await writeFile(filePath, Buffer.from(args.data))
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
      const data = await readFile(path)
      return { path, name: basename(path), data: new Uint8Array(data) }
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
      await writeFile(result.filePath, Buffer.from(args.data))
      return result.filePath
    }
  )
}

/** Renderer-reported unsaved-changes flag, per window. */
const dirtyWindows = new Set<number>()

function registerCloseGuard(win: BrowserWindow): void {
  let closing = false
  win.on('close', (e) => {
    if (closing || !dirtyWindows.has(win.webContents.id)) return
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
        if (response === 2) return // Cancel
        if (response === 1) {
          closing = true
          win.close()
          return
        }
        // Save: ask the renderer (it owns the project bytes), close on success.
        ipcMain.once('project:save-done', (_event, saved: boolean) => {
          if (!saved) return // user cancelled the save dialog — stay open
          closing = true
          win.close()
        })
        win.webContents.send('project:save-request')
      })
  })
  win.on('closed', () => dirtyWindows.delete(win.webContents.id))
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

  win.once('ready-to-show', () => win.show())
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
  registerCollabIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
