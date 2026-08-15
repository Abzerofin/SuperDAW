// One-off build tool: rasterizes resources/icon-source.svg into the PNG/ICO
// files the app and installer actually ship. Run via Electron (needs
// BrowserWindow to render the SVG + webfont), not plain Node:
//   node_modules/.bin/electron scripts/generate-icons.cjs
'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SVG_PATH = path.join(ROOT, 'resources', 'icon-source.svg')
const CAPTURE_SIZE = 1024

// PNG sizes we ship. 256/128/64/48/32/16 go into the .ico; 512/1024 stay as
// loose PNGs for build/icon.png (electron-builder's Linux/general fallback)
// and any future high-DPI use.
const SIZES = [1024, 512, 256, 128, 64, 48, 32, 16]
const ICO_SIZES = [256, 128, 64, 48, 32, 16]

async function main() {
  await app.whenReady()

  const svg = fs.readFileSync(SVG_PATH, 'utf8')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;width:${CAPTURE_SIZE}px;height:${CAPTURE_SIZE}px;overflow:hidden}
    svg{width:${CAPTURE_SIZE}px;height:${CAPTURE_SIZE}px;display:block}
  </style></head><body>${svg}</body></html>`
  const tmpHtml = path.join(ROOT, 'scripts', '.icon-render.html')
  fs.writeFileSync(tmpHtml, html, 'utf8')

  const win = new BrowserWindow({
    width: CAPTURE_SIZE,
    height: CAPTURE_SIZE,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false }
  })

  await win.loadFile(tmpHtml)
  // Wait for the Google Font to finish loading before capturing.
  await win.webContents.executeJavaScript(
    'document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 200)))'
  )

  const image = await win.webContents.capturePage()
  fs.unlinkSync(tmpHtml)
  win.destroy()

  const outDir = { resources: path.join(ROOT, 'resources'), build: path.join(ROOT, 'build') }
  const pngBySize = new Map()

  for (const size of SIZES) {
    const resized = image.resize({ width: size, height: size, quality: 'best' })
    pngBySize.set(size, resized.toPNG())
  }

  // Canonical filenames electron-builder / the app itself look for.
  fs.writeFileSync(path.join(outDir.build, 'icon.png'), pngBySize.get(1024))
  fs.writeFileSync(path.join(outDir.resources, 'icon.png'), pngBySize.get(256))
  fs.copyFileSync(SVG_PATH, path.join(outDir.resources, 'icon-source.svg'))

  const icoBuf = buildIco(ICO_SIZES.map((size) => ({ size, png: pngBySize.get(size) })))
  fs.writeFileSync(path.join(outDir.build, 'icon.ico'), icoBuf)
  fs.writeFileSync(path.join(outDir.resources, 'icon.ico'), icoBuf)

  // Small standalone favicon for the browser build (src/renderer/public is
  // Vite's public dir — served/copied to the site root as-is).
  fs.writeFileSync(
    path.join(ROOT, 'src', 'renderer', 'public', 'favicon.png'),
    pngBySize.get(64)
  )

  console.log('Icons written to build/ and resources/.')
  app.quit()
}

// Modern (Vista+) ICO format: each directory entry can hold a raw PNG
// instead of a BMP DIB, which is all we need since we're not targeting
// anything older than Windows 7.
function buildIco(entries) {
  const count = entries.length
  const headerSize = 6
  const dirEntrySize = 16
  const dirSize = count * dirEntrySize

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)

  const dirEntries = []
  const imageBuffers = []
  let offset = headerSize + dirSize

  for (const { size, png } of entries) {
    const entry = Buffer.alloc(dirEntrySize)
    entry.writeUInt8(size >= 256 ? 0 : size, 0) // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1) // height (0 = 256)
    entry.writeUInt8(0, 2) // color palette
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8) // image data size
    entry.writeUInt32LE(offset, 12) // image data offset
    dirEntries.push(entry)
    imageBuffers.push(png)
    offset += png.length
  }

  return Buffer.concat([header, ...dirEntries, ...imageBuffers])
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
