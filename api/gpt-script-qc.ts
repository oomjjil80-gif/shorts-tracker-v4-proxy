import type { Request, Response } from 'express'

function setCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || '')
  const allowed =
    /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin) ||
    /^https:\/\/tracker\.vercel\.app$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker\.vercel\.app$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker-[a-z0-9-]+\.vercel\.app$/i.test(origin)

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
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

const QC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'summary',
    'scores',
    'issues',
    'verifiedFactCoverage',
    'claimsToVerifyHandling',
    'revisionInstructions',
    'finalDecision'
  ],
  properties: {
    status: {
      type: 'string',
      enum: ['pass', 'revision_required', 'blocked']
    },
    summary: { type: 'string' },
    scores: {
      type: 'object',
      additionalProperties: false,
      required: ['factualGrounding', 'channelFit', 'structure', 'ttsNaturalness'],
      properties: {
        factualGrounding: { type: 'integer', minimum: 0, maximum: 100 },
        channelFit: { type: 'integer', minimum: 0, maximum: 100 },
        structure: { type: 'integer', minimum: 0, maximum: 100 },
        ttsNaturalness: { type: 'integer', minimum: 0, maximum: 100 }
      }
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'location', 'claim', 'evidence', 'problem', 'recommendation'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'required', 'warning'] },
          category: {
            type: 'string',
            enum: [
              'fact', 'number', 'source', 'verified_fact', 'claim_to_verify',
              'logic', 'tone', 'repetition', 'writing_style', 'hook',
              'chapter_flow', 'open_ending', 'visualization', 'tts'
            ]
          },
          location: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          problem: { type: 'string' },
          recommendation: { type: 'string' }
        }
      }
    },
    verifiedFactCoverage: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fact', 'result', 'note'],
        properties: {
          fact: { type: 'string' },
          result: { type: 'string', enum: ['supported', 'not_used', 'distorted'] },
          note: { type: 'string' }
        }
      }
    },
    claimsToVerifyHandling: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'result', 'note'],
        properties: {
          claim: { type: 'string' },
          result: { type: 'string', enum: ['safe', 'overstated', 'not_used'] },
          note: { type: 'string' }
        }
      }
    },
    revisionInstructions: {
      type: 'array',
      items: { type: 'string' }
    },
    finalDecision: { type: 'string' }
  }
}

function systemPrompt() {
  return [
    '당신은 Content Production Tracker의 독립적인 최종 대본 QC 편집자다.',
    '작성자는 Claude이고, 당신은 작성자가 아니다. 좋은 문장을 이유 없이 다시 쓰지 말고 검수한다.',
    '',
    '[가장 중요한 사실성 원칙]',
    '- verifiedFacts는 현재 입력 안에서 확인된 사실의 기준이다.',
    '- claimsToVerify는 미확정 주장이다. 대본에서 확정 사실처럼 단정되면 반드시 문제로 잡는다.',
    '- sources는 근거 목록이다. 입력 자료가 뒷받침하지 않는 사실을 스스로 만들어 채우지 않는다.',
    '- 입력만으로 확인할 수 없는 외부 사실은 "확인됨"이라고 판정하지 않는다.',
    '- 숫자, 비율, 시행시점, 적용대상, 예외조건은 특히 엄격하게 본다.',
    '',
    '[경제그루터기 채널 규칙]',
    '- 복잡한 경제 현안을 생활 문제로 쉽게 연결한다.',
    '- 왜 생겼는지 → 내 삶과 어떻게 연결되는지 → 사람마다 결과가 왜 다른지 → 어떤 변수가 있는지 흐름을 선호한다.',
    '- 정치적 주장보다 생활경제 이해를 우선한다.',
    '- 공포·선동·과도한 단정을 피하고 가능한 시각을 여러 개 제시할 수 있다.',
    '- 정답을 강요하지 않는 열린 결말을 허용한다.',
    '- 문어체보다 실제 말하기 좋은 자연스러운 한국어를 쓴다.',
    '- 같은 설명과 AI식 관용구를 반복하지 않는다.',
    '- 훅은 시청자의 돈·상황·불편·차이를 빠르게 이해시키되 사실을 과장하지 않는다.',
    '- 나중에 장면/CUT으로 나누기 쉽도록 시각화 가능한 설명인지도 본다.',
    '',
    '[판정]',
    '- pass: 게시 전 추가 수정이 필요하지 않은 수준. blocker/required 이슈가 없어야 한다.',
    '- revision_required: Claude가 수정하면 해결 가능한 required 이슈가 하나 이상 있다.',
    '- blocked: 핵심 사실 근거 부족, 상충, 위험한 단정 등 현재 입력만으로 안전하게 고칠 수 없는 blocker가 있다.',
    '- warning만 있다면 pass가 가능하다.',
    '',
    'revisionInstructions는 Claude에게 그대로 전달할 수 있게 구체적으로 쓴다.',
    '반드시 지정된 JSON schema로만 응답한다.'
  ].join('\n')
}

function userPrompt(input: any) {
  return [
    '[소재 메타데이터]',
    JSON.stringify({
      title: input?.handoff?.title || '',
      summary: input?.handoff?.summary || '',
      whyNow: input?.handoff?.whyNow || '',
      viewerValue: input?.handoff?.viewerValue || '',
      channelKey: input?.handoff?.channelKey || '',
      contentFormat: input?.handoff?.contentFormat || ''
    }, null, 2),
    '',
    '[verifiedFacts]',
    JSON.stringify(Array.isArray(input?.handoff?.verifiedFacts) ? input.handoff.verifiedFacts : [], null, 2),
    '',
    '[claimsToVerify]',
    JSON.stringify(Array.isArray(input?.handoff?.claimsToVerify) ? input.handoff.claimsToVerify : [], null, 2),
    '',
    '[sources]',
    JSON.stringify(Array.isArray(input?.handoff?.sources) ? input.handoff.sources : [], null, 2),
    '',
    '[Claude Longform Draft]',
    JSON.stringify(input?.draft || {}, null, 2),
    '',
    '위 자료만을 근거로 대본 전체를 검수하라. 근거가 없는 내용을 외부 지식으로 확정하지 말라.'
  ].join('\n')
}

export default async function handler(req: Request, res: Response) {
  setCors(req, res)

  if (req.method === 'OPTIONS') return res.status(204).end()

  const apiKey = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_QC_MODEL || 'gpt-5.6-terra'

  if (req.method === 'GET') {
    return res.status(apiKey ? 200 : 503).json({
      ok: Boolean(apiKey),
      provider: 'OpenAI',
      model,
      keyConfigured: Boolean(apiKey),
      task: 'longform_script_qc'
    })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'OPENAI_API_KEY is not configured' })
  }

  const input = req.body?.input || {}
  const test = Boolean(req.body?.test)

  if (!test && (!input?.draft || typeof input.draft !== 'object')) {
    return res.status(400).json({ ok: false, error: 'Claude longform draft is required' })
  }

  try {
    const payload: any = test
      ? {
          model,
          store: false,
          input: 'Content Production Tracker GPT QC 연결 테스트입니다. 한국어로 "GPT QC API 연결 성공"이라고만 답하세요.',
          max_output_tokens: 64
        }
      : {
          model,
          store: false,
          reasoning: { effort: 'medium' },
          instructions: systemPrompt(),
          input: userPrompt(input),
          max_output_tokens: 6500,
          text: {
            format: {
              type: 'json_schema',
              name: 'longform_script_qc',
              strict: true,
              schema: QC_SCHEMA
            }
          }
        }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    const raw = await response.text()
    let data: any = {}
    try { data = raw ? JSON.parse(raw) : {} } catch {}

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: data?.error?.message || raw || 'OpenAI API request failed'
      })
    }

    const text = extractText(data)
    if (!text) {
      return res.status(502).json({ ok: false, error: 'OpenAI response had no text output' })
    }

    if (test) {
      return res.status(200).json({
        ok: true,
        provider: 'OpenAI',
        model: data?.model || model,
        text,
        usage: data?.usage || null
      })
    }

    let qc: any
    try {
      qc = JSON.parse(text)
    } catch {
      return res.status(502).json({ ok: false, error: 'OpenAI returned invalid QC JSON', rawText: text })
    }

    return res.status(200).json({
      ok: true,
      provider: 'OpenAI',
      model: data?.model || model,
      qc,
      usage: data?.usage || null
    })
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
}
