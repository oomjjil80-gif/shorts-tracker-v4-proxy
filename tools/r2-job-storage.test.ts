// Production Jobs on Cloudflare R2 (Railway continuity API + worker): new job writes go to R2, presigned URLs are R2,
// Vercel Blob gets no new writes, and 60-120+ minute files are streamed (never read whole into memory).
// R2 is a local S3 stand-in behind fetch; Vercel Blob calls (its own undici client) are recorded by a MockAgent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, truncate, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { createVercelJobBlobStore, sha256File } from '../lib/jobs/blobs.js'
import { storageBackend } from '../lib/objectStorage.js'

const R2 = 'https://acct.r2.cloudflarestorage.com', BUCKET = 'tracker'
const ENV = { R2_ENDPOINT: R2, R2_BUCKET: BUCKET, R2_ACCESS_KEY_ID: 'AKIDTEST', R2_SECRET_ACCESS_KEY: 'secret', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_teststore_secret' }

function installStorage() {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v }
  const objects = new Map<string, { size: number; sha256: string; bytes?: Buffer }>(), r2: any[] = [], vercel: any[] = []
  let maxChunk = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input)), method = String(init.method || 'GET')
    assert.equal(url.origin, R2, `only R2 is reached through fetch (got ${url.origin})`)
    const key = decodeURIComponent(url.pathname.replace(new RegExp(`^/${BUCKET}/?`), ''))
    r2.push({ method, key, headers: init.headers || {}, query: url.search })
    if (method === 'PUT') {
      const h = createHash('sha256'); let size = 0; const keep: Buffer[] = []
      const body = init.body
      if (body && typeof body.getReader === 'function') { // streamed file body
        const reader = body.getReader()
        for (;;) { const { done, value } = await reader.read(); if (done) break; const b = Buffer.from(value); size += b.length; maxChunk = Math.max(maxChunk, b.length); h.update(b); if (size <= 4 << 20) keep.push(b) }
      } else { const b = Buffer.from(typeof body === 'string' ? body : body ?? ''); size = b.length; h.update(b); keep.push(b) }
      objects.set(key, { size, sha256: h.digest('hex'), bytes: size <= 4 << 20 ? Buffer.concat(keep) : undefined })
      return new Response('', { status: 200, headers: { etag: '"x"' } })
    }
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || ''
      const xml = [...objects].filter(([k]) => k.startsWith(prefix)).map(([k, o]) => `<Contents><Key>${k}</Key><Size>${o.size}</Size></Contents>`).join('')
      return new Response(`<ListBucketResult>${xml}<IsTruncated>false</IsTruncated></ListBucketResult>`, { status: 200 })
    }
    const o = objects.get(key)
    if (!o) return new Response('', { status: 404 })
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(o.size) } })
    return new Response(new Uint8Array(o.bytes ?? Buffer.alloc(0)), { status: 200, headers: { 'content-length': String(o.size), 'content-type': 'application/octet-stream' } })
  }) as any
  const agent = new MockAgent(); agent.disableNetConnect()
  const reply = (opts: any) => { vercel.push({ method: opts.method, path: opts.path }); return { statusCode: 404, data: JSON.stringify({ error: { code: 'not_found', message: 'The requested blob does not exist' } }) } }
  agent.get('https://vercel.com').intercept({ path: () => true, method: () => true }).reply(reply).persist()
  agent.get(/blob\.vercel-storage\.com$/).intercept({ path: () => true, method: () => true }).reply(reply).persist()
  const prev = getGlobalDispatcher(); setGlobalDispatcher(agent)
  return {
    objects, r2, vercel, maxChunk: () => maxChunk,
    vercelWrites: () => vercel.filter((v) => !['GET', 'HEAD'].includes(String(v.method).toUpperCase())),
    restore() { globalThis.fetch = realFetch; setGlobalDispatcher(prev); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
  }
}

test('Job API on R2: a 60-minute female-middle wisdom_longform job is accepted; brief written/read on R2; presign is R2; 0 Vercel Blob writes', async () => {
  const s = installStorage()
  try {
    assert.equal(storageBackend(), 'r2')
    const db = await createTestDb(), store = createJobStore(db), blobs = createVercelJobBlobStore()
    const handler = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true })
    let status = 0, json: any = null
    await handler({ method: 'POST', headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': 'k'.repeat(32) }, query: {}, body: { taskType: 'job_create', profile: 'wisdom_longform', idempotencyKey: 'lf-r2-60min-0001', budgetUsd: 5, input: { kind: 'topic', text: '부처님이 말하는 마음 다스리는 법', targetSeconds: 3600, voiceProfile: 'female-middle', language: 'ko', aspectRatio: '16:9' } } } as any,
      { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } } as any)
    assert.equal(status, 201, JSON.stringify(json))
    const job: any = await store.getJob(json.job.id, json.job.workspaceId) ?? json.job
    const planRef = job.planRef ?? json.job.planRef
    assert.match(planRef, /^generative-briefs\/[0-9a-f]{64}\.json$/)
    assert.ok(s.r2.some((r) => r.method === 'PUT' && r.key === planRef), 'brief PUT to R2')
    const brief: any = await blobs.getJson(planRef) // read back from R2
    assert.equal(brief.targetSeconds, 3600); assert.equal(brief.voice.key, 'female-middle'); assert.equal(brief.voice.profileId, 'ko-lf-female-middle-calm-1.0-v2'); assert.deepEqual([brief.voice.tone, brief.voice.speed], ['calm', 1])
    assert.ok(s.r2.some((r) => r.method === 'GET' && r.key === planRef))
    const signed = await blobs.presign!(planRef)
    assert.ok(signed && signed.url.startsWith(`${R2}/${BUCKET}/generative-briefs/`) && /X-Amz-Signature=/.test(signed.url), signed?.url)
    assert.deepEqual(s.vercelWrites(), [], 'no new Vercel Blob write on the job path')
  } finally { s.restore() }
})

test('final MP4 / narration: streamed sha256 + streamed R2 upload (bounded memory), same renders/<sha>.mp4 contract, retry does not re-upload', async () => {
  const s = installStorage()
  try {
    const d = await mkdtemp(join(tmpdir(), 'r2-stream-'))
    // correctness of the streamed hash on real bytes
    const small = join(d, 'small.bin'); const bytes = randomBytes(3 << 20); await writeFile(small, bytes)
    assert.equal(await sha256File(small), createHash('sha256').update(bytes).digest('hex'))
    // a 768 MB file (sparse; the size of a long final MP4) hashed and uploaded as a stream
    const big = join(d, 'final.mp4'); await writeFile(big, ''); await truncate(big, 768 << 20)
    const blobs = createVercelJobBlobStore()
    let peak = 0; const base = process.memoryUsage().rss
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss - base) }, 20)
    const digest = await sha256File(big)
    const out = await blobs.putFile(`renders/${digest}.mp4`, big, 'video/mp4')
    clearInterval(timer); peak = Math.max(peak, process.memoryUsage().rss - base)
    assert.deepEqual(out, { path: `renders/${digest}.mp4`, bytes: 768 << 20, uploaded: true })
    const put = s.r2.find((r) => r.method === 'PUT' && r.key === `renders/${digest}.mp4`)
    assert.equal(put.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD'); assert.equal(put.headers['content-length'], String(768 << 20))
    assert.deepEqual([s.objects.get(`renders/${digest}.mp4`)!.size, s.objects.get(`renders/${digest}.mp4`)!.sha256], [768 << 20, digest])
    assert.ok(s.maxChunk() <= 1 << 20, `streamed in small chunks (max ${s.maxChunk()} bytes)`)
    assert.ok(peak < 256 << 20, `memory stays bounded while a 768 MB file is hashed + uploaded (peak +${Math.round(peak / (1 << 20))} MB)`)
    // retry: the content-addressed render already exists -> HEAD only, no second upload
    const before = s.r2.filter((r) => r.method === 'PUT').length
    assert.deepEqual(await blobs.putFile(`renders/${digest}.mp4`, big, 'video/mp4'), { path: `renders/${digest}.mp4`, bytes: 768 << 20, uploaded: false })
    assert.equal(s.r2.filter((r) => r.method === 'PUT').length, before)
    const signed = await blobs.presign!(`renders/${digest}.mp4`)
    assert.ok(signed!.url.startsWith(`${R2}/${BUCKET}/renders/`))
    assert.deepEqual(s.vercelWrites(), [])
  } finally { s.restore() }
})

test('Longform RENDER/ASSET upload path: no whole-file read of the final MP4 or narration (one path for 25, 60 or 120+ minutes)', async () => {
  const src = await readFile(new URL('../worker/stages/longform.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /readFile\(out\)/); assert.doesNotMatch(src, /readFile\(narration\)/)
  assert.match(src, /const renderHash = await sha256File\(out\)\n\s+const stored = await blobs\.putFile\(`renders\/\$\{renderHash\}\.mp4`, out, 'video\/mp4'\)/)
  assert.match(src, /const nsha = await sha256File\(narration\)[^\n]*\n\s+await blobs\.putFile\(narrationRef, narration, 'audio\/mp4'\)/)
  // the upload does not depend on the running time (no duration branch around it)
  const at = src.indexOf('const renderHash = await sha256File(out)')
  assert.doesNotMatch(src.slice(at - 600, at), /targetSeconds|seconds\s*[<>]/)
})

test('without R2 configured (e.g. the Vercel backend) the store falls back to Vercel Blob; with R2 every new job write is R2', () => {
  const saved = { ...process.env }
  try {
    for (const k of Object.keys(ENV)) delete process.env[k]
    assert.equal(storageBackend(), 'vercel-blob')
    Object.assign(process.env, ENV)
    assert.equal(storageBackend(), 'r2')
  } finally { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
})

test('voice preview on R2: MISS stores voice-preview/<sha>.mp3 privately on R2 and returns an R2 presigned URL; HIT makes 0 TTS calls', async () => {
  const s = installStorage()
  try {
    const { createVoicePreview } = await import('../lib/generative/voicePreview.js')
    const blobs = createVercelJobBlobStore(); let tts = 0
    const handler = createJobsHttp({ getStore: async () => { throw new Error('no database for a preview') }, blobs, voicePreview: createVoicePreview({ blobs, tts: async () => { tts++; return { bytes: Buffer.from('ID3fake-mp3'), contentType: 'audio/mpeg' } }, apiKey: () => 'k', log: () => {} }) })
    const call = () => new Promise<any>((resolve) => { let status = 0; handler({ method: 'POST', headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': 'k'.repeat(32) }, query: {}, body: { taskType: 'longform_voice_preview', voiceProfile: 'female-middle', voiceTone: 'neutral', voiceSpeed: 1 } } as any, { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { resolve({ status, ...b }); return this }, end() { return this } } as any) })
    const a = await call()
    assert.equal(a.status, 200); assert.equal(a.cache, 'MISS'); assert.equal(tts, 1)
    const put = s.r2.find((r) => r.method === 'PUT' && /^voice-preview\/[0-9a-f]{64}\.mp3$/.test(r.key))
    assert.ok(put, 'preview audio PUT to R2')
    assert.ok(a.playbackUrl.startsWith(`${R2}/${BUCKET}/voice-preview/`) && /X-Amz-Signature=/.test(a.playbackUrl), a.playbackUrl)
    const b = await call()
    assert.equal(b.cache, 'HIT'); assert.equal(tts, 1)
    assert.deepEqual(s.vercelWrites(), [])
  } finally { s.restore() }
})
