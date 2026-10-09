// Every Tracker picture is drawn here: Google Gemini "Nano Banana 2" (gemini-3.1-flash-image) through the Interactions
// API — the same request /api/image has used for Story Writer CUT images. No other image model is called anywhere: the
// OpenAI image endpoints are gone from every execution path (tools/gemini-image.test.ts checks the source tree).
// Reference images go in as image blocks after the text; the aspect ratio is native (16:9, 2:3, 9:16 ...), no cropping.
import type { GeneratedBinary } from './providers.js'

export const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image'
export const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions'
export const GEMINI_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const
export const GEMINI_IMAGE_SIZES = ['0.5K', '1K', '2K', '4K'] as const
export type GeminiAspect = (typeof GEMINI_ASPECT_RATIOS)[number]
export type GeminiSize = (typeof GEMINI_IMAGE_SIZES)[number]
export type GeminiReference = { bytes: Buffer; mime: string }
export type GeminiImageRequest = { prompt: string; aspectRatio: GeminiAspect; imageSize?: GeminiSize; references?: GeminiReference[] }
const ONE_IMAGE = 'Generate exactly ONE final image. Do not return a candidate sheet, variations, collage, triptych, or contact sheet.'

// the request body (no key in it): the text first, then the reference images in the given order
export function geminiImagePayload(r: GeminiImageRequest, o: { oneImageLine?: boolean } = {}) {
  if (!GEMINI_ASPECT_RATIOS.includes(r.aspectRatio)) throw new Error(`unsupported aspect ratio ${r.aspectRatio}`)
  const size = r.imageSize ?? '1K'
  if (!GEMINI_IMAGE_SIZES.includes(size)) throw new Error(`unsupported image size ${size}`)
  const text = o.oneImageLine === false ? r.prompt : `${ONE_IMAGE}\n\n${r.prompt}`
  return {
    model: GEMINI_IMAGE_MODEL,
    input: [{ type: 'text', text }, ...(r.references ?? []).map((x) => ({ type: 'image', data: x.bytes.toString('base64'), mime_type: x.mime }))],
    response_format: [{ type: 'image', aspect_ratio: r.aspectRatio, image_size: size }]
  }
}

export function geminiOutputImage(data: any): { base64: string; mimeType: string } | null {
  if (data?.output_image?.data) return { base64: data.output_image.data, mimeType: data.output_image.mime_type || data.output_image.mimeType || 'image/png' }
  for (const step of data?.steps || []) {
    if (step?.type !== 'model_output') continue
    for (const block of step?.content || []) if (block?.type === 'image' && block?.data) return { base64: block.data, mimeType: block.mime_type || block.mimeType || 'image/png' }
  }
  return null
}

// One request, never retried here. A billing / quota / key problem is marked `stop` so a stage never pays again for it.
export async function geminiImage(r: GeminiImageRequest, apiKey: string, f: typeof fetch = fetch, o: { oneImageLine?: boolean } = {}): Promise<GeneratedBinary> {
  if (!apiKey) throw Object.assign(new Error('GEMINI_API_KEY is not configured'), { code: 'no_api_key' })
  const res = await f(GEMINI_INTERACTIONS_URL, { method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(geminiImagePayload(r, o)) })
  const raw = await res.text()
  let data: any = {}
  try { data = raw ? JSON.parse(raw) : {} } catch {}
  if (!res.ok) {
    const msg = String(data?.error?.message || raw || 'Gemini image request failed').slice(0, 500)
    const status = String(data?.error?.status || '')
    const stop = res.status === 401 || res.status === 403 || (res.status === 429 && /quota|billing|RESOURCE_EXHAUSTED/i.test(`${status} ${msg}`))
    throw Object.assign(new Error(`gemini image failed ${res.status}: ${msg}`), { status: res.status, code: status || `http_${res.status}`, stop })
  }
  const img = geminiOutputImage(data)
  if (!img) throw Object.assign(new Error('Gemini response had no image output'), { code: 'no_image' })
  return { bytes: Buffer.from(img.base64, 'base64'), contentType: img.mimeType, provider: 'gemini', model: GEMINI_IMAGE_MODEL }
}
