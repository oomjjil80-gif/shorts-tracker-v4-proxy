import type { Request, Response } from 'express'
import { handleBenchmarkCloneDiagnostic } from '../lib/benchmarkCloneDiagnostic.js'
import { handleBenchmarkRef01Diagnostic } from '../lib/benchmarkRef01Diagnostic.js'

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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
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

function extractSemanticTarget(prompt: string) {
  const text = String(prompt || '')
  const patternIndex = text.lastIndexOf('[PATTERN CONTRACT]')
  if (patternIndex >= 0) return text.slice(patternIndex).slice(0, 2200)

  const cutMatches = [...text.matchAll(/\[CUT\s+\d+\s+SCENE\]/gi)]
  const lastCut = cutMatches[cutMatches.length - 1]
  if (lastCut?.index != null) return text.slice(lastCut.index).slice(0, 2200)

  const directorIndex = text.lastIndexOf('[ECONOMY SCENE DIRECTOR')
  if (directorIndex >= 0) return text.slice(directorIndex).slice(0, 2200)

  return text.slice(-2200)
}

function economyLongformServerGuard() {
  return [
    '[SERVER STYLE LOCK — ECONOMY LONGFORM V0.1 / V7 QUALITY]',
    'This request is stateless. Reconstruct this visual identity on every request and ignore any conflicting legacy stick-figure, Gru/SD or 9:16 instruction.',
    'SEMANTIC PRIORITY: the CUT-specific meaning is more important than the finance style. The final scene must physically explain the exact relationship in the CUT. Never replace a specific relationship with a generic finance control room, trading desk, dashboard wall, data-stream room or random chart environment unless the CUT explicitly requires that setting.',
    'OUTPUT: exactly ONE 16:9 horizontal long-form image. No portrait frame, candidate sheet, collage, triptych, contact sheet or poster page.',
    'STYLE: premium Korean finance explainer; high-end editorial illustration + cinematic finance documentary atmosphere + refined semi-realistic 2.5D depth. Use deep navy, warm amber/orange key light and controlled red accents. Rich but organized environmental detail.',
    'MASCOT MANDATORY: exactly ONE clearly visible professional finance mascot in every generated still — round pale face, clean dark outline, simple readable eyes/mouth, navy suit, white shirt. About 8–10% of frame, secondary to the economic relationship. Keep the mascot spatially separated from crowds/subject groups so it is instantly identifiable. Never omit the mascot.',
    'NO SUBSTITUTE CHARACTER: no stick figure, no Gru/visitor SD character, no Pixar-like child character, no photoreal human protagonist. If population/crowd context is necessary, the compared population must be represented as anonymous simplified faceless silhouettes/tokens or distant grouped figures, while the finance mascot remains the only distinct foreground character.',
    'POPULATION/GENERATION COMPARISON RULE: when the CUT compares generations, population size, cohort size or group scale, show both groups simultaneously in the same frame using clearly different group width/height/count/occupied area. The size difference itself must be the dominant visual fact before any overlay text. Do not turn the groups into a detailed crowd of individually featured people.',
    'SCENE DESIGN: use one dominant economic relationship + one scene-specific visual metaphor. Translate meaning through space, scale, weight, direction, distance or transformation. For comparisons, the difference itself must be visible before any text. For cause/effect, the physical chain must be visible. Do not default to gauges, pipes, scales, machines, arrows or charts unless this CUT specifically needs them.',
    'NEW SCENE RESET: preserve only quality, lighting, palette, mascot design language and premium channel atmosphere. Never reuse previous-scene composition, props, objects, metaphor or background layout.',
    'INTEGRATED DEPTH: the scene must feel like one premium economic environment, not floating icons, a toy diorama, a classroom graphic or a card-news layout.',
    'ZERO GENERATED TEXT: render NO readable Korean, English, numbers, percentages, labels, logos, watermarks, subtitles, UI, signage, document text or monitor text in the base artwork. Tracker adds exact Korean text/numbers later with a deterministic overlay compositor. Any text request in the upstream prompt is semantic guidance only and must NOT be painted into the generated source image.',
    'If a monitor, document, sign or dashboard is visually necessary, use abstract non-readable shapes only.',
    'QUALITY FLOOR: reject cheap vector, flat infographic, PowerPoint, generic stock illustration, toy-like glossy 3D, children educational graphics and sparse poster composition.',
    'Before rendering, verify all seven: horizontal 16:9; exactly one separately identifiable finance mascot; premium V7 editorial depth; exact CUT meaning is visually dominant; population/group scenes keep ordinary people anonymous/subordinate; no previous-scene leakage; absolutely no readable text or numbers.'
  ].join('\n')
}

export default async function handler(req: Request, res: Response) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const diagnostic = String((req.query as any)?.diagnostic || '')
  if (req.method === 'GET' && diagnostic === 'benchmark-clone') {
    return handleBenchmarkCloneDiagnostic(req, res)
  }
  if (req.method === 'GET' && diagnostic === 'benchmark-ref01') {
    return handleBenchmarkRef01Diagnostic(req, res)
  }

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

  const semanticTarget = economyLongform ? extractSemanticTarget(prompt) : ''
  const guardedPrompt = economyLongform
    ? [
        '[CUT MEANING — HIGHEST PRIORITY]',
        semanticTarget,
        '',
        economyLongformServerGuard(),
        '',
        '[FULL CUT BRIEF — REFERENCE ONLY]',
        prompt,
        '',
        '[FINAL SERVER REMINDER]',
        'Show the exact CUT relationship, not generic finance scenery. Keep exactly one separately identifiable finance mascot. For population/group comparisons keep ordinary figures anonymous and subordinate. Output one premium 16:9 horizontal source image with zero readable text.'
      ].join('\n')
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
