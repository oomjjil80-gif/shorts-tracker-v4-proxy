import type { Request, Response } from 'express'

function setCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || '')
  const allowed =
    /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker\.vercel\.app$/i.test(origin) ||
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
  comprehension: 0.25,
  hierarchy: 0.15,
  metaphor: 0.15,
  premiumFinish: 0.15,
  realism: 0.10,
  stickmanConsistency: 0.08,
  cleanliness: 0.07,
  frameSafety: 0.05,
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
    'You are the final senior art director for a premium Korean economy YouTube channel.',
    'Judge ONLY the actual final 9:16 image shown to you. Be strict and do not reward intention.',
    `Publication target is ${targetScore}/100 or higher and should look at least one level above a typical good economy explainer thumbnail/scene.`,
    'The frame should combine a realistic or premium semi-realistic real-world background, one dominant economic visual metaphor, a secondary consistent 2D stickman explainer, exact readable overlay text/numbers when present, and strong mobile hierarchy.',
    'A viewer should understand the direction of the economic relationship within about one second on a phone screen.',
    '',
    'Score EACH dimension from 0 to 100:',
    'comprehension: one-second understanding of the core economic relationship.',
    'hierarchy: one dominant idea/object, clear eye path, no competing focal points.',
    'metaphor: strength and relevance of the visual metaphor; not generic decoration.',
    'premiumFinish: professional art direction, composition, depth, polish; not cheap educational clip-art.',
    'realism: believable real-world background integrated with the graphics.',
    'stickmanConsistency: stickman is visually consistent, secondary, useful, and not awkwardly cropped.',
    'cleanliness: no broken generated text, nonsense labels, accidental logos, comic bubbles, clutter, or irrelevant ornaments.',
    'frameSafety: important subjects and overlays are not clipped and remain readable on mobile.',
    '',
    'SEVERE FAIL if ANY of these occurs: real human is the main protagonist; broken/nonsense generated text is prominent; blank infographic/card-news canvas; core meaning cannot be understood in one second; badly clipped key subject; the requested economy concept is visually wrong.',
    'If exact overlay text added by the editing layer is clean and readable, treat it as a positive. Do not penalize correct Korean text simply because the generation prompt prohibited AI-generated text.',
    '',
    'Return JSON only in this exact shape:',
    '{"dimensions":{"comprehension":0,"hierarchy":0,"metaphor":0,"premiumFinish":0,"realism":0,"stickmanConsistency":0,"cleanliness":0,"frameSafety":0},"severe":false,"reasons":["..."],"correctionPrompt":"..."}',
    'reasons: max 6 concise reasons, strongest problems first.',
    'correctionPrompt: concrete regeneration instructions that fix the weakest dimensions. Do not mention policy or the scoring process.',
    '',
    'ORIGINAL GENERATION PROMPT:',
    prompt.slice(0, 14000)
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
    const weakDimensions = Object.entries(dimensions)
      .filter(([, v]) => v < targetScore)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 4)
      .map(([k]) => k)
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map((v: any) => String(v)).slice(0, 6) : []
    const severe = Boolean(parsed.severe)

    return res.status(200).json({
      score,
      targetScore,
      pass: score >= targetScore && !severe,
      severe,
      dimensions,
      weakDimensions,
      reasons,
      correctionPrompt: String(parsed.correctionPrompt || '').slice(0, 1800),
      modelId: 'gemini-2.5-flash',
      rubricVersion: 'economy-premium-v2'
    })
  } catch (error: any) {
    return res.status(500).json({ error: { message: error?.message || String(error) } })
  }
}
