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
  if (!prompt || !imageBase64) return res.status(400).json({ error: { message: 'prompt and imageBase64 are required' } })

  const rubric = [
    'You are a strict senior art director reviewing ONE vertical 9:16 economy explainer image.',
    'Judge the actual image, not the intention in the prompt.',
    'Target quality: premium Korean economy YouTube visual, stronger than generic educational illustration.',
    'Required: realistic or premium semi-realistic real-world background; one dominant economic visual metaphor; clear 1-second comprehension; stickman as secondary explainer, not main subject; clean hierarchy; no accidental generated text/numbers; no real-human protagonist; no clipped body/objects; no comic thought bubbles; no empty poster/card-news look.',
    'Return JSON only with this exact shape:',
    '{"score":0,"pass":false,"severe":false,"reasons":["..."],"correctionPrompt":"..."}',
    'Scoring: 90-100 publishable premium, 82-89 good but improvable, 70-81 mediocre, below 70 reject.',
    'severe=true if there is a real-human protagonist, obvious broken/generated text, blank infographic canvas, badly clipped subject, or the core economic meaning is not understandable in about one second.',
    'correctionPrompt must be concise and actionable for a regeneration model. Do not mention policy or process.',
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
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
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
    const score = Math.max(0, Math.min(100, Number(parsed.score || 0)))
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map((v: any) => String(v)).slice(0, 6) : []
    const severe = Boolean(parsed.severe)
    return res.status(200).json({
      score,
      pass: score >= 82 && !severe,
      severe,
      reasons,
      correctionPrompt: String(parsed.correctionPrompt || '').slice(0, 1600),
      modelId: 'gemini-2.5-flash'
    })
  } catch (error: any) {
    return res.status(500).json({ error: { message: error?.message || String(error) } })
  }
}
