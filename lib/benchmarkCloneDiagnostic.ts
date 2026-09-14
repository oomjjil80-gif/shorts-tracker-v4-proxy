import type { Request, Response } from 'express'
import { put, get } from '@vercel/blob'

const PROFILE = 'benchmark-clone-diagnostic-v1'
const BASE = 'benchmark-clone/money-works-v1'

const PANELS: Record<string, { name: string; prompt: string; meaning: string }> = {
  '1': {
    name: 'hook-alone-worker',
    meaning: 'At first only the ordinary worker is working; money has not become a second worker yet.',
    prompt: `Create exactly ONE 16:9 horizontal source image for a Korean finance/economy explainer video.
DIAGNOSTIC GOAL: closely reproduce the visual grammar of a successful Korean economy explainer reference, not the normal Economy Grutugi V7 style.
VISUAL STYLE: clean white round-headed stick-figure character with simple black outline body and small readable facial expression; flat 2D cartoon integrated into a semi-realistic cinematic office; premium Korean YouTube economy explainer aesthetic; deep navy/cool gray night office with city lights. No photoreal human protagonist, no 3D Pixar mascot, no suit-wearing finance mascot, no toy-like rendering, no collage.
SCENE: a tired office worker visibly works alone late at night at the LEFT desk. On the RIGHT is an identical empty coworker desk and empty chair reserved for money; a small inert stack of money rests motionless nearby. The second work position is clearly empty.
COMPOSITION: medium-wide office; worker 12–15% of frame in left third; clearly empty second desk/chair in right third; strong negative space on right; one-second readability.
SOURCE IMAGE RULE: no readable Korean, English, digits, percentages, labels, subtitles, logos, watermarks or UI.`
  },
  '6': {
    name: 'first-coworker-turning-point',
    meaning: 'The worker and capital now contribute at roughly equal strength; money has become the first coworker.',
    prompt: `Create exactly ONE 16:9 horizontal source image for a Korean finance/economy explainer video.
DIAGNOSTIC GOAL: closely reproduce the visual grammar of a successful Korean economy explainer reference scene called the birth of the first coworker. This is a benchmark-clone diagnostic, not the normal Economy Grutugi V7 style.
VISUAL STYLE: simple white circular-headed stick-figure worker with thin black line body and small expressive face; 2D cartoon characters integrated over semi-realistic cinematic office backgrounds; premium Korean economy explainer/editorial infographic feeling; direct blue-versus-gold contrast. No photoreal human, no 3D Pixar mascot, no normal V7 finance mascot.
SCENE AND LAYOUT: strong LEFT/RIGHT split. LEFT: dark navy office, human worker actively working at a desk, slightly tired, representing personal labor. RIGHT: warm golden office, a second humanoid money coworker made from warm gold light/subtle money symbolism actively working beside financial assets, representing capital return. The two sides have equal visual weight. A bright central dividing beam marks the turning point. Leave clean zones for later numeric overlays.
MEANING TEST: without text, viewer understands: at first only I worked; now money has become a second coworker doing roughly the same amount of work.
SOURCE IMAGE RULE: no readable Korean, English, digits, percentages, labels, chart legends, logos, watermarks or UI; not a poster or card.`
  },
  '12': {
    name: 'final-human-and-money-coworker',
    meaning: 'The worker is no longer the only worker for wealth; money now works alongside the person as a partner.',
    prompt: `Create exactly ONE 16:9 horizontal source image for the final payoff of a Korean finance/economy explainer video.
DIAGNOSTIC GOAL: preserve the benchmark visual grammar: simple white round-headed stick figure over a semi-realistic cinematic environment, with economic meaning readable visually in one second.
SCENE: at sunrise after a long night, the ordinary worker and the golden money coworker stand side by side at equal scale in the foreground, both facing a clear upward road/path of future asset growth. The worker is a white round-headed 2D stick figure. The money coworker is a matching humanoid made of warm gold light/subtle money texture, a partner rather than a giant magical being. Behind them, two separate growth paths merge into one broader rising path. Cool blue worker side blends with warm gold money side toward a bright horizon.
COMPOSITION: two figures side by side in lower center with equal visual importance; merged upward path into distance; one dominant visual idea; sophisticated cinematic Korean finance explainer, not fantasy art. No 3D mascot, no photoreal human, no clutter, no generic trading screens.
MEANING TEST: without text, viewer understands: I am no longer the only one working for my wealth; my money is now working beside me.
SOURCE IMAGE RULE: no readable Korean, English, digits, percentages, labels, subtitles, logos, watermarks or UI.`
  }
}

function attemptSuffix(attempt: number) { return attempt <= 1 ? '' : `-attempt-${attempt}` }
function assetPath(panel: string, attempt: number) { return `${BASE}/panel-${panel}${attemptSuffix(attempt)}.bin` }
function metaPath(panel: string, attempt: number) { return `${BASE}/panel-${panel}${attemptSuffix(attempt)}.json` }

function correctedPrompt(panel: string, attempt: number, basePrompt: string) {
  if (attempt <= 1) return basePrompt
  if ((panel === '6' || panel === '12') && attempt === 2) {
    return `${basePrompt}\n\n[DIAGNOSTIC RETRY — FIX ONLY THE OBSERVED FAILURE]\nPreserve the successful composition, character placement, blue/gold contrast, cinematic background and exact scene meaning from the first attempt. Fix ONLY this defect: the prior image invented readable currency symbols/labels. ABSOLUTE SYMBOL BAN: do not draw $, ₩, €, ¥, KRW, USD, currency abbreviations, digits, letters, labels, logos, coin engravings, money-bag emblems, monitor text, sign text or text-like glyphs anywhere. Represent wealth only through unlabeled warm gold light, completely blank geometric coins/discs with no marks, abstract gold bars with no engravings, neutral asset blocks, glow and scale. Every money-related object must have a clean unmarked surface. Do not otherwise redesign the scene.`
  }
  return basePrompt
}

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

export async function handleBenchmarkCloneDiagnostic(req: Request, res: Response) {
  const panel = String((req.query as any)?.panel || '')
  const spec = PANELS[panel]
  if (!spec) return res.status(400).json({ error: { message: 'panel must be 1, 6, or 12' } })
  const action = String((req.query as any)?.action || 'meta')
  const rawAttempt = Number((req.query as any)?.attempt || 1)
  const attempt = Number.isInteger(rawAttempt) && rawAttempt >= 1 && rawAttempt <= 3 ? rawAttempt : 1
  const generationPrompt = correctedPrompt(panel, attempt, spec.prompt)

  try {
    if (action === 'asset') {
      const meta = await readJson(metaPath(panel, attempt))
      const asset = await readPrivate(assetPath(panel, attempt))
      if (!asset || !meta) return res.status(404).json({ error: { message: 'stored asset not found' } })
      const buffer = Buffer.from(await new Response(asset.stream).arrayBuffer())
      res.setHeader('Content-Type', meta.mimeType || 'image/png')
      res.setHeader('Content-Length', String(buffer.length))
      res.setHeader('Cache-Control', 'public, max-age=3600')
      return res.status(200).send(buffer)
    }

    const existing = await readJson(metaPath(panel, attempt))
    if (action !== 'generate') {
      return res.status(200).json({ ok: true, panel, attempt, stored: Boolean(existing), meta: existing || null })
    }

    // Cost guard: each explicit attempt can be generated only once. Repeated calls reuse the exact stored asset.
    if (existing) return res.status(200).json({ ok: true, panel, attempt, stored: true, reused: true, meta: existing })

    const host = String(req.headers.host || 'shorts-tracker-v4-proxy.vercel.app')
    const origin = `https://${host}`
    const imageData = await fetchJson(`${origin}/api/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        contractVersion: '1.5', taskType: 'cut_image', providerId: 'gemini', modelId: 'gemini-3.1-flash-image',
        input: { prompt: generationPrompt, aspectRatio: '16:9', imageSize: '1K', cutIndex: Number(panel) - 1, references: [], profile: PROFILE }
      })
    })

    const base64 = String(imageData?.image?.base64 || imageData?.imageBase64 || imageData?.base64 || '').replace(/^data:[^;]+;base64,/, '')
    const mimeType = String(imageData?.image?.mimeType || imageData?.mimeType || 'image/png')
    if (!base64) throw new Error('Gemini image payload missing')
    const buffer = Buffer.from(base64, 'base64')

    await put(assetPath(panel, attempt), buffer, { access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: mimeType })

    let qc: any = null
    let qcError: string | null = null
    try {
      qc = await fetchJson(`${origin}/api/gpt-image-qc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ input: {
          prompt: generationPrompt, imageBase64: base64, mimeType,
          context: { profile: PROFILE, panel, attempt, panelName: spec.name, viewerMustUnderstand: spec.meaning, economyLongformV01: false, benchmarkCloneDiagnostic: true, zeroTextBaseImage: true }
        } })
      })
    } catch (err: any) { qcError = err?.message || String(err) }

    const meta = {
      schemaVersion: 'BENCHMARK-CLONE-ASSET-1', profile: PROFILE, panel, attempt, panelName: spec.name,
      viewerMustUnderstand: spec.meaning, generatedAt: new Date().toISOString(), provider: 'gemini', model: 'gemini-3.1-flash-image',
      mimeType, byteLength: buffer.length, requestId: imageData?.meta?.requestId || null,
      qc, qcError, retryCount: attempt - 1, autoRetry: false,
      retryReason: attempt === 2 && (panel === '6' || panel === '12') ? 'remove generated currency symbols while preserving successful composition' : null,
      assetEndpoint: `/api/image?diagnostic=benchmark-clone&panel=${panel}&attempt=${attempt}&action=asset`
    }
    await put(metaPath(panel, attempt), JSON.stringify(meta), { access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 })
    return res.status(200).json({ ok: true, panel, attempt, stored: true, reused: false, meta })
  } catch (err: any) {
    console.error('[BENCHMARK_CLONE_DIAGNOSTIC]', JSON.stringify({ panel, attempt, action, error: err?.message || String(err) }))
    return res.status(500).json({ error: { message: err?.message || String(err) } })
  }
}
