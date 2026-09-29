// Copies the RenderManifest compiler (and the files it needs) verbatim from the Tracker frontend into
// lib/tracker-core, and pins them to the frontend's tools/tracker-core.manifest.json.
//   node tools/sync-tracker-core.mjs [--from ../shorts-production-tracker-web]   copy + verify
//   node tools/sync-tracker-core.mjs --check                                    verify local copies only
// The frontend and the Worker must never compile differently: tools/tracker-core.test.ts enforces it.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const here = new URL('../', import.meta.url)
const dest = new URL('lib/tracker-core/', here)
const sha = (b) => createHash('sha256').update(b).digest('hex')
const args = process.argv.slice(2)
const check = args.includes('--check')
const fromIdx = args.indexOf('--from')
const frontend = resolve(fromIdx >= 0 ? args[fromIdx + 1] : process.env.TRACKER_FRONTEND_DIR || '../shorts-production-tracker-web')

if (!check) {
  const manifest = JSON.parse(readFileSync(`${frontend}/tools/tracker-core.manifest.json`, 'utf8'))
  mkdirSync(dest, { recursive: true })
  for (const f of Object.keys(manifest.files)) {
    const buf = readFileSync(`${frontend}/js_v420a12/${f}`)
    if (sha(buf) !== manifest.files[f]) throw new Error(`frontend ${f} does not match its own tracker-core.manifest.json (run --write there first)`)
    writeFileSync(new URL(f, dest), buf)
  }
  writeFileSync(new URL('job-compile-golden.json', dest), readFileSync(`${frontend}/tools/fixtures/job-compile-golden.json`))
  writeFileSync(new URL('tracker-core.manifest.json', dest), readFileSync(`${frontend}/tools/tracker-core.manifest.json`))
  console.log('synced', Object.keys(manifest.files).length, 'files')
}

const manifest = JSON.parse(readFileSync(new URL('tracker-core.manifest.json', dest), 'utf8'))
const bad = []
for (const [f, h] of Object.entries(manifest.files)) {
  if (!existsSync(new URL(f, dest)) || sha(readFileSync(new URL(f, dest))) !== h) bad.push(f)
}
if (sha(readFileSync(new URL('job-compile-golden.json', dest))) !== manifest.goldenFixtureSha256) bad.push('job-compile-golden.json')
if (bad.length) { console.error('DRIFT:', bad.join(', ')); process.exit(1) }
console.log('tracker-core in sync')
