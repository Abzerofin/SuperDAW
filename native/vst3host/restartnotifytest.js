// Does a plugin's "re-read my parameters" notification reach JS?
//
// When a plugin changes many parameters at once with no per-parameter
// gesture — loading a preset from its OWN browser is the everyday case —
// it tells the host through IComponentHandler::restartComponent with
// kParamValuesChanged ("as result of a program change for example. The
// host invalidates all caches of parameter values and asks the edit
// controller for the current values"). SuperDAW answers by re-reading via
// getEditorParams and publishing a plugin/setParams, so collaborators who
// cannot run the plugin stop seeing factory defaults.
//
// A preset load cannot be driven from a script, so this is INTERACTIVE:
// it opens the editor and reports notifications as they arrive. Load a
// preset in the plugin's own browser and watch.
//
//   node native/vst3host/restartnotifytest.js [pluginName] [secondsToHold]
//
// Note a plugin is right to stay silent when the HOST set the state (it
// already knows) — so opening with a restored chunk proves nothing either
// way. Only a change the plugin makes itself should notify.
const addon = require('./build/Release/vst3host.node')

const want = process.argv[2] ?? 'MSaturator'
const holdSec = Number(process.argv[3] ?? 3)

const path = addon.scanPaths().find((p) => p.includes(want))
if (!path) {
  console.log(`SKIP: ${want} not installed on this machine`)
  process.exit(0)
}
const cls = addon.inspect(path).classes[0]
const params = addon.parameters(path, cls.uid).parameters.filter((q) => !q.isBypass)
console.log(`${path.split(/[\\/]/).pop()} — ${params.length} automatable parameter(s)`)
if (params.length === 0) {
  // A GUI-only plugin keeps everything in its state chunk, so there are no
  // values for the document to carry and nothing for this to observe.
  console.log('GUI-only plugin: no parameters to snapshot, nothing to probe')
  process.exit(0)
}

const events = []
const opened = addon.openEditor(path, cls.uid, {
  title: 'restart notification probe',
  onEvent: (e) => {
    events.push(e.type)
    if (e.type === 'restart') {
      const now = addon.getEditorParams(opened.editor)
      const n = Object.keys(now.params ?? {}).length
      console.log(`  restart -> re-read ${n} parameter(s) from the live controller`)
    }
  }
})
if (opened.error || opened.editor === undefined) {
  console.log('openEditor FAILED: ' + (opened.error ?? 'no handle'))
  process.exit(1)
}
console.log(`editor open — load a preset in it. Holding ${holdSec}s...`)

setTimeout(() => {
  const restarts = events.filter((t) => t === 'restart').length
  addon.closeEditor(opened.editor)
  console.log(`events: ${JSON.stringify([...new Set(events)])}`)
  console.log(`restart notifications observed: ${restarts}`)
  process.exit(0)
}, holdSec * 1000)
