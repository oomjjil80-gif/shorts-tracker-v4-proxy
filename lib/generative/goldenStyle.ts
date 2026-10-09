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

// the Gemini request of one Golden picture: the text, then the ONE reference picture (as the round-2 samples)
export async function goldenImageRequest(g: GoldenSpec, scene: string, aspect: GeminiAspect) {
  return { prompt: goldenPrompt(scene, aspect), aspectRatio: aspect, imageSize: '1K' as const, references: [{ bytes: await goldenReference(g), mime: 'image/jpeg' }] }
}
export async function goldenImage(g: GoldenSpec, scene: string, aspect: GeminiAspect, apiKey: string, f: typeof fetch = fetch): Promise<GeneratedBinary> {
  const made = await geminiImage(await goldenImageRequest(g, scene, aspect), apiKey, f, { oneImageLine: false })
  return { ...made, model: `${made.model}+${g.id}+${g.promptVersion}` }
}
