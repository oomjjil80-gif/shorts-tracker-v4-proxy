import test from 'node:test'
import assert from 'node:assert/strict'
import { registerSourceAsset, getSourceAsset, listSourceAssets, registryPath, createSourceAssetId, type SourceAssetInput } from '../lib/sourceAssetRegistry.js'

const source: SourceAssetInput = { id: 'fixture', platform: 'www.example.com', originalUrl: 'https://www.example.com/video/1', blobPath: 'source-collector/test/source.mp4', filename: 'source.mp4', bytes: 42, contentType: 'video/mp4', blobUrl: null, duration: 31, width: 576, height: 1024, collectedAt: '2026-09-29T00:00:00Z', sha256: 'a'.repeat(64), videoCodec: 'AVC', audioCodec: 'AAC', title: '원본 제목' }
function store() {
  const records = new Map<string, string>()
  return {
    records, env: { VERCEL_ENV: 'production' },
    put: async (path: string, body: any, options: any) => {
      assert.equal(options.access, 'private'); assert.equal(options.allowOverwrite, false)
      assert.equal(records.has(path), false); records.set(path, String(body))
      return { url: 'https://private.example/' + path } as any
    },
    get: async (path: string, options: any) => {
      assert.equal(options.access, 'private'); assert.equal(options.useCache, false)
      const json = records.get(path)
      return json ? { statusCode: 200, stream: new Response(json).body, blob: { size: json.length } } as any : null
    },
    list: async (options: any) => {
      const keys = [...records.keys()].filter(p => p.startsWith(options.prefix)).sort()
      const start = Number(options.cursor || 0), next = start + options.limit
      return { blobs: keys.slice(start, next).map(pathname => ({ pathname })), hasMore: keys.length > next, cursor: keys.length > next ? String(next) : undefined } as any
    }
  }
}
test('private durable records round-trip by ID and survive independent registry instances', async () => {
  const backend = store()
  const asset = await registerSourceAsset(source, backend)
  assert.deepEqual(await getSourceAsset(asset.sourceAssetId, { ...backend }), asset)
  assert.equal(asset.originalUrl, source.originalUrl); assert.equal(asset.duration, 31)
  assert.ok(asset.createdAt); assert.ok(asset.sourceAssetId)
  assert.equal(backend.records.size, 1)
  assert.equal(JSON.stringify(asset).includes('playbackUrl'), false)
})
test('concurrent collects have unique immutable records and latest pagination loses none', async () => {
  const backend = store()
  const assets = await Promise.all(Array.from({ length: 12 }, () => registerSourceAsset(source, backend)))
  assert.equal(new Set(assets.map(a => a.sourceAssetId)).size, 12)
  const first = await listSourceAssets({ limit: 5 }, backend)
  assert.equal(first.sources.length, 5); assert.equal(first.hasMore, true)
  const rest = await listSourceAssets({ limit: 50, cursor: first.cursor }, backend)
  assert.equal(new Set([...first.sources, ...rest.sources].map(a => a.sourceAssetId)).size, 12)
  assert.deepEqual(first.source, first.sources[0])
  assert.equal(createSourceAssetId(2000) < createSourceAssetId(1000), true)
})
test('preview data is isolated; invalid IDs, path traversal, and invalid limits are rejected', async () => {
  const backend = store()
  const preview = { ...backend, env: { VERCEL_ENV: 'preview' } }
  const asset = await registerSourceAsset(source, preview)
  assert.equal((await listSourceAssets({}, backend)).source, null)
  await assert.rejects(getSourceAsset(asset.sourceAssetId, backend), { code: 'SOURCE_ASSET_NOT_FOUND' })
  assert.deepEqual(await getSourceAsset(asset.sourceAssetId, preview), asset)
  for (const id of ['', '../source-collector/a', 'https://example.com/a', 'src_invalid']) assert.throws(() => registryPath(id))
  for (const limit of [0, -1, 51, 'NaN', 1.1]) await assert.rejects(listSourceAssets({ limit }, backend))
})
test('registry errors fail explicitly instead of returning a non-durable ID', async () => {
  await assert.rejects(registerSourceAsset(source, { ...store(), put: async () => { throw new Error('storage unavailable') } }), { code: 'SOURCE_REGISTRY_WRITE_FAILED', status: 503 })
})
