import test from 'node:test'
import assert from 'node:assert/strict'
import { createVercelJobBlobStore } from '../lib/jobs/blobs.js'

test('Vercel blob store skips immutable puts when HEAD says the path already exists', async () => {
  const existing = new Set(['plans/existing.json', 'renders/existing.mp4'])
  let puts = 0
  let heads = 0
  const deps = {
    async head(path: string) {
      heads++
      if (existing.has(path)) return { pathname: path }
      const error: any = new Error('Blob not found')
      error.name = 'BlobNotFoundError'
      throw error
    },
    async put(path: string) {
      puts++
      existing.add(path)
      return { pathname: path }
    },
    async get() { return null }
  }

  const store = createVercelJobBlobStore(deps)

  await store.putJson('plans/existing.json', { same: true })
  await store.putBytes('renders/existing.mp4', Buffer.from('same'), 'video/mp4')
  assert.equal(puts, 0, 'existing immutable blobs must not issue PUT')

  await store.putJson('plans/new.json', { fresh: true })
  assert.equal(puts, 1)
  assert.ok(existing.has('plans/new.json'))

  const headsBeforeOverwrite = heads
  await store.putJson('generative-sources/job.json', { pointer: 2 }, { overwrite: true })
  assert.equal(puts, 2, 'mutable pointers still overwrite')
  assert.equal(heads, headsBeforeOverwrite, 'overwrite does not waste a HEAD check')
})
