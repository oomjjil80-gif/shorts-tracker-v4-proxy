import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// The only video input is the original source URL. No pre-resolved CDN URL,
// local upload, fixture bytes, or saved Blob can make this check pass.
const base = process.env.TRACKER_API_BASE || 'https://shorts-tracker-v4-proxy.vercel.app'
const sourceUrl = process.argv[2] || 'https://www.douyin.com/video/7686048214555031878'
const output = resolve(process.env.E2E_OUTPUT_DIR || '.e2e')
await mkdir(output, { recursive: true })
const report = { startedAt: new Date().toISOString(), base, sourceUrl, passed: false }
async function post(body) {
  const response = await fetch(base + '/api/story', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(175_000) })
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`HTTP ${response.status}: ${text.slice(0, 250)}`) }
  return { httpStatus: response.status, data }
}
try {
  report.collect = await post({ taskType: 'source_collect', sourceUrl })
  const collected = report.collect.data
  assert.equal(report.collect.httpStatus, 200, JSON.stringify(collected))
  assert.equal(collected.ok, true)
  assert.equal(collected.needsSelection, false)
  assert.ok(collected.source?.sourceAssetId)
  assert.equal(collected.sourceAssetId, collected.source.sourceAssetId)
  assert.ok(collected.source?.blobPath)
  assert.ok(collected.source.duration > 0)
  assert.ok(collected.source.width > 0 && collected.source.height > 0)
  assert.ok(collected.source.bytes > 0)
  console.log(JSON.stringify({ stage: 'source_collect', ok: true, source: collected.source }))

  // All lookups after collection use only the opaque ID, in a separate request.
  const sourceAssetId = collected.source.sourceAssetId
  report.asset = await post({ taskType: 'source_asset', sourceAssetId })
  assert.equal(report.asset.httpStatus, 200)
  assert.equal(report.asset.data.ok, true)
  assert.deepEqual(report.asset.data.source, collected.source)
  const playback = await post({ taskType: 'source_playback', sourceAssetId })
  report.playback = { httpStatus: playback.httpStatus, ok: playback.data.ok === true, error: playback.data.error }
  assert.equal(playback.httpStatus, 200, JSON.stringify(playback.data.error))
  assert.equal(playback.data.ok, true)
  assert.ok(playback.data.playbackUrl)
  // Do not put the temporary signed playback credential in logs or reports.
  report.playback = { httpStatus: playback.httpStatus, ok: true, validUntil: playback.data.validUntil, playbackHost: new URL(playback.data.playbackUrl).hostname }
  const head = await fetch(playback.data.playbackUrl, { method: 'HEAD', signal: AbortSignal.timeout(30_000) })
  report.head = { status: head.status, contentType: head.headers.get('content-type'), contentLength: head.headers.get('content-length') }
  const media = await fetch(playback.data.playbackUrl, { signal: AbortSignal.timeout(60_000) })
  assert.equal(media.status, 200)
  const bytes = Buffer.from(await media.arrayBuffer())
  assert.equal(bytes.length, collected.source.bytes)
  assert.equal(bytes.toString('ascii', 4, 8), 'ftyp')
  report.media = { status: media.status, bytes: bytes.length, contentType: media.headers.get('content-type'), sha256: createHash('sha256').update(bytes).digest('hex'), mp4Signature: true }
  assert.equal(report.media.sha256, collected.source.sha256)
  await writeFile(resolve(output, 'playback.mp4'), bytes)
  report.latest = await post({ taskType: 'source_latest', limit: 10 })
  assert.equal(report.latest.httpStatus, 200)
  assert.equal(report.latest.data.ok, true)
  assert.ok(report.latest.data.sources.some(s => s.sourceAssetId === sourceAssetId))
  const readOnly = await fetch(base + '/api/story?taskType=source_asset&sourceAssetId=' + sourceAssetId)
  assert.equal(readOnly.status, 200)
  assert.match(readOnly.headers.get('cache-control'), /no-store/)
  assert.deepEqual((await readOnly.json()).source, collected.source)
  const recentGet = await fetch(base + '/api/story?taskType=source_latest&limit=10')
  assert.equal(recentGet.status, 200)
  assert.ok((await recentGet.json()).sources.some(s => s.sourceAssetId === sourceAssetId))
  // Keep existing Episodes with only blobPath working too.
  const legacy = await post({ taskType: 'source_playback', blobPath: collected.source.blobPath })
  assert.equal(legacy.data.ok, true)
  const legacyMedia = await fetch(legacy.data.playbackUrl, { headers: { Range: 'bytes=0-11' } })
  assert.ok([200, 206].includes(legacyMedia.status))
  assert.equal(Buffer.from(await legacyMedia.arrayBuffer()).toString('ascii', 4, 8), 'ftyp')
  report.legacyPlayback = { ok: true, status: legacyMedia.status }
  // The unsigned Blob itself must remain private.
  const unsigned = await fetch(collected.source.blobUrl, { headers: { Range: 'bytes=0-11' } })
  await unsigned.body?.cancel()
  assert.ok([401, 403, 404].includes(unsigned.status))
  report.unsignedBlob = { status: unsigned.status, private: true }
  console.log(JSON.stringify({ stage: 'registry', sourceAssetId, metadata: true, latest: true, idPlayback: true, legacyPlayback: true, unsignedBlobStatus: unsigned.status }))
  report.passed = true
  console.log(JSON.stringify({ stage: 'playback_GET', ...report.media, ok: true }))
} catch (error) {
  report.error = error.message
  console.error(error.message)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, reportPath: resolve(output, 'report.json') }))
}
