import express from 'express'
import { put, get } from '@vercel/blob'

const app = express()

app.use(express.json({ limit: '256kb' }))

function cors(req: express.Request, res: express.Response) {
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

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

app.use((req, res, next) => {
  cors(req, res)

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  next()
})

const STORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'seriesType',
    'title',
    'subject',
    'hook',
    'summary',
    'cutCountSuggested',
    'cuts',
    'imageStyleNote',
    'warnings'
  ],
  properties: {
    seriesType: { type: 'string' },
    title: { type: 'string' },
    subject: { type: 'string' },
    hook: { type: 'string' },
    summary: { type: 'string' },
    imageStyleNote: { type: 'string' },

    cutCountSuggested: {
      type: 'integer',
      minimum: 1,
      maximum: 30
    },

    warnings: {
      type: 'array',
      items: { type: 'string' }
    },

    cuts: {
      type: 'array',
      minItems: 1,
      maxItems: 30,

      items: {
        type: 'object',
        additionalProperties: false,

        required: [
          'purpose',
          'situation',
          'narration',
          'directorNote',
          'imagePrompt',
          'dialogueLines'
        ],

        properties: {
          purpose: { type: 'string' },
          situation: { type: 'string' },
          narration: { type: 'string' },
          directorNote: { type: 'string' },
          imagePrompt: { type: 'string' },

          dialogueLines: {
            type: 'array',

            items: {
              type: 'object',
              additionalProperties: false,

              required: [
                'speaker',
                'text',
                'voice'
              ],

              properties: {
                speaker: { type: 'string' },
                text: { type: 'string' },
                voice: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }
}

function systemPrompt(
  seriesType: string,
  targetSeconds: number,
  targetCutCount: number,
  imageStyleNote: string
) {
  const rules: Record<string, string> = {
    general_issue:
      '한국어 쇼츠용 시사/일반 이슈. 첫 1~2초 훅을 강하게 만들되 사실과 추측을 섞지 말고 과장된 단정을 피한다.',

    horror:
      '한국어 괴담 쇼츠. 초반 불안감, 정보 지연, 후반 반전 또는 여운을 만든다.',

    two_year_intern:
      '두살인턴 IP. 2살 외형과 달관한 직장인 사고방식의 부조화가 핵심이며 과장된 아기말은 사용하지 않는다.',

    freeform:
      '한국어 자유형 쇼츠. 입력 소재에 가장 적합한 구조를 선택한다.'
  }

  return [
    '당신은 Shorts Production Tracker의 Story Writer다.',
    rules[seriesType] || rules.freeform,
    `목표 길이 ${targetSeconds}초, 목표 CUT ${targetCutCount}개.`,
    '각 CUT narration은 실제 TTS에 바로 사용할 수 있는 자연스러운 한국어로 작성한다.',
    'imagePrompt는 구체적인 장면 지시로 작성하고 이미지 안 텍스트는 금지한다.',
    `전체 이미지 스타일 참고: ${imageStyleNote || '일관된 9:16 쇼츠 비주얼'}.`,
    '반드시 지정된 JSON schema만 출력한다.'
  ].join('\n')
}

function extractText(data: any) {
  if (typeof data?.output_text === 'string') {
    return data.output_text
  }

  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') {
        return content.text
      }
    }
  }

  return ''
}

function findGeneratedImage(data: any) {
  if (data?.output_image?.data) {
    return {
      base64: data.output_image.data,
      mimeType:
        data.output_image.mime_type ||
        data.output_image.mimeType ||
        'image/png'
    }
  }

  for (const step of data?.steps || []) {
    if (step?.type !== 'model_output') continue

    for (const block of step?.content || []) {
      if (block?.type === 'image' && block?.data) {
        return {
          base64: block.data,
          mimeType:
            block.mime_type ||
            block.mimeType ||
            'image/png'
        }
      }
    }
  }

  return null
}

function safeWorkspace(value: unknown) {
  const raw = String(value || 'default')
    .trim()
    .toLowerCase()

  const safe = raw.replace(/[^a-z0-9_-]/g, '-').slice(0, 64)

  return safe || 'default'
}

function safeSlot(value: unknown) {
  return String(value) === 'b' ? 'b' : 'a'
}

function chunkPath(
  workspace: string,
  slot: string,
  index: number
) {
  return `tracker-sync/${workspace}/${slot}/chunk-${index}.bin`
}

function manifestPath(
  workspace: string,
  slot: string
) {
  return `tracker-sync/${workspace}/${slot}/manifest.json`
}

function pointerPath(workspace: string) {
  return `tracker-sync/${workspace}/current.json`
}

async function readPrivateText(path: string) {
  const result = await get(path, {
    access: 'private',
    useCache: false
  })

  if (!result || result.statusCode !== 200 || !result.stream) {
    return null
  }

  return await new Response(result.stream).text()
}

/* -----------------------------
   HEALTH
----------------------------- */

app.get('/', (_req, res) => {
  res.status(200).json({
    service: 'Shorts Tracker V4 Proxy',
    status: 'ok'
  })
})

app.get('/healthz', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  })
})

app.get('/api/health', (_req, res) => {
  const configured = Boolean(process.env.OPENAI_API_KEY)

  res.status(configured ? 200 : 503).json({
    ok: configured,
    provider: 'OpenAI',
    model: process.env.OPENAI_MODEL || 'gpt-5-mini',
    keyConfigured: configured
  })
})

app.get('/api/image-health', (_req, res) => {
  const configured = Boolean(process.env.GEMINI_API_KEY)

  res.status(configured ? 200 : 503).json({
    ok: configured,
    providerId: 'gemini',
    modelId: 'gemini-3.1-flash-image',
    keyConfigured: configured
  })
})

app.get('/api/sync-health', (_req, res) => {
  const configured =
    Boolean(process.env.BLOB_READ_WRITE_TOKEN) ||
    Boolean(process.env.BLOB_STORE_ID)

  res.status(configured ? 200 : 503).json({
    ok: configured,
    provider: 'Vercel Blob',
    access: 'private',
    configured
  })
})

/* -----------------------------
   GEMINI IMAGE
----------------------------- */

app.post('/api/image', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY

  if (!apiKey) {
    return res.status(503).json({
      error: {
        message: 'GEMINI_API_KEY is not configured'
      }
    })
  }

  const input = req.body?.input || {}
  const prompt = String(input.prompt || '').trim()

  if (!prompt) {
    return res.status(400).json({
      error: {
        message: 'prompt is required'
      }
    })
  }

  const ratio = String(input.aspectRatio || '9:16')
  const size = String(input.imageSize || '1K')

  const ratios = new Set([
    '1:1',
    '2:3',
    '3:2',
    '3:4',
    '4:3',
    '4:5',
    '5:4',
    '9:16',
    '16:9',
    '21:9',
    '1:4',
    '4:1',
    '1:8',
    '8:1'
  ])

  const sizes = new Set([
    '0.5K',
    '1K',
    '2K',
    '4K'
  ])

  const payload = {
    model: 'gemini-3.1-flash-image',
    input: prompt,

    response_format: [
      {
        type: 'image',
        aspect_ratio:
          ratios.has(ratio) ? ratio : '9:16',

        image_size:
          sizes.has(size) ? size : '1K'
      }
    ]
  }

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      {
        method: 'POST',

        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json'
        },

        body: JSON.stringify(payload)
      }
    )

    const raw = await response.text()

    let data: any = {}

    try {
      data = raw ? JSON.parse(raw) : {}
    } catch {}

    if (!response.ok) {
      return res.status(response.status).json({
        error: {
          message:
            data?.error?.message ||
            raw ||
            'Gemini API request failed'
        }
      })
    }

    const image = findGeneratedImage(data)

    if (!image) {
      return res.status(502).json({
        error: {
          message:
            'Gemini response had no image output'
        }
      })
    }

    return res.status(200).json({
      image,

      meta: {
        providerId: 'gemini',
        modelId: 'gemini-3.1-flash-image',
        requestId: data?.id || null
      }
    })
  } catch (error: any) {
    return res.status(500).json({
      error: {
        message:
          error?.message || String(error)
      }
    })
  }
})

/* -----------------------------
   OPENAI STORY
----------------------------- */

app.post('/api/story', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: {
        message:
          'OPENAI_API_KEY is not configured'
      }
    })
  }

  const body = req.body || {}
  const input = body.input || {}
  const topic = String(input.topic || '').trim()

  if (!topic) {
    return res.status(400).json({
      error: {
        message: 'topic is required'
      }
    })
  }

  const model = String(
    body.modelId ||
    process.env.OPENAI_MODEL ||
    'gpt-5-mini'
  )

  const targetSeconds = Math.max(
    10,
    Math.min(
      180,
      Number(input.targetSeconds) || 45
    )
  )

  const targetCutCount = Math.max(
    1,
    Math.min(
      30,
      Number(input.targetCutCount) || 8
    )
  )

  const reasoningEffort =
    ['minimal', 'low', 'medium', 'high']
      .includes(body.reasoningEffort)
      ? body.reasoningEffort
      : 'low'

  const payload = {
    model,

    reasoning: {
      effort: reasoningEffort
    },

    instructions: systemPrompt(
      String(input.seriesType || 'freeform'),
      targetSeconds,
      targetCutCount,
      String(input.imageStyleNote || '')
    ),

    input: topic,

    text: {
      format: {
        type: 'json_schema',
        name: 'story_draft',
        strict: true,
        schema: STORY_SCHEMA
      }
    }
  }

  try {
    const response = await fetch(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bearer ${process.env.OPENAI_API_KEY}`,

          'Content-Type':
            'application/json'
        },

        body: JSON.stringify(payload)
      }
    )

    const data: any =
      await response.json()

    if (!response.ok) {
      return res.status(response.status).json({
        error: {
          message:
            data?.error?.message ||
            'OpenAI API request failed'
        }
      })
    }

    const text = extractText(data)

    if (!text) {
      return res.status(502).json({
        error: {
          message:
            'OpenAI response had no text output'
        }
      })
    }

    return res.status(200).json({
      draft: JSON.parse(text),

      meta: {
        provider: 'openai',
        model,
        responseId: data?.id || null,
        usage: data?.usage || null
      }
    })
  } catch (error: any) {
    return res.status(500).json({
      error: {
        message:
          error?.message || String(error)
      }
    })
  }
})

/* -----------------------------
   CLOUD SYNC
----------------------------- */

/*
  전체 백업은 약 2MB 단위로 분할해서 전송한다.
  application/octet-stream 요청만 raw body로 받는다.
*/

app.post(
  '/api/sync/chunk',
  express.raw({
    type: 'application/octet-stream',
    limit: '3mb'
  }),
  async (req, res) => {
    try {
      const workspace =
        safeWorkspace(req.query.workspace)

      const slot =
        safeSlot(req.query.slot)

      const index =
        Math.max(
          0,
          Math.floor(
            Number(req.query.index) || 0
          )
        )

      const body =
        Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(req.body || [])

      if (!body.length) {
        return res.status(400).json({
          error: {
            message: 'chunk body is empty'
          }
        })
      }

      const path =
        chunkPath(
          workspace,
          slot,
          index
        )

      const blob =
        await put(
          path,
          body,
          {
            access: 'private',
            allowOverwrite: true,
            addRandomSuffix: false,
            contentType:
              'application/octet-stream'
          }
        )

      return res.status(200).json({
        ok: true,
        workspace,
        slot,
        index,
        size: body.length,
        etag: blob.etag
      })
    } catch (error: any) {
      return res.status(500).json({
        error: {
          message:
            error?.message ||
            String(error)
        }
      })
    }
  }
)

app.post('/api/sync/commit', async (req, res) => {
  try {
    const workspace =
      safeWorkspace(req.body?.workspace)

    const slot =
      safeSlot(req.body?.slot)

    const chunkCount =
      Math.max(
        1,
        Math.floor(
          Number(req.body?.chunkCount) || 1
        )
      )

    const totalBytes =
      Math.max(
        0,
        Math.floor(
          Number(req.body?.totalBytes) || 0
        )
      )

    const updatedAt =
      new Date().toISOString()

    const manifest = {
      format: 'SPB1-CLOUD',
      version: 1,
      workspace,
      slot,
      chunkCount,
      totalBytes,
      updatedAt
    }

    await put(
      manifestPath(
        workspace,
        slot
      ),
      JSON.stringify(manifest),
      {
        access: 'private',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType:
          'application/json'
      }
    )

    await put(
      pointerPath(workspace),
      JSON.stringify({
        activeSlot: slot,
        updatedAt
      }),
      {
        access: 'private',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType:
          'application/json'
      }
    )

    return res.status(200).json({
      ok: true,
      ...manifest
    })
  } catch (error: any) {
    return res.status(500).json({
      error: {
        message:
          error?.message ||
          String(error)
      }
    })
  }
})

app.get('/api/sync/status', async (req, res) => {
  try {
    const workspace =
      safeWorkspace(req.query.workspace)

    const pointerText =
      await readPrivateText(
        pointerPath(workspace)
      )

    if (!pointerText) {
      return res.status(200).json({
        ok: true,
        exists: false,
        workspace
      })
    }

    const pointer =
      JSON.parse(pointerText)

    const slot =
      safeSlot(pointer.activeSlot)

    const manifestText =
      await readPrivateText(
        manifestPath(
          workspace,
          slot
        )
      )

    if (!manifestText) {
      return res.status(200).json({
        ok: true,
        exists: false,
        workspace
      })
    }

    const manifest =
      JSON.parse(manifestText)

    return res.status(200).json({
      ok: true,
      exists: true,
      ...manifest
    })
  } catch (error: any) {
    return res.status(500).json({
      error: {
        message:
          error?.message ||
          String(error)
      }
    })
  }
})

app.get('/api/sync/chunk', async (req, res) => {
  try {
    const workspace =
      safeWorkspace(req.query.workspace)

    const slot =
      safeSlot(req.query.slot)

    const index =
      Math.max(
        0,
        Math.floor(
          Number(req.query.index) || 0
        )
      )

    const result =
      await get(
        chunkPath(
          workspace,
          slot,
          index
        ),
        {
          access: 'private',
          useCache: false
        }
      )

    if (
      !result ||
      result.statusCode !== 200 ||
      !result.stream
    ) {
      return res.status(404).json({
        error: {
          message:
            'cloud chunk not found'
        }
      })
    }

    const buffer =
      Buffer.from(
        await new Response(
          result.stream
        ).arrayBuffer()
      )

    res.setHeader(
      'Content-Type',
      'application/octet-stream'
    )

    res.setHeader(
      'Content-Length',
      String(buffer.length)
    )

    return res.status(200).send(buffer)
  } catch (error: any) {
    return res.status(500).json({
      error: {
        message:
          error?.message ||
          String(error)
      }
    })
  }
})

export default app
