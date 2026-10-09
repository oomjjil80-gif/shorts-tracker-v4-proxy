// 야담 그림체 — THE ONE style contract for every 야담 picture (롱폼 scenes, thumbnail background, representative check,
// 야담 쇼츠 CUT images). Its only source is the 3 reference frames the user chose (assets/style-reference/yadam: one
// YADAM video, consecutive scenes). There is no other 야담 style, preset, example picture or AUTO choice: every 야담
// image request is built here, sends those frames as real reference images and the contract text below. The scene
// (what the picture shows: people, place, action, Joseon content) comes from the caller; the drawing comes from here.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GeneratedBinary } from './providers.js'

export const YADAM_STYLE_ID = 'yadam_reference' as const
export const YADAM_STYLE_LABEL = '야담 기준 그림체'
export const YADAM_STYLE_VERSION = 'yadam-style/1' // part of every 야담 image cache key
export const YADAM_REFERENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'style-reference', 'yadam')
// face close-up first (with high input fidelity the first image keeps the richest detail), then full figures, then background
export const YADAM_REFERENCES = [
  { file: 'capture-2.jpg', role: 'face close-up: eyes, brows, skin shading, line weight' },
  { file: 'capture-1.jpg', role: 'two people, full figures, low angle' },
  { file: 'capture-3.jpg', role: 'medium shot with hanok roofs and stone wall: background detail' }
] as const
// phone captures 2340x1080 of a 1920x1080 video: the frame without the side bars, the burned subtitles (from y 800) and
// the top-left "AI" label (blurred); no stretching
export const YADAM_REFERENCE_CROP = 'crop=1920:800:210:0,delogo=x=8:y=18:w=650:h=70'

export const YADAM_STYLE_CONTRACT = 'Use the supplied reference image as the primary visual style reference. Preserve its illustration craftsmanship, facial rendering approach, line quality, skin shading, hair detail, lighting sophistication, color harmony, and overall visual polish. Change the characters, costumes, environment, and narrative action according to the new scene description. Do not copy the identities or exact composition of the reference image.'
export const YADAM_STYLE_TRAITS = 'Match these traits of the reference frames exactly: Korean historical webtoon (manhwa) art; bold black ink contour lines with strong line-weight variation (thick outer contours, fine inner lines); hard-edged two-tone cel shadows with crisp shapes on faces, necks and clothing; deep value contrast; detailed eyes with dark lash lines, defined irises and catchlights; sharp defined brows, nose shadow and lips; solid glossy black hair masses with sharp strand lines and highlights; saturated deep indigo and slate-blue fabrics with ink-drawn folds; crisp, highly detailed backgrounds (stone walls, wood grain, roof tiles) at the same finish as the people; neutral, clean colour (no yellow or beige cast).'
export const YADAM_STYLE_RULES = 'New people only, never the reference characters. One single illustration: no photograph or photorealism; no text, letters, subtitles, captions, borders, frames, panels, speech bubbles, logos or watermark.'
// the whole 야담 image prompt: contract -> traits -> the scene (content) -> rules
export const yadamImagePrompt = (scene: string) => [YADAM_STYLE_CONTRACT, YADAM_STYLE_TRAITS, `Scene: ${scene}`, YADAM_STYLE_RULES].join('\n\n')

export type YadamReference = { file: string; name: string; bytes: Buffer; mime: 'image/png'; width: number; height: number; sha256: string }
// the 3 frames exactly as sent: assets/style-reference/yadam/sent/*.png (made once from the captures with
// YADAM_REFERENCE_CROP, checked by tools/yadam-style.test.ts) — read as they are, no processing at request time
const pngSize = (b: Buffer) => (b.length > 24 && b.readUInt32BE(12) === 0x49484452 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null)
let cached: Promise<YadamReference[]> | null = null
export function yadamReferences(dir = YADAM_REFERENCE_DIR): Promise<YadamReference[]> {
  if (dir === YADAM_REFERENCE_DIR && cached) return cached
  const p = (async () => {
    const out: YadamReference[] = []
    for (const r of YADAM_REFERENCES) {
      const name = r.file.replace(/\.jpg$/, '.png'), bytes = await readFile(join(dir, 'sent', name)).catch(() => null)
      const size = bytes ? pngSize(bytes) : null
      if (!bytes || !size || size.width !== 1920 || size.height !== 800) throw Object.assign(new Error(`야담 style reference ${name} is missing or not the 1920x800 frame`), { code: 'YADAM_REFERENCE_MISSING' })
      out.push({ file: r.file, name, bytes, mime: 'image/png', ...size, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    return out
  })()
  if (dir === YADAM_REFERENCE_DIR) { cached = p; p.catch(() => { cached = null }) }
  return p
}

// gpt-image-1 image edit: the 3 frames (+ the approved thumbnail picture after approval, as the last image: the same
// people and place across the video), high input fidelity. quality: high for the thumbnail / representative, medium
// for the many scene pictures.
export const YADAM_IMAGE_MODEL = 'gpt-image-1'
export const YADAM_IMAGE_SIZE = '1536x1024'
export async function yadamImageForm(o: { scene: string; quality: 'high' | 'medium'; approved?: Buffer | null; dir?: string }): Promise<FormData> {
  const form = new FormData()
  form.append('model', YADAM_IMAGE_MODEL); form.append('prompt', yadamImagePrompt(o.scene)); form.append('size', YADAM_IMAGE_SIZE); form.append('quality', o.quality)
  form.append('input_fidelity', 'high'); form.append('output_format', 'jpeg'); form.append('n', '1')
  for (const r of await yadamReferences(o.dir)) form.append('image[]', new Blob([new Uint8Array(r.bytes)], { type: r.mime }), r.name)
  if (o.approved) form.append('image[]', new Blob([new Uint8Array(o.approved)], { type: 'image/jpeg' }), 'approved-thumbnail.jpg')
  return form
}
export type YadamDraw = (scene: string, apiKey: string, o?: { quality?: 'high' | 'medium'; approved?: Buffer | null }) => Promise<GeneratedBinary>
export const openAiYadamImage = (f: typeof fetch = fetch): YadamDraw => async (scene, apiKey, o = {}) => {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')
  const r = await f('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: await yadamImageForm({ scene, quality: o.quality ?? 'medium', approved: o.approved }) })
  if (!r.ok) throw new Error(`야담 image failed ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const b64 = ((await r.json()) as any)?.data?.[0]?.b64_json
  if (!b64) throw new Error('야담 image returned no b64_json')
  return { bytes: Buffer.from(b64, 'base64'), contentType: 'image/jpeg', provider: 'openai', model: `${YADAM_IMAGE_MODEL}+${YADAM_STYLE_VERSION}` }
}
// 야담 쇼츠 CUT images (/api/image, another image model): the same frames as reference blocks + the same contract text
export async function yadamReferenceBlocks(): Promise<Array<{ type: 'image'; data: string; mime_type: string }>> {
  return (await yadamReferences()).map((r) => ({ type: 'image', data: r.bytes.toString('base64'), mime_type: r.mime }))
}
