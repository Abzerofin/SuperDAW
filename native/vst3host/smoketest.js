// Manual smoke test: scan this machine's VST3 folders and dump what the
// native addon can read. Run with:  node native/vst3host/smoketest.js
const addon = require('./build/Release/vst3host.node')

const paths = addon.scanPaths()
console.log(`scanPaths() found ${paths.length} bundle(s)\n`)

let ok = 0
let failed = 0
for (const path of paths) {
  const result = addon.inspect(path)
  if (result.error) {
    failed++
    console.log(`FAILED  ${path}\n        ${result.error}`)
    continue
  }
  ok++
  const name = path.split(/[\\/]/).pop()
  console.log(`${name}  (${result.classes.length} audio class(es))`)
  for (const c of result.classes) {
    console.log(`   name       ${c.name}`)
    console.log(`   vendor     ${c.vendor}`)
    console.log(`   version    ${c.version}`)
    console.log(`   uid        ${c.uid}`)
    console.log(`   categories ${c.subCategories}`)
    console.log(`   sdk        ${c.sdkVersion}`)
  }
  console.log()
}

console.log(`--- ${ok} loaded, ${failed} failed ---`)
