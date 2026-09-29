import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Vercel Hobby: at most 12 Serverless Functions per deployment. Every api/**/*.{ts,js} file is one function,
// and the Express entry (src/index.ts) is one more. Shared code must live in lib/ (not counted).
const HOBBY_LIMIT = 12

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
}

test(`Serverless Function count stays within the Hobby limit (${HOBBY_LIMIT})`, () => {
  const apiFiles = walk('api').filter((f) => /\.(ts|js|mjs)$/.test(f) && !/\.(test|d)\.ts$/.test(f))
  const entry = ['src/index.ts', 'src/index.js', 'index.ts', 'server.ts'].filter((f) => existsSync(f))
  const functions = [...apiFiles, ...entry.slice(0, 1)]
  assert.ok(functions.length <= HOBBY_LIMIT, `${functions.length} functions > ${HOBBY_LIMIT}:\n${functions.join('\n')}`)
  assert.ok(!apiFiles.includes(join('api', 'jobs.ts')), 'jobs must be routed through api/story.ts (job_* taskTypes), not its own function')
})
