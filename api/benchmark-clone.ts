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

VISUAL STYLE:
- clean white round-headed stick-figure character with a simple black outline body and tiny readable facial expression
- flat 2D cartoon character integrated into a semi-realistic cinematic environment
- Korean YouTube economy explainer aesthetic: immediate visual metaphor, strong contrast, simple composition, premium photographic background, not childish
- realistic modern office at night, deep navy and cool gray environment, city lights outside windows
- no photoreal human protagonist, no 3D Pixar mascot, no suit-wearing finance mascot, no toy-like rendering
- no collage and no candidate sheet

SCENE:
A tired office worker is visibly working alone late at night at the LEFT desk. On the RIGHT is an identical empty coworker desk and empty chair reserved for “money”, but nobody is there yet. A small inert stack of money rests motionless near the empty desk. The contrast must be understandable without captions: one worker is active, the second work position is empty.

COMPOSITION:
- medium-wide office view
- worker about 12–15% of frame, left third
- clearly empty second desk/chair in right third
- strong negative space on the right communicates absence
- cinematic but simple, high readability within one second

SOURCE IMAGE RULE:
Do not render any readable Korean, English, digits, percentages, labels, subtitles, logos, watermarks or UI. Tracker will add exact text later.`
  },
  '6': {
    name: 'first-coworker-turning-point',
    meaning: 'The worker and capital now contribute at roughly equal strength; money has become the first coworker.',
    prompt: `Create exactly ONE 16:9 horizontal source image for a Korean finance/economy explainer video.

DIAGNOSTIC GOAL: closely reproduce the visual grammar of a successful Korean economy explainer reference scene called “the birth of the first coworker”. This is a benchmark-clone diagnostic, not the normal Economy Grutugi V7 style.

VISUAL STYLE:
- simple white circular-headed stick-figure worker, thin black line body, small expressive face
- 2D cartoon characters integrated over semi-realistic cinematic office backgrounds
- premium Korean economy explainer / editorial infographic feeling
- direct blue-versus-gold contrast, sophisticated but extremely easy to understand
- no photoreal human, no 3D Pixar mascot, no normal V7 finance mascot

SCENE AND LAYOUT:
A strong LEFT/RIGHT split comparison in the same frame.
LEFT: dark navy office. The human worker is actively working at a desk, slightly tired, representing personal labor and personal contribution.
RIGHT: warm golden office. A second humanoid “money coworker” made from warm gold light / subtle money symbolism is actively working beside financial assets, representing capital return working at the same strength as the human.
The two sides must feel balanced in visual weight: human contribution on the left and capital contribution on the right are now equal partners.
A bright central dividing beam visually marks the turning point.
Leave clean rectangular zones around each side where Tracker can later overlay matching annual contribution numbers.

MEANING TEST:
Without any text, a viewer should understand: “At first only I worked. Now money has become a second coworker doing roughly the same amount of work.”

SOURCE IMAGE RULE:
No readable Korean, English, digits, percentages, labels, chart legends, logos, watermarks or UI. Do not render a poster page or text card.`
  },
  '12': {
    name: 'final-human-and-money-coworker',
    meaning: 'The worker is no longer the only worker for wealth; money now works alongside the person as a partner.',
    prompt: `Create exactly ONE 16:9 horizontal source image for the final payoff of a Korean finance/economy explainer video.

DIAGNOSTIC GOAL: preserve the same benchmark visual grammar as the previous scenes: simple white round-headed stick figure over a semi-realistic cinematic environment, with economic meaning readable visually in one second.

SCENE:
At sunrise after a long night, the ordinary worker and the golden “money coworker” now stand side by side at equal scale in the foreground, both facing a clear upward road/path of future asset growth. The worker is the familiar white round-headed 2D stick figure. The money coworker is a matching humanoid form made of warm gold light / subtle money texture, visually a partner rather than a giant magical being.
Behind them, two separate growth paths merge into one broader rising path. The background transitions from cool early-morning blue on the worker side to warm gold on the money side, then blends toward a bright future horizon.

COMPOSITION:
- two figures side by side in lower center, equal visual importance
- merged upward path leading into the distance
- simple strong silhouette and one dominant visual idea
- sophisticated cinematic Korean finance explainer, not fantasy art
- no 3D mascot, no photoreal human, no clutter, no generic trading screens

MEANING TEST:
Without text the viewer should understand: “I am no longer the only one working for my wealth; my money is now working beside me.”

SOURCE IMAGE RULE:
No readable Korean, English, digits, percentages, labels, subtitles, logos, watermarks or UI. Tracker will add exact wording later.`
  }
}

function setCors(res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
}

function assetPath(panel: string) { return `${BASE}/panel-${panel}.bin` }
function metaPath(panel: string) { return `${BASE}/panel-${panel}.json` }

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

export default async function handler(req: Request, res: Response) {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: { message: 'GET only' } })

  const panel = String((req.query as any)?.panel || '')
  const spec = PANELS[panel]
  if (!spec) return res.status(400).json({ error: { message: 'panel must be 1, 6, or 12' } })

  const action = String((req.query as any)?.action || 'meta')

  try {
    if (action === 'asset') {
      const meta = await readJson(metaPath(panel))
      const asset = await readPrivate(assetPath(panel))
      if (!asset || !meta) return res.status(404).json({ error: { message: 'stored asset not found' } })
      const buffer = Buffer.from(await new Response(asset.stream).arrayBuffer())
      res.setHeader('Content-Type', meta.mimeType || 'image/png')
      res.setHeader('Content-Length', String(buffer.length))
      res.setHeader('Cache-Control', 'public, max-age=3600')
      return res.status(200).send(buffer)
    }

    const existing = await readJson(metaPath(panel))
    if (action !== 'generate') {
      return res.status(200).json({ ok: true, panel, stored: Boolean(existing), meta: existing || null })
    }

    // Cost guard: once a panel is stored, repeated generate calls NEVER regenerate it.
    if (existing) {
      return res.status(200).json({ ok: true, panel, stored: true, reused: true, meta: existing })
    }

    const host = String(req.headers.host || 'shorts-tracker-v4-proxy.vercel.app')
    const origin = `https://${host}`
    const imageData = await fetchJson(`${origin}/api/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        contractVersion: '1.5',
        taskType: 'cut_image',
        providerId: 'gemini',
        modelId: 'gemini-3.1-flash-image',
        input: {
          prompt: spec.prompt,
          aspectRatio: '16:9',
          imageSize: '1K',
          cutIndex: Number(panel) - 1,
          references: [],
          profile: PROFILE
        }
      })
    })

    const base64 = String(imageData?.image?.base64 || imageData?.imageBase64 || imageData?.base64 || '').replace(/^data:[^;]+;base64,/, '')
    const mimeType = String(imageData?.image?.mimeType || imageData?.mimeType || 'image/png')
    if (!base64) throw new Error('Gemini image payload missing')
    const buffer = Buffer.from(base64, 'base64')

    await put(assetPath(panel), buffer, {
      access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: mimeType
    })

    let qc: any = null
    let qcError: string | null = null
    try {
      qc = await fetchJson(`${origin}/api/gpt-image-qc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          input: {
            prompt: spec.prompt,
            imageBase64: base64,
            mimeType,
            context: {
              profile: PROFILE,
              panel,
              panelName: spec.name,
              viewerMustUnderstand: spec.meaning,
              economyLongformV01: false,
              benchmarkCloneDiagnostic: true,
              zeroTextBaseImage: true
            }
          }
        })
      })
    } catch (err: any) {
      qcError = err?.message || String(err)
    }

    const meta = {
      schemaVersion: 'BENCHMARK-CLONE-ASSET-1',
      profile: PROFILE,
      panel,
      panelName: spec.name,
      viewerMustUnderstand: spec.meaning,
      generatedAt: new Date().toISOString(),
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
      mimeType,
      byteLength: buffer.length,
      requestId: imageData?.meta?.requestId || null,
      qc,
      qcError,
      retryCount: 0,
      autoRetry: false,
      assetEndpoint: `/api/benchmark-clone?panel=${panel}&action=asset`
    }

    await put(metaPath(panel), JSON.stringify(meta), {
      access: 'private', allowOverwrite: false, addRandomSuffix: false,
      contentType: 'application/json', cacheControlMaxAge: 60
    })

    return res.status(200).json({ ok: true, panel, stored: true, reused: false, meta })
  } catch (err: any) {
    console.error('[BENCHMARK_CLONE_DIAGNOSTIC]', JSON.stringify({ panel, action, error: err?.message || String(err) }))
    return res.status(500).json({ error: { message: err?.message || String(err) } })
  }
}
