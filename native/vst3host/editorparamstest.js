// getEditorParams: does the addon report a live editor's ACTUAL parameter
// values — including ones the document never set?
//
// This is the case the feature exists for: a plugin whose settings arrived
// via a state chunk (a preset load) changes many parameters without one
// performEdit per parameter, so SuperDAW's param map never learns them and
// collaborators without the plugin see factory defaults instead.
//
// A: instance with Dry/Wet forced to 0 -> capture its state chunk
// B: open an EDITOR from that chunk    -> getEditorParams must report ~0
//                                         for Dry/Wet, not the default
// then setEditorParam must be visible through getEditorParams (round trip).
//
//   node native/vst3host/editorparamstest.js
const addon = require('./build/Release/vst3host.node')

const SR = 48000
const sine = new Float32Array(SR)
for (let i = 0; i < SR; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR)

const path = addon.scanPaths().find((p) => p.includes('MSaturator'))
if (!path) {
  console.log('SKIP: MSaturator not installed on this machine')
  process.exit(0)
}
const cls = addon.inspect(path).classes[0]
const wet = addon.parameters(path, cls.uid).parameters.find((q) => q.title === 'Dry/Wet')
console.log(`Dry/Wet id=${wet.id} default=${wet.defaultNormalized}`)

// A: drive Dry/Wet to 0 on a processing instance, then capture the chunk.
const a = addon.openInstance(path, cls.uid, { sampleRate: SR, channels: 2 })
addon.processInstance(a.handle, { channels: [sine, sine], params: { [wet.id]: 0 } })
const captured = addon.getInstanceState(a.handle)
addon.closeInstance(a.handle)
if (captured.error) {
  console.log('getInstanceState FAILED: ' + captured.error)
  process.exit(1)
}

// B: an editor restored from that chunk. Its Dry/Wet is 0, but nothing ever
// told the document so — this read-back is the only way to find out.
const opened = addon.openEditor(path, cls.uid, {
  title: 'getEditorParams test',
  state: captured.component,
  onEvent: () => {}
})
if (opened.error || opened.editor === undefined) {
  console.log('openEditor FAILED: ' + (opened.error ?? 'no handle'))
  process.exit(1)
}

const read = addon.getEditorParams(opened.editor)
if (read.error) {
  console.log('getEditorParams FAILED: ' + read.error)
  addon.closeEditor(opened.editor)
  process.exit(1)
}
const keys = Object.keys(read.params)
const restored = read.params[String(wet.id)]
console.log(`getEditorParams returned ${keys.length} params`)
console.log(`Dry/Wet reads back ${restored}  (chunk set it to 0)`)

// Round trip: write a value, read it back.
addon.setEditorParam(opened.editor, wet.id, 0.75)
const after = addon.getEditorParams(opened.editor).params[String(wet.id)]
console.log(`after setEditorParam(0.75) reads ${after}`)

addon.closeEditor(opened.editor)

const reflectsChunk = restored !== undefined && Math.abs(restored - 0) < 0.01
const roundTrips = Math.abs(after - 0.75) < 0.01
const bypassExcluded = !keys.some(
  (k) => Number(k) === (addon.parameters(path, cls.uid).parameters.find((q) => q.isBypass)?.id ?? -1)
)
console.log(`reports non-default state from chunk: ${reflectsChunk ? 'YES' : 'NO'}`)
console.log(`set -> get round trips:                ${roundTrips ? 'YES' : 'NO'}`)
console.log(`bypass excluded (matches paramDefs):   ${bypassExcluded ? 'YES' : 'NO'}`)
process.exit(reflectsChunk && roundTrips && bypassExcluded ? 0 : 1)
