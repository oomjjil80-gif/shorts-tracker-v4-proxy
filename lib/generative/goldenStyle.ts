// Golden Style 1~5 (issue #179): the five Gemini picture styles the user approved on 2026-10-09 (round 2 samples,
// style-examples/publish-gemini-ref-test-2). LOCKED: each style = ONE reference picture (assets/style-reference/golden,
// the user's original file, byte for byte, sha256 below) + the exact round-2 text with the content's own scene in the
// "장면:" line. Request = gemini-3.1-flash-image, the text first, then that one picture, no preprocessing. Nothing here
// may change without a new GOLDEN_PROMPT_VERSION (and a new user approval): every Golden picture's cache key carries
// the version and the reference hash, and a job keeps the hash it was created with (a different file stops the job).
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { geminiImage, type GeminiAspect } from './geminiImage.js'
import type { GeneratedBinary } from './providers.js'

export const GOLDEN_PROMPT_VERSION = 'golden-style/1'
export const GOLDEN_STYLE_IDS = ['golden-1', 'golden-2', 'golden-3', 'golden-4', 'golden-5'] as const
export type GoldenStyleId = (typeof GOLDEN_STYLE_IDS)[number]
export const GOLDEN_REFERENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'style-reference', 'golden')
export const GOLDEN_STYLES: Readonly<Record<GoldenStyleId, { n: number; label: string; file: string; sha256: string }>> = {
  'golden-1': { n: 1, label: 'Golden Style 1 · 로맨스 웹툰', file: 'ref-1.jpg', sha256: 'e9558a934c3eeaeae947e8c01a65f43a6c03a128554d9c84222982e80eb71b58' },
  'golden-2': { n: 2, label: 'Golden Style 2 · 수묵 홍매', file: 'ref-2.jpg', sha256: '98fbd2f54c8af85c90bb42988406080b4e58264e62427b8daa70a196e268bc61' },
  'golden-3': { n: 3, label: 'Golden Style 3 · 사극 웹툰', file: 'ref-3.jpg', sha256: 'f4e57910191dd2a6e7d9159ab7304cec56311f571b30cfba8cb5e612ae7d2367' },
  'golden-4': { n: 4, label: 'Golden Style 4 · 파스텔 동화', file: 'ref-4.jpg', sha256: '59803aa8fee27af272f95da9f89e7d5b2198658c5b49c24198fa59017717588d' },
  'golden-5': { n: 5, label: 'Golden Style 5 · 별밤 동화', file: 'ref-5.jpg', sha256: '7274ea66bf5f9e5b7bf3f3104f4db4e168e46ffc7bfb609fa5fd3373cb9392b0' }
}
export const isGoldenStyle = (k: unknown): k is GoldenStyleId => typeof k === 'string' && (GOLDEN_STYLE_IDS as readonly string[]).includes(k)

// the round-2 text, exactly; only the scene and (for a non-16:9 content) the frame line are the content's own
export const GOLDEN_STYLE_INSTRUCTION = '첨부 이미지는 그림체 참고용입니다. 첨부 이미지의 선화, 채색, 명암, 질감 등 시각적 표현 방식을 최대한 동일하게 재현하세요. 인물과 구도는 복사하지 말고 새로운 장면을 그리세요. 실사 사진으로 만들지 마세요.'
export const goldenFrameLine = (aspect: GeminiAspect) => (aspect === '16:9' ? '16:9 가로 화면, 글자 없음.' : `${aspect} ${aspectIsPortrait(aspect) ? '세로' : '가로'} 화면, 글자 없음.`)
const aspectIsPortrait = (a: GeminiAspect) => { const [w, h] = a.split(':').map(Number); return h > w }
export const goldenPrompt = (scene: string, aspect: GeminiAspect) => `${GOLDEN_STYLE_INSTRUCTION}\n\n장면: ${String(scene).trim()}\n\n${goldenFrameLine(aspect)}`

// what a job stores at job_create (resolved creative profile) and keeps for its whole life
export type GoldenSpec = { id: GoldenStyleId; refSha256: string; promptVersion: string }
export const goldenSpec = (id: GoldenStyleId): GoldenSpec => ({ id, refSha256: GOLDEN_STYLES[id].sha256, promptVersion: GOLDEN_PROMPT_VERSION })
export const goldenCacheTag = (g: GoldenSpec) => `|golden:${g.id}:${g.refSha256}:${g.promptVersion}`

// the reference picture as committed; a missing or changed file stops (never another picture, never a fallback)
const cache = new Map<string, Promise<Buffer>>()
export function goldenReference(g: GoldenSpec | GoldenStyleId, dir = GOLDEN_REFERENCE_DIR): Promise<Buffer> {
  const spec = typeof g === 'string' ? goldenSpec(g) : g
  const meta = GOLDEN_STYLES[spec.id]
  if (!meta) return Promise.reject(Object.assign(new Error(`unknown Golden Style ${spec.id}`), { code: 'GOLDEN_STYLE_UNKNOWN' }))
  if (spec.promptVersion !== GOLDEN_PROMPT_VERSION || spec.refSha256 !== meta.sha256) return Promise.reject(Object.assign(new Error(`${spec.id}: this job was created with another Golden Style version (${spec.promptVersion}, ${spec.refSha256.slice(0, 12)})`), { code: 'GOLDEN_STYLE_CHANGED' }))
  const key = `${dir}|${spec.id}`
  if (!cache.has(key)) {
    const p = readFile(join(dir, meta.file)).then((b) => {
      if (createHash('sha256').update(b).digest('hex') !== meta.sha256) throw Object.assign(new Error(`${spec.id}: reference ${meta.file} is not the locked original`), { code: 'GOLDEN_REFERENCE_CHANGED' })
      return b
    }, () => { throw Object.assign(new Error(`${spec.id}: reference ${meta.file} is missing`), { code: 'GOLDEN_REFERENCE_MISSING' }) })
    cache.set(key, p); p.catch(() => cache.delete(key))
  }
  return cache.get(key)!
}

// FIRST-IMAGE CHARACTER LOCK (PR #180 blocker): the first picture of a job / episode is drawn with the Golden reference
// alone (exactly the approved 1-image request); every later picture gets TWO images with separate roles — the Golden
// reference (drawing style) first, the first picture (who the people are) second — and a text that says which is which.
// Whether this 2-image request keeps the approved 1-image style quality is NOT verified yet (needs a paid check).
export const GOLDEN_IDENTITY_VERSION = 'golden-identity/1'
export const GOLDEN_IDENTITY_INSTRUCTION = '첫 번째 첨부 이미지는 그림체 참고용입니다. 첫 번째 첨부 이미지의 선화, 채색, 명암, 질감 등 시각적 표현 방식을 최대한 동일하게 재현하세요. 첫 번째 첨부 이미지의 인물과 구도는 복사하지 말고 새로운 장면을 그리세요. 실사 사진으로 만들지 마세요.\n\n두 번째 첨부 이미지는 인물 참고용입니다. 두 번째 첨부 이미지에 나온 인물의 얼굴, 나이, 머리 모양, 옷차림을 그대로 유지해 같은 사람으로 그리세요. 그림체는 두 번째 이미지가 아니라 첫 번째 이미지를 따르세요.'
export const goldenIdentityPrompt = (scene: string, aspect: GeminiAspect) => `${GOLDEN_IDENTITY_INSTRUCTION}\n\n장면: ${String(scene).trim()}\n\n${goldenFrameLine(aspect)}`
export type GoldenIdentity = { bytes: Buffer; mime: string; sha256: string }
export const identityOf = (bytes: Buffer, mime = sniff(bytes)): GoldenIdentity => ({ bytes, mime, sha256: createHash('sha256').update(bytes).digest('hex') })
const sniff = (b: Buffer) => (b.length >= 2 && b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b.length >= 2 && b[0] === 0x52 && b[1] === 0x49 ? 'image/webp' : 'image/jpeg')
export const goldenLockTag = (lock: { sha256: string } | null | undefined) => (lock ? `|identity:${GOLDEN_IDENTITY_VERSION}:${lock.sha256}` : '')

// the Gemini request of one Golden picture: the text, then the ONE reference picture (as the round-2 samples)
// identity null = the FIRST picture (the approved 1-image request); identity = every later picture (style + character)
export async function goldenImageRequest(g: GoldenSpec, scene: string, aspect: GeminiAspect, identity: GoldenIdentity | null = null) {
  const style = { bytes: await goldenReference(g), mime: 'image/jpeg' }
  if (!identity) return { prompt: goldenPrompt(scene, aspect), aspectRatio: aspect, imageSize: '1K' as const, references: [style] }
  return { prompt: goldenIdentityPrompt(scene, aspect), aspectRatio: aspect, imageSize: '1K' as const, references: [style, { bytes: identity.bytes, mime: identity.mime }] }
}
export async function goldenImage(g: GoldenSpec, scene: string, aspect: GeminiAspect, apiKey: string, f: typeof fetch = fetch, identity: GoldenIdentity | null = null): Promise<GeneratedBinary> {
  const made = await geminiImage(await goldenImageRequest(g, scene, aspect, identity), apiKey, f, { oneImageLine: false })
  return { ...made, model: `${made.model}+${g.id}+${g.promptVersion}${identity ? `+${GOLDEN_IDENTITY_VERSION}` : ''}` }
}

// The job's character lock: which picture is the first one (its bytes in the blob store, its sha256), written once
// before any later picture is drawn and read back on every resume / retry (the same bytes, or the job stops).
export type GoldenLockRecord = { schema: 'golden-lock/1'; jobId: string; style: GoldenSpec; identityVersion: string; ref: string; sha256: string; source: string; createdAt: string }
export const goldenLockPath = (jobId: string) => `golden-locks/${jobId}.json`
type LockBlobs = { getJson(p: string): Promise<any>; putJson(p: string, v: any, o?: { overwrite?: boolean }): Promise<any>; getBytes(p: string): Promise<Buffer | null>; putBytes(p: string, b: Buffer, ct: string): Promise<any> }
export async function readGoldenLock(blobs: LockBlobs, jobId: string, g: GoldenSpec): Promise<GoldenIdentity | null> {
  const rec: GoldenLockRecord | null = await blobs.getJson(goldenLockPath(jobId)).catch(() => null)
  if (!rec) return null
  if (rec.style?.id !== g.id || rec.style?.refSha256 !== g.refSha256 || rec.style?.promptVersion !== g.promptVersion || rec.identityVersion !== GOLDEN_IDENTITY_VERSION) throw Object.assign(new Error(`job ${jobId}: its character lock was made with another Golden Style version`), { code: 'GOLDEN_LOCK_MISMATCH' })
  const bytes = await blobs.getBytes(rec.ref).catch(() => null)
  if (!bytes) throw Object.assign(new Error(`job ${jobId}: the first picture (character lock ${rec.ref}) is missing`), { code: 'GOLDEN_LOCK_MISSING' })
  const id = identityOf(bytes)
  if (id.sha256 !== rec.sha256) throw Object.assign(new Error(`job ${jobId}: the first picture changed (character lock ${rec.sha256.slice(0, 12)})`), { code: 'GOLDEN_LOCK_CHANGED' })
  return id
}
// the lock for a job: the stored one, or `first()` draws / gives the first picture now and it is stored before anything
// else is drawn (create-once: a concurrent writer never replaces it)
export async function goldenLockFor(blobs: LockBlobs, jobId: string, g: GoldenSpec, first: () => Promise<{ bytes: Buffer; contentType?: string }>, source: string): Promise<{ identity: GoldenIdentity; created: boolean }> {
  const have = await readGoldenLock(blobs, jobId, g)
  if (have) return { identity: have, created: false }
  const made = await first(), id = identityOf(made.bytes), ref = `generative-assets/images/${id.sha256}.jpg`
  if (!(await blobs.getBytes(ref).catch(() => null))) await blobs.putBytes(ref, made.bytes, made.contentType ?? id.mime)
  await blobs.putJson(goldenLockPath(jobId), { schema: 'golden-lock/1', jobId, style: g, identityVersion: GOLDEN_IDENTITY_VERSION, ref, sha256: id.sha256, source, createdAt: new Date().toISOString() } satisfies GoldenLockRecord, { overwrite: false }).catch(() => {})
  const stored = await readGoldenLock(blobs, jobId, g)
  return { identity: stored ?? id, created: true }
}
