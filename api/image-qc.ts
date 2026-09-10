import type { Request, Response } from 'express'

function setCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || '')
  const allowed =
    /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker\.vercel\.app$/i.test(origin) ||\n    /^https:\/\/(?:www\.)?trackervercel\.app$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker-[a-z0-9-]+\.vercel\.app$/i.test(origin)
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
}

function extractJson(text: string) {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

function clampScore(v: any) {
  return Math.max(0, Math.min(100, Number(v || 0)))
}

const WEIGHTS: Record<string, number> = {
  semanticMatch: 0.28,
  comprehension: 0.20,
  hierarchy: 0.12,
  metaphor: 0.12,
  premiumFinish: 0.10,
  realism: 0.07,
  stickmanConsistency: 0.04,
  cleanliness: 0.04,
  frameSafety: 0.03,
}

export default async function handler(req: Request, res: Response) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } })

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return res.status(503).json({ error: { message: 'GEMINI_API_KEY is not configured' } })

  const input = req.body?.input || {}
  const prompt = String(input.prompt || '').trim()
  const imageBase64 = String(input.imageBase64 || '').replace(/^data:[^;]+;base64,/, '')
  const mimeType = String(input.mimeType || 'image/png')
  const targetScore = Math.max(82, Math.min(95, Number(input.targetScore || 88)))
  if (!prompt || !imageBase64) return res.status(400).json({ error: { message: 'prompt and imageBase64 are required' } })

  const rubric = [
    'You are the final senior art director and semantic QC editor for a premium Korean economy YouTube channel.',
    'Judge ONLY the actual final image shown to you against the ORIGINAL GENERATION PROMPT. Be strict and do not reward intention.',
    `Publication target is ${targetScore}/100 or higher.`,
    '',
    '[HIGHEST PRIORITY: NARRATION ↔ IMAGE SEMANTIC MATCH]',
    'The prompt can contain CUT SEMANTIC TARGET / narration / screen goal / visual focus. Treat those as the source of truth for what this exact CUT is saying.',
    'Do not accept a pretty or generally economy-related image if it illustrates a neighboring sentence, a different cause/result, or a generic money scene instead of the current narration meaning.',
    'semanticMatch means: the dominant visual relationship, actors/objects, comparison direction, cause/result direction and emotional situation all correspond to this exact narration/screen goal.',
    'If the image invents poverty, bankruptcy, crash, inheritance, generational conflict, political blame, or another dramatic claim not present in the CUT semantic target, semanticMatch must be low and severe=true when the invented meaning dominates the frame.',
    'For abstract economic concepts, an accurate comparison/data/symbolic screen is better than a forced staged scene.',
    '',
    'Score EACH dimension from 0 to 100:',
    'semanticMatch: exact match between this CUT narration/screen goal and what the image actually communicates. This is the most important score.',
    'comprehension: one-second understanding of the core economic relationship.',
    'hierarchy: one dominant idea/object, clear eye path, no competing focal points.',
    'metaphor: strength and relevance of the visual metaphor; not generic decoration.',
    'premiumFinish: professional art direction, composition, depth, polish; not cheap educational clip-art.',
    'realism: believable real-world background integrated with the graphics.',
    'stickmanConsistency: stickman is visually consistent, secondary, useful, and not awkwardly cropped.',
    'cleanliness: no broken generated text, nonsense labels, accidental logos, comic bubbles, clutter, or irrelevant ornaments.',
    'frameSafety: important subjects and overlays are not clipped and remain readable on mobile.',
    '',
    '[HARD DEFECT GATES — INSPECT PIXELS, DO NOT GUESS INTENT]',
    'visibleGeneratedText: true if the source image itself contains ANY visible Korean/English word, readable label, number, percentage, caption, title, watermark or UI-like text. This includes plausible-looking but wrong text. Decorative currency symbols count only when clearly text-like.',
    'missingOrBrokenFace: true if any primary stick-figure character has a blank/missing face, severely malformed facial features, duplicated/fragmented face, or face is unintentionally obscured.',
    'characterStyleBreak: true if a primary character visibly changes away from the established simple 2D stick-figure language (for example a realistic elderly person, different illustration family, inconsistent body/face treatment) without the CUT explicitly requiring it.',
    'realHumanProtagonist: true if a photorealistic human becomes the main protagonist where the stick-figure channel style is required.',
    'brokenAnatomy: true for obvious extra/missing limbs, impossible hand/arm attachment, merged body parts, or severe character deformation.',
    'blankCanvas: true for a large empty card/white panel or poster-like canvas that looks like unfinished generated infographic space rather than intentional Tracker overlay safe-space.',
    'irrelevantMeaning: true when the dominant scene represents a different economic claim from the exact CUT narration/screen goal.',
    '',
    'SEVERE FAIL if ANY hard defect above is true, OR semanticMatch below 55, OR the core meaning cannot be understood in one second, OR a key subject is badly clipped.',
    'IMPORTANT: This endpoint evaluates the CLEAN SOURCE IMAGE BEFORE Tracker overlays. Therefore any visible title/caption/number already present in the supplied image is a defect, even if the wording looks correct.',
    '',
    'Return JSON only in this exact shape:',
    '{"dimensions":{"semanticMatch":0,"comprehension":0,"hierarchy":0,"metaphor":0,"premiumFinish":0,"realism":0,"stickmanConsistency":0,"cleanliness":0,"frameSafety":0},"defects":{"visibleGeneratedText":false,"missingOrBrokenFace":false,"characterStyleBreak":false,"realHumanProtagonist":false,"brokenAnatomy":false,"blankCanvas":false,"irrelevantMeaning":false},"severe":false,"reasons":["..."],"correctionPrompt":"..."}',
    'reasons: max 6 concise reasons, strongest semantic mismatch first.',
    'correctionPrompt: concrete regeneration instructions that fix the exact narration-to-image mismatch first, then the weakest visual dimensions. Do not mention policy or scoring.',
    '',
    'ORIGINAL GENERATION PROMPT:',
    prompt.slice(0, 16000)
  ].join('\n')

  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: rubric },
        { inlineData: { mimeType, data: imageBase64 } }
      ]
    }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const raw = await response.text()
    let data: any = {}
    try { data = raw ? JSON.parse(raw) : {} } catch {}
    if (!response.ok) return res.status(response.status).json({ error: { message: data?.error?.message || raw || 'Gemini QC request failed' } })

    const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('\n') || ''
    const parsed = extractJson(text) || {}
    const rawDims = parsed?.dimensions || {}
    const dimensions: Record<string, number> = {}
    for (const key of Object.keys(WEIGHTS)) dimensions[key] = clampScore(rawDims[key])
    const score = Math.round(Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + dimensions[key] * weight, 0))
    const semanticSevere = dimensions.semanticMatch < 55
    const weakDimensions = Object.entries(dimensions)
      .filter(([, v]) => v < targetScore)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 4)
      .map(([k]) => k)
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map((v: any) => String(v)).slice(0, 6) : []
    const rawDefects = parsed?.defects || {}
    const defects = {
      visibleGeneratedText: Boolean(rawDefects.visibleGeneratedText),
      missingOrBrokenFace: Boolean(rawDefects.missingOrBrokenFace),
      characterStyleBreak: Boolean(rawDefects.characterStyleBreak),
      realHumanProtagonist: Boolean(rawDefects.realHumanProtagonist),
      brokenAnatomy: Boolean(rawDefects.brokenAnatomy),
      blankCanvas: Boolean(rawDefects.blankCanvas),
      irrelevantMeaning: Boolean(rawDefects.irrelevantMeaning),
    }
    const hardDefect = Object.values(defects).some(Boolean)
    const severe = Boolean(parsed.severe) || semanticSevere || hardDefect

    return res.status(200).json({
      score,
      targetScore,
      pass: score >= targetScore && dimensions.semanticMatch >= 75 && !severe && !hardDefect,
      severe,
      hardDefect,
      defects,
      dimensions,
      weakDimensions,
      reasons,
      correctionPrompt: String(parsed.correctionPrompt || '').slice(0, 2200),
      modelId: 'gemini-2.5-flash',
      rubricVersion: 'economy-semantic-premium-v4-hard-gates'
    })
  } catch (error: any) {
    return res.status(500).json({ error: { message: error?.message || String(error) } })
  }
}
