import test from 'node:test'
import assert from 'node:assert/strict'
import { collectSource, readSourceBytes } from '../lib/sourceCollector.js'
import { createSourceAssetId, type SourceAssetInput } from '../lib/sourceAssetRegistry.js'
import { validateDouyinSource, validateDouyinMedia } from '../lib/douyinResolver.js'

const sourceUrl = 'https://www.douyin.com/video/7686048214555031878'
const mediaUrl = 'https://v3-dy-o.zjcdn.com/test.mp4?__vid=7686048214555031878'
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
const assetDeps = {
  probeSourceMedia: async () => ({ duration: 31, width: 576, height: 1024, videoCodec: 'AVC', audioCodec: 'AAC' }),
  registerSourceAsset: async (source: SourceAssetInput) => ({ ...source, sourceAssetId: createSourceAssetId(), createdAt: new Date().toISOString(), schemaVersion: 1 as const })
}
const resolved = { videoId: '7686048214555031878', mediaUrl, filename: 'douyin_test.mp4', title: '原始标题 #영상제목', headers: { 'User-Agent': 'Chromium', Referer: sourceUrl, Accept: '*/*' }, resolver: 'douyin-browser', resolveMs: 10 }

test('Douyin does not require or call Cobalt; stores exactly the returned MP4 bytes', async () => {
  const requests: string[] = []
  let saved: Buffer | undefined
  const result = await collectSource({ sourceUrl }, {
    ...assetDeps, env: {},
    resolveDouyin: async url => { assert.equal(url, sourceUrl); return resolved },
    fetch: async (url, options) => { requests.push(String(url)); assert.equal(new Headers(options?.headers).get('Authorization'), null); return new Response(mp4) },
    put: async (path, body, options) => { saved = body as Buffer; assert.equal(options?.access, 'private'); assert.match(path, /^source-collector\//); return { url: 'https://example.invalid/blob' } as any }
  })
  assert.deepEqual(requests, [mediaUrl])
  assert.deepEqual(saved, mp4)
  assert.match(result.sourceAssetId!, /^src_/)
  assert.equal(result.source?.duration, 31)
  assert.equal(result.ok, true)
  assert.equal(result.needsSelection, false)
  assert.equal(result.source?.bytes, mp4.length)
  assert.ok(result.source?.blobPath)
  assert.equal(result.source?.title, resolved.title)
  assert.match(result.source!.blobPath, /^[\x20-\x7e]+$/)
})

test('Instagram keeps its Cobalt request, media authentication and source response', async () => {
  let calls = 0
  const instagram = 'https://www.instagram.com/reel/DZcosYrM7n6/'
  const result = await collectSource({ sourceUrl: instagram }, {
    ...assetDeps, env: { COBALT_API_URL: 'https://cobalt.example/', COBALT_API_KEY: 'fixture-key' },
    resolveDouyin: async () => { throw new Error('Instagram must not launch Chromium') },
    fetch: async (url, options) => {
      calls++
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Api-Key fixture-key')
      if (calls === 1) {
        assert.equal(String(url), 'https://cobalt.example/')
        assert.deepEqual(JSON.parse(String(options?.body)), { url: instagram, downloadMode: 'auto', videoQuality: '1080', filenameStyle: 'basic', youtubeVideoCodec: 'h264' })
        return Response.json({ status: 'tunnel', url: 'https://cobalt.example/tunnel', filename: 'instagram.mp4' })
      }
      assert.equal(String(url), 'https://cobalt.example/tunnel')
      return new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
    },
    put: async () => ({ url: 'https://example.invalid/blob' }) as any
  })
  assert.equal(calls, 2)
  assert.equal(result.source?.filename, 'instagram.mp4')
  assert.equal(result.source?.originalUrl, instagram)
})

test('Cobalt picker still returns without downloading or storing anything', async () => {
  const picker = { status: 'picker', picker: [{ url: 'https://example.invalid/photo' }] }
  const result = await collectSource({ sourceUrl: 'https://www.instagram.com/p/test/' }, {
    ...assetDeps, env: { COBALT_API_URL: 'https://cobalt.example' },
    resolveDouyin: async () => { throw new Error('unexpected browser') },
    fetch: async () => Response.json(picker),
    put: async () => { throw new Error('unexpected upload') }
  })
  assert.equal(result.needsSelection, true)
  assert.deepEqual(result.picker, picker)
})

test('empty, HTML and oversized Douyin responses never reach Blob', async () => {
  for (const payload of [Buffer.alloc(0), Buffer.from('<html>verification required</html>'), Buffer.alloc(101)]) {
    await assert.rejects(collectSource({ sourceUrl }, {
      ...assetDeps, env: { SOURCE_COLLECTOR_MAX_BYTES: '100' }, resolveDouyin: async () => resolved,
      fetch: async () => new Response(payload),
      put: async () => { assert.fail('invalid data reached Blob') }
    }))
  }
  await assert.rejects(readSourceBytes(new Response(mp4, { status: 403 }), 100), /403/)
})

test('rejects another video and prevents CDN redirects to an arbitrary server', async () => {
  assert.throws(() => validateDouyinMedia('https://v3-dy-o.zjcdn.com/a?__vid=123', resolved.videoId), /different video/)
  assert.throws(() => validateDouyinSource('https://www.douyin.com.evil.example/video/7686048214555031878'))
  assert.throws(() => validateDouyinSource('https://www.douyin.com@127.0.0.1/video/7686048214555031878'))
  let calls = 0
  await assert.rejects(collectSource({ sourceUrl }, {
    ...assetDeps, env: {}, resolveDouyin: async () => resolved,
    fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) },
    put: async () => { assert.fail('unexpected upload') }
  }), /unexpected media host/)
  assert.equal(calls, 1)
})

 test('collection never reports success if the durable registry write fails', async () => {
  let uploaded = false
  await assert.rejects(collectSource({ sourceUrl }, {
    ...assetDeps, env: {}, resolveDouyin: async () => resolved,
    fetch: async () => new Response(mp4),
    put: async () => { uploaded = true; return { url: 'https://example.invalid/blob' } as any },
    registerSourceAsset: async () => { assert.equal(uploaded, true); throw new Error('registry unavailable') }
  }), /registry unavailable/)
})
