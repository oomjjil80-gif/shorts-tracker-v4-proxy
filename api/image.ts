import type { Request, Response } from 'express'

function setCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || '')
  const allowed =
    /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker\.vercel\.app$/i.test(origin) ||
    /^https:\/\/(?:www\.)?trackervercel\.app$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker-[a-z0-9-]+\.vercel\.app$/i.test(origin)
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
}

function findGeneratedImage(data: any) {
  if (data?.output_image?.data) {
    return {
      base64: data.output_image.data,
      mimeType: data.output_image.mime_type || data.output_image.mimeType || 'image/png'
    }
  }
  for (const step of data?.steps || []) {
    if (step?.type !== 'model_output') continue
    for (const block of step?.content || []) {
      if (block?.type === 'image' && block?.data) {
        return {
          base64: block.data,
          mimeType: block.mime_type || block.mimeType || 'image/png'
        }
      }
    }
  }
  return null
}

function economyLongformServerGuard() {
  return [
    '[SERVER STYLE LOCK — ECONOMY LONGFORM V0.1 / V7 QUALITY]',
    'This request is stateless. Reconstruct this visual identity on every request and ignore any legacy stick-figure, Gru/SD, zero-text or 9:16 instruction that conflicts with this lock.',
    'OUTPUT: exactly ONE 16:9 horizontal long-form image. No portrait frame, candidate sheet, collage, triptych, contact sheet or poster page.',
    'STYLE: premium Korean finance explainer; high-end editorial illustration + cinematic finance documentary atmosphere + refined semi-realistic 2.5D depth. Use deep navy, warm amber/orange key light and controlled red accents. Rich but organized environmental detail.',
    'MASCOT MANDATORY: exactly ONE clearly visible professional finance mascot in every generated still — round pale face, clean dark outline, simple readable eyes/mouth, navy suit, white shirt. About 8–10% of frame, secondary to the economic relationship. Never omit the mascot.',
    'NO SUBSTITUTE CHARACTER: no stick figure, no Gru/visitor SD character, no Pixar-like child character, no photoreal human protagonist. If population/crowd context is necessary, keep it distant and visually subordinate so the finance mascot remains the only foreground character.',
    'SCENE DESIGN: one dominant economic relationship + one scene-specific visual metaphor. Translate meaning through space, scale, weight, direction, distance or transformation. Do not default to gauges, pipes, scales, machines, arrows or charts unless this CUT specifically needs them.',
    'NEW SCENE RESET: preserve only quality, lighting, palette, mascot design language and premium channel atmosphere. Never reuse previous-scene composition, props, objects, metaphor or background layout.',
    'INTEGRATED DEPTH: the scene must feel like one premium economic environment, not floating icons, a toy diorama, a classroom graphic or a card-news layout.',
    'TEXT: use only exact short wording/numbers explicitly requested by the CUT. Never invent extra labels, numbers, English, Korean, logos, watermarks, subtitles or UI.',
    'QUALITY FLOOR: reject cheap vector, flat infographic, PowerPoint, generic stock illustration, toy-like glossy 3D, children educational graphics and sparse poster composition.',
    'Before rendering, verify: horizontal 16:9; exactly one visible finance mascot; premium V7 editorial depth; economic relation is visually dominant; no previous-scene leakage; no invented text.'
  ].join('\n')
}

export default async function handler(req: Request, res: Response) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } })

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return res.status(503).json({ error: { message: 'GEMINI_API_KEY is not configured' } })

  const input = req.body?.input || {}
  const prompt = String(input.prompt || '').trim()
  if (!prompt) return res.status(400).json({ error: { message: 'prompt is required' } })

  const profile = String(input.profile || '').trim()
  const economyLongform = profile === 'economy-longform-v01'
  const requestedRatio = String(input.aspectRatio || '9:16')
  const ratio = economyLongform ? '16:9' : requestedRatio
  const size = String(input.imageSize || '1K')
  const ratios = new Set(['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9','1:4','4:1','1:8','8:1'])
  const sizes = new Set(['0.5K','1K','2K','4K'])

  const rawReferences = Array.isArray(input.references) ? input.references.slice(0, 4) : []
  const referenceBlocks = rawReferences
    .map((ref: any) => ({
      type: 'image',
      data: String(ref?.data || '').replace(/^data:[^;]+;base64,/, ''),
      mime_type: String(ref?.mimeType || ref?.mime_type || 'image/png')
    }))
    .filter((ref: any) => ref.data.length > 0)

  const guardedPrompt = economyLongform
    ? [economyLongformServerGuard(), '', '[CUT-SPECIFIC BRIEF]', prompt, '', '[FINAL SERVER REMINDER]', 'Do not omit the single finance mascot. Output one premium 16:9 horizontal image only.'].join('\n')
    : prompt

  const referenceInstruction = economyLongform
    ? 'Use provided reference images only as style/identity anchors when they do not conflict with the ECONOMY LONGFORM V0.1 server style lock. The server style lock always wins.'
    : 'Use the provided reference images as identity/style anchors. Preserve face, hair, beard, age, clothing, body proportions, and core character design unless the prompt explicitly requests a scene-type transformation such as the established SD version.'

  const interactionInput = referenceBlocks.length
    ? [
        {
          type: 'text',
          text: [
            referenceInstruction,
            'Generate exactly ONE final image for this CUT. Do not return a candidate sheet, variations, collage, triptych, or contact sheet.',
            guardedPrompt
          ].join('\n\n')
        },
        ...referenceBlocks
      ]
    : [
        {
          type: 'text',
          text: 'Generate exactly ONE final image for this CUT. Do not return a candidate sheet, variations, collage, triptych, or contact sheet.\n\n' + guardedPrompt
        }
      ]

  const effectiveRatio = ratios.has(ratio) ? ratio : (economyLongform ? '16:9' : '9:16')
  const payload = {
    model: 'gemini-3.1-flash-image',
    input: interactionInput,
    response_format: [
      {
        type: 'image',
        aspect_ratio: effectiveRatio,
        image_size: sizes.has(size) ? size : '1K'
      }
    ]
  }

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    const raw = await response.text()
    let data: any = {}
    try { data = raw ? JSON.parse(raw) : {} } catch {}

    if (!response.ok) {
      return res.status(response.status).json({
        error: { message: data?.error?.message || raw || 'Gemini API request failed' }
      })
    }

    const image = findGeneratedImage(data)
    if (!image) return res.status(502).json({ error: { message: 'Gemini response had no image output' } })

    return res.status(200).json({
      image,
      meta: {
        providerId: 'gemini',
        modelId: 'gemini-3.1-flash-image',
        requestId: data?.id || null,
        profile: economyLongform ? 'economy-longform-v01' : '',
        effectiveAspectRatio: effectiveRatio,
        referenceCount: referenceBlocks.length
      }
    })
  } catch (error: any) {
    return res.status(500).json({ error: { message: error?.message || String(error) } })
  }
}