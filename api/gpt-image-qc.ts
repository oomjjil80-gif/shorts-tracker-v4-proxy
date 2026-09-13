import type { Request, Response } from 'express'

function setCors(_req: Request, res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
  res.setHeader('Cache-Control', 'no-store')
}

function extractText(data: any) {
  if (typeof data?.output_text === 'string') return data.output_text.trim()
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') return content.text.trim()
    }
  }
  return ''
}

function imageDimensionsFromBase64(base64: string, mimeType: string) {
  try {
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length < 24) return null
    const mime = String(mimeType || '').toLowerCase()
    const isPng = mime.includes('png') || (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    if (isPng && bytes.length >= 24) {
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      if (width > 0 && height > 0) return { width, height }
    }

    const isJpeg = mime.includes('jpeg') || mime.includes('jpg') || (bytes[0] === 0xff && bytes[1] === 0xd8)
    if (isJpeg) {
      let offset = 2
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue }
        const marker = bytes[offset + 1]
        offset += 2
        if (marker === 0xd8 || marker === 0xd9) continue
        if (offset + 2 > bytes.length) break
        const length = bytes.readUInt16BE(offset)
        if (length < 2 || offset + length > bytes.length) break
        const isSof = [0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)
        if (isSof && length >= 7) {
          const height = bytes.readUInt16BE(offset + 3)
          const width = bytes.readUInt16BE(offset + 5)
          if (width > 0 && height > 0) return { width, height }
        }
        offset += length
      }
    }
  } catch {}
  return null
}

const QC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'decision',
    'semanticMatch',
    'financeMascotCount',
    'defects',
    'reason',
    'retryInstruction',
    'confidence'
  ],
  properties: {
    decision: { type: 'string', enum: ['PASS', 'RETRY'] },
    semanticMatch: { type: 'boolean' },
    financeMascotCount: { type: 'integer', minimum: 0, maximum: 10 },
    defects: {
      type: 'object',
      additionalProperties: false,
      required: [
        'generatedText',
        'missingOrBrokenFace',
        'characterStyleBreak',
        'realHumanProtagonist',
        'brokenAnatomy',
        'blankCanvas',
        'irrelevantMeaning',
        'badComposition',
        'mascotMissingOrWrongCount',
        'styleFloorFailure',
        'wrongOrientation'
      ],
      properties: {
        generatedText: { type: 'boolean' },
        missingOrBrokenFace: { type: 'boolean' },
        characterStyleBreak: { type: 'boolean' },
        realHumanProtagonist: { type: 'boolean' },
        brokenAnatomy: { type: 'boolean' },
        blankCanvas: { type: 'boolean' },
        irrelevantMeaning: { type: 'boolean' },
        badComposition: { type: 'boolean' },
        mascotMissingOrWrongCount: { type: 'boolean' },
        styleFloorFailure: { type: 'boolean' },
        wrongOrientation: { type: 'boolean' }
      }
    },
    reason: { type: 'string' },
    retryInstruction: { type: 'string' },
    confidence: { type: 'integer', minimum: 0, maximum: 100 }
  }
} as const

export default async function handler(req: Request, res: Response) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: Boolean(process.env.OPENAI_API_KEY),
      provider: 'OpenAI',
      model: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini',
      contractVersion: 'gpt-vision-qc-v1.4'
    })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } })
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: { message: 'OPENAI_API_KEY is not configured' } })
  }

  const input = req.body?.input || {}
  const prompt = String(input.prompt || '').trim()
  const imageBase64 = String(input.imageBase64 || '').replace(/^data:[^;]+;base64,/, '')
  const mimeType = String(input.mimeType || 'image/png').trim() || 'image/png'
  const context = input.context && typeof input.context === 'object' ? input.context : {}
  const economyLongform = context?.economyLongformV01 === true || String(context?.profile || '') === 'economy-longform-v01'
  const actualDimensions = imageDimensionsFromBase64(imageBase64, mimeType)
  const actualRatio = actualDimensions ? actualDimensions.width / actualDimensions.height : null
  const deterministicWrongOrientation = Boolean(economyLongform && actualRatio != null && (actualRatio < 1.60 || actualRatio > 1.95))

  if (!prompt) return res.status(400).json({ error: { message: 'prompt is required' } })
  if (!imageBase64) return res.status(400).json({ error: { message: 'imageBase64 is required' } })

  const instructions = [
    'You are the independent Vision QC reviewer for a Korean YouTube production pipeline.',
    'The image was generated by Gemini. You are NOT the generator. Judge it independently.',
    'Do not use a numeric aesthetic score as the main decision. PASS only when the image can safely be used for this CUT.',
    '',
    '[Priority order]',
    '1. Semantic match: does the image explain the exact CUT meaning, not a neighboring or generic economy concept?',
    '2. Hard defects: generated readable text when forbidden, missing/broken primary face, style break, photoreal human replacing required channel character, broken anatomy, accidental blank poster/card, clearly irrelevant meaning.',
    '3. Composition: the main relation should be understandable quickly and should leave safe space for Tracker deterministic overlay.',
    '',
    '[Base-image text rule]',
    'For economy longform, the generated source artwork must contain ZERO clearly readable Korean, English, numbers, percentages, labels, logos, watermarks, subtitles or UI. Tracker adds exact Korean text/numbers later with a deterministic overlay compositor.',
    'Mark generatedText=true ONLY when a normal viewer at ordinary playback scale can actually read or clearly recognize a meaningful text/number/symbol sequence.',
    'Readable labels such as GDP, DATA INPUT, 3.1%, $ or ₩ count as generated text and must fail.',
    'Do NOT mark generatedText=true for tiny illegible pseudo-glyphs, abstract strokes, texture, scribbles, decorative marks, unlabeled chart ticks, unreadable document filler, or shapes that merely resemble writing when no actual sequence can be read.',
    'For economy longform, any clearly readable generated text/number/label on monitors, documents, signs, interfaces or the scene itself means generatedText=true and decision=RETRY.',
    'For non-economy paths, treat prominent unintended or nonsense generated text as a defect according to the supplied prompt.',
    '',
    ...(economyLongform ? [
      '[ECONOMY LONGFORM V0.1 — HARD QC GATES]',
      'This path has four additional non-negotiable hard gates.',
      'A. MASCOT IDENTITY/COUNT: count ONLY characters that actually match the required professional finance mascot: one visually distinct round pale face with clean dark outline, simple readable eyes/mouth, navy suit and white shirt, intentionally isolated as the supporting explainer. Return that number in financeMascotCount.',
      'A crowd member, ordinary human figure, background silhouette, elderly/young person, person-shaped token or generic suit does NOT count as the finance mascot.',
      'If financeMascotCount is not exactly 1, set mascotMissingOrWrongCount=true and decision=RETRY. If a population/crowd is needed for the CUT, the population should remain visually subordinate/anonymous while the single mascot is separately identifiable.',
      'B. STYLE FLOOR: the frame must read as premium Korean finance editorial / cinematic finance documentary with refined semi-realistic 2.5D depth, integrated environment, deep navy + warm amber/orange + controlled red, rich but organized detail. If it looks like cheap vector, flat infographic, PowerPoint/card-news, children educational art, toy-like glossy 3D, generic stock illustration, or simplistic animation, set styleFloorFailure=true and decision=RETRY.',
      'C. ORIENTATION: the source artwork must be a single horizontal 16:9 long-form composition. Use the supplied actual pixel dimensions as authoritative when available. If portrait/vertical, square, candidate sheet, or clearly non-horizontal, set wrongOrientation=true and decision=RETRY.',
      'D. SEMANTIC SPECIFICITY: if the CUT is about a concrete relationship such as generation-size difference, debt burden, price gap, cause/effect, policy path or asset comparison, the image must visibly show that relationship. A generic finance command center, trading room, dashboard wall, data-stream room, random chart room or generic money scene is NOT a semantic match unless the CUT explicitly asks for that setting. In that case set semanticMatch=false and irrelevantMeaning=true.',
      'The economic relationship/metaphor must remain the main subject. Mascot is a supporting explainer, not the main subject.',
      ''
    ] : []),
    '[Decision rule]',
    'If ANY hard defect is clearly present, decision=RETRY.',
    'If semanticMatch=false, decision=RETRY.',
    'For economy longform, generatedText=true OR financeMascotCount!=1 OR mascotMissingOrWrongCount=true OR styleFloorFailure=true OR wrongOrientation=true always means RETRY.',
    'Otherwise PASS unless composition is so poor that the intended meaning cannot be understood.',
    'For RETRY, write a short retryInstruction that preserves good parts and fixes only the failure.',
    'Return JSON only.'
  ].join('\n')

  const contentText = [
    '[CUT generation prompt / semantic target]',
    prompt,
    '',
    '[Structured CUT context]',
    JSON.stringify({ ...context, actualImageDimensions: actualDimensions, actualAspectRatio: actualRatio })
  ].join('\n')

  const model = String(process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini')

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: economyLongform ? 'medium' : 'low' },
        instructions,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: contentText },
            { type: 'input_image', image_url: `data:${mimeType};base64,${imageBase64}` }
          ]
        }],
        text: {
          format: {
            type: 'json_schema',
            name: 'tracker_image_qc',
            strict: true,
            schema: QC_SCHEMA
          }
        }
      })
    })

    const raw = await response.text()
    let data: any = {}
    try { data = raw ? JSON.parse(raw) : {} } catch {}

    if (!response.ok) {
      return res.status(response.status).json({
        error: { message: data?.error?.message || raw || 'OpenAI image QC request failed' }
      })
    }

    const text = extractText(data)
    if (!text) return res.status(502).json({ error: { message: 'OpenAI image QC response had no text output' } })

    let result: any
    try { result = JSON.parse(text) }
    catch {
      return res.status(502).json({ error: { message: 'OpenAI image QC response was not valid JSON' } })
    }

    if (!result.defects || typeof result.defects !== 'object') result.defects = {}
    if (economyLongform && Number(result?.financeMascotCount) !== 1) result.defects.mascotMissingOrWrongCount = true
    if (deterministicWrongOrientation) result.defects.wrongOrientation = true

    const economyHardGate = economyLongform && Boolean(
      result?.defects?.generatedText ||
      Number(result?.financeMascotCount) !== 1 ||
      result?.defects?.mascotMissingOrWrongCount ||
      result?.defects?.styleFloorFailure ||
      result?.defects?.wrongOrientation ||
      result?.semanticMatch === false
    )
    if (economyHardGate) result.decision = 'RETRY'

    console.log('[GPT_IMAGE_QC]', JSON.stringify({
      decision: result?.decision,
      semanticMatch: result?.semanticMatch,
      financeMascotCount: result?.financeMascotCount,
      defects: result?.defects,
      confidence: result?.confidence,
      actualDimensions,
      actualRatio,
      economyLongform
    }))

    return res.status(200).json({
      ok: true,
      ...result,
      provider: 'OpenAI',
      model,
      contractVersion: 'gpt-vision-qc-v1.4',
      actualDimensions,
      actualAspectRatio: actualRatio,
      usage: data?.usage || null
    })
  } catch (error: any) {
    return res.status(500).json({ error: { message: error?.message || String(error) } })
  }
}
