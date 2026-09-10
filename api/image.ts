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

export default async function handler(req: Request, res: Response) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } })

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return res.status(503).json({ error: { message: 'GEMINI_API_KEY is not configured' } })

  const input = req.body?.input || {}
  const prompt = String(input.prompt || '').trim()
  if (!prompt) return res.status(400).json({ error: { message: 'prompt is required' } })

  const ratio = String(input.aspectRatio || '9:16')
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

  const interactionInput = referenceBlocks.length
    ? [
        {
          type: 'text',
          text: [
            'Use the provided reference images as identity/style anchors. Preserve face, hair, beard, age, clothing, body proportions, and core character design unless the prompt explicitly requests a scene-type transformation such as the established SD version.',
            'Generate exactly ONE final image for this CUT. Do not return a candidate sheet, variations, collage, triptych, or contact sheet.',
            prompt
          ].join('\n\n')
        },
        ...referenceBlocks
      ]
    : [
        {
          type: 'text',
          text: 'Generate exactly ONE final image for this CUT. Do not return a candidate sheet, variations, collage, triptych, or contact sheet.\n\n' + prompt
        }
      ]

  const payload = {
    model: 'gemini-3.1-flash-image',
    input: interactionInput,
    response_format: [
      {
        type: 'image',
        aspect_ratio: ratios.has(ratio) ? ratio : '9:16',
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
        requestId: data?.id || null
      }
    })
  } catch (error: any) {
    return res.status(500).json({ error: { message: error?.message || String(error) } })
  }
}
