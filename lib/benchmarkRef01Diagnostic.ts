import type { Request, Response } from 'express'
import { put, get } from '@vercel/blob'

const PROFILE = 'benchmark-ref01-diagnostic-v1'
const BASE = 'benchmark-clone/money-works-ref01-v1'
const PROMPT = `Create exactly ONE 16:9 horizontal SOURCE ARTWORK for a Korean finance/economy explainer frame. This is a close-recreation diagnostic of a directly observed benchmark composition. Do NOT use the normal Economy Grutugi style.

TARGET FRAME MEANING: "Birth of the First Coworker" — human annual saving/contribution and annual compound return have become roughly equal, so capital can be visualized as a second coworker.

IMPORTANT: this source artwork will receive deterministic text and metric overlays AFTER generation. Therefore DO NOT paint any readable text, letters, digits, currency symbols, logos, subtitles or labels into the image. Instead, deliberately reserve the exact empty zones described below so overlays can be placed without covering faces or important objects.

VISUAL IDENTITY — MATCH THE OBSERVED BENCHMARK CLOSELY:
LEFT HUMAN: premium simple 2D editorial cartoon worker with a round pale face, tired half-lidded expression, dark navy captain-like double-breasted work uniform with subtle gold trim and a dark captain-like hat. He sits at a desk with laptop/papers in a cool dark navy office. He is NOT a white stick figure, NOT photorealistic, NOT a 3D mascot.
RIGHT CAPITAL COWORKER: bright warm-gold glowing line-art humanoid made of fine neon/circuit-like lines, circular coin-like blank head with NO currency mark, powerful luminous silhouette, one hand raised as if continuously working. He is NOT a solid generic gold person and NOT a fantasy superhero.
BACKGROUND: integrated dark financial-office/city environment. LEFT is cool deep navy. RIGHT is black-to-warm-gold with faint abstract chart/candlestick texture that contains no readable marks. A sharp bright diagonal golden light boundary divides the two states near center.
STYLE: polished Korean YouTube economy editorial illustration + infographic-ready composition. Dense and intentional, not sparse. Flat/2D characters with cinematic lighting and sophisticated background depth.

COMPOSITION CONTRACT — NORMALIZED FRAME:
- LEFT_HEADER reserve: x 12–38%, y 5–18% — keep mostly dark clean background.
- RIGHT_HEADER reserve: x 68–94%, y 5–18% — keep mostly dark clean background.
- MAIN_TITLE reserve: x 29–70%, y 18–34% — keep central upper area clean and high contrast.
- PROGRESS reserve: x 47–55%, y 33–42%.
- LEFT_SUBJECT: x 8–47%, y 34–94% — captain-like tired worker at desk.
- CENTER_METRIC_CLUSTER reserve: x 44–70%, y 45–84% — preserve three stacked clean dark/gold-edged card zones with NO text inside.
- RIGHT_SUBJECT: x 68–91%, y 39–94% — glowing line-art capital coworker.
- RIGHT_BENEFIT_CLUSTER reserve: x 74–99%, y 20–48% — leave room for three small icon/label overlays.
- RIGHT_INCOME_TAG reserve: x 84–97%, y 61–79% — empty dark/gold-edged tag zone.
- ANNUAL_TOTAL reserve: x 55–70%, y 84–98% — empty small card zone.
- SUBTITLE_BAND reserve: x 28–73%, y 78–91% — ensure a darker horizontal region can hold one bold subtitle line.

VISUAL HIERARCHY: the human-vs-capital split and the glowing second coworker must still be understandable before overlays. The center/right reserved areas must feel like part of the graphic composition, not accidental empty holes.

ABSOLUTE SOURCE RULE: no readable Korean, English, numbers, percentages, currency marks, logos, watermarks or UI anywhere. Blank cards, blank icons and abstract shapes are allowed. Output one finished 16:9 image only.`

function assetPath() { return `${BASE}/source.bin` }
function metaPath() { return `${BASE}/source.json` }
async function readPrivate(path: string) {
  const result: any = await get(path, { access: 'private', useCache: false })
  if (!result || result.statusCode !== 200 || !result.stream) return null
  return result
}
async function readJson(path: string) {
  const result = await readPrivate(path)
  if (!result) return null
  return JSON.parse(await new Response(result.stream).text())
}
async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  const text = await response.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch {}
  if (!response.ok) throw new Error(data?.error?.message || text || `HTTP ${response.status}`)
  return data
}

export async function handleBenchmarkRef01Diagnostic(req: Request, res: Response) {
  const action = String((req.query as any)?.action || 'meta')
  try {
    if (action === 'asset') {
      const meta = await readJson(metaPath())
      const asset = await readPrivate(assetPath())
      if (!meta || !asset) return res.status(404).json({ error: { message: 'REF-01 asset not found' } })
      const buffer = Buffer.from(await new Response(asset.stream).arrayBuffer())
      res.setHeader('Content-Type', meta.mimeType || 'image/jpeg')
      res.setHeader('Content-Length', String(buffer.length))
      res.setHeader('Cache-Control', 'public, max-age=3600')
      return res.status(200).send(buffer)
    }

    const existing = await readJson(metaPath())
    if (action !== 'generate') return res.status(200).json({ ok: true, stored: Boolean(existing), meta: existing || null })
    if (existing) return res.status(200).json({ ok: true, stored: true, reused: true, meta: existing })

    const host = String(req.headers.host || 'shorts-tracker-v4-proxy.vercel.app')
    const origin = `https://${host}`
    const imageData = await fetchJson(`${origin}/api/image`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        contractVersion: '1.5', taskType: 'cut_image', providerId: 'gemini', modelId: 'gemini-3.1-flash-image',
        input: { prompt: PROMPT, aspectRatio: '16:9', imageSize: '1K', references: [], profile: PROFILE }
      })
    })
    const base64 = String(imageData?.image?.base64 || '').replace(/^data:[^;]+;base64,/, '')
    const mimeType = String(imageData?.image?.mimeType || 'image/jpeg')
    if (!base64) throw new Error('Gemini image payload missing')
    const buffer = Buffer.from(base64, 'base64')
    await put(assetPath(), buffer, { access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: mimeType })

    let qc: any = null
    let qcError: string | null = null
    try {
      qc = await fetchJson(`${origin}/api/gpt-image-qc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ input: {
          prompt: PROMPT, imageBase64: base64, mimeType,
          context: {
            profile: PROFILE,
            benchmarkCloneDiagnostic: true,
            referenceCompositionContract: 'ECONOMY_PIRATE_REF01_COMPOSITION_CONTRACT_V1',
            viewerMustUnderstand: 'human contribution and capital return have become equal-strength coworkers',
            economyLongformV01: false,
            zeroTextBaseImage: true
          }
        } })
      })
    } catch (err: any) { qcError = err?.message || String(err) }

    const meta = {
      schemaVersion: 'BENCHMARK-REF01-ASSET-1', profile: PROFILE,
      generatedAt: new Date().toISOString(), provider: 'gemini', model: 'gemini-3.1-flash-image',
      mimeType, byteLength: buffer.length, requestId: imageData?.meta?.requestId || null,
      qc, qcError, autoRetry: false,
      assetEndpoint: '/api/image?diagnostic=benchmark-ref01&action=asset'
    }
    await put(metaPath(), JSON.stringify(meta), { access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 })
    return res.status(200).json({ ok: true, stored: true, reused: false, meta })
  } catch (err: any) {
    console.error('[BENCHMARK_REF01_DIAGNOSTIC]', JSON.stringify({ action, error: err?.message || String(err) }))
    return res.status(500).json({ error: { message: err?.message || String(err) } })
  }
}
