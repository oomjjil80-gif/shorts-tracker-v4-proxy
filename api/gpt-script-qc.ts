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

type ContaminationSignal = {
  kind: string
  sample: string
}

function detectContamination(draft: any): ContaminationSignal[] {
  const text = JSON.stringify(draft || {})
  const checks: Array<[string, RegExp]> = [
    ['test_marker', /END_MARK|REMOVE_ME|JUST_KIDDING|KEEP_ME|TEST_MARKER/i],
    ['role_leak', /['"]?role['"]?\s*:\s*['"](?:assistant|system|user)['"]/i],
    ['message_object_leak', /['"]?content['"]?\s*:\s*['"]/i],
    ['prompt_leak', /\b(system prompt|developer message|assistant message|prompt injection)\b/i],
    ['code_fence_leak', /```(?:json|javascript|typescript|python)?/i],
    ['json_fragment_leak', /\{\s*['"](?:role|content|messages)['"]\s*:/i],
    ['abnormal_jamo_repeat', /[ㄱ-ㅎㅏ-ㅣ]{8,}/],
    ['abnormal_symbol_repeat', /([^\p{L}\p{N}\s])\1{7,}/u],
  ]

  const signals: ContaminationSignal[] = []
  for (const [kind, re] of checks) {
    const m = text.match(re)
    if (m) {
      const idx = m.index || 0
      signals.push({
        kind,
        sample: text.slice(Math.max(0, idx - 60), Math.min(text.length, idx + 160))
      })
    }
  }
  return signals
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
              'chapter_flow', 'open_ending', 'visualization', 'tts',
              'contamination', 'format_leak'
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
} as const

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
    '[대본 오염/형식 누출 검사 — 필수]',
    '- 최종 시청자용 대사에 시스템/assistant/user role, JSON 조각, 코드블록, 테스트 마커, 디버그 문자열이 섞이면 반드시 required 이슈로 잡는다.',
    '- END_MARK, REMOVE_ME, JUST_KIDDING, role/content/messages 같은 내부 형식 문자열은 정상 대본으로 인정하지 않는다.',
    '- 주제와 전혀 무관한 문장, 갑작스러운 타 채널/타 인물 대사, 비정상 자모·기호 반복도 contamination 또는 format_leak으로 잡는다.',
    '- contaminationSignals가 하나라도 있으면 status=pass로 판정하지 않는다.',
    '- 단순히 해당 문자열만 삭제하라고 하지 말고 오염된 segment/ending 전체를 문맥에 맞게 다시 작성하도록 지시한다.',
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

function userPrompt(input: any, contaminationSignals: ContaminationSignal[]) {
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
    '[deterministic contaminationSignals]',
    JSON.stringify(contaminationSignals, null, 2),
    '',
    '[Claude Longform Draft]',
    JSON.stringify(input?.draft || {}, null, 2),
    '',
    '위 자료만을 근거로 대본 전체를 검수하라. 근거가 없는 내용을 외부 지식으로 확정하지 말라.',
    'contaminationSignals가 있으면 반드시 issues와 revisionInstructions에 반영하고 pass로 판정하지 말라.'
  ].join('\n')
}

function enforceContamination(qc: any, signals: ContaminationSignal[]) {
  if (!signals.length || !qc || typeof qc !== 'object') return qc

  const issues = Array.isArray(qc.issues) ? qc.issues : []
  const already = issues.some((x: any) => ['contamination', 'format_leak'].includes(String(x?.category || '')))

  if (!already) {
    issues.unshift({
      severity: 'required',
      category: 'contamination',
      location: 'Claude Longform Draft',
      claim: '대본 내부에 시청자용 대사와 무관한 내부 형식/테스트 문자열이 포함됨',
      evidence: signals.map((s) => `${s.kind}: ${s.sample}`).join(' | ').slice(0, 1600),
      problem: '프롬프트·메시지 객체·테스트 마커·비정상 반복 문자열이 최종 대본에 노출되면 그대로 게시하거나 CUT 변환할 수 없습니다.',
      recommendation: '오염된 segment 또는 ending을 삭제 후 앞뒤 문맥에 맞는 정상 한국어 대사로 다시 작성하고 내부 role/content/JSON/테스트 문자열을 모두 제거합니다.'
    })
  }
  qc.issues = issues

  const revisions = Array.isArray(qc.revisionInstructions) ? qc.revisionInstructions : []
  const instruction = '대본 전체에서 내부 role/content/JSON 조각, 테스트 마커, 디버그 문자열, 주제와 무관한 문장, 비정상 반복문자를 제거하고 오염된 구간은 앞뒤 문맥에 맞는 정상 대사로 다시 작성한다.'
  if (!revisions.some((x: any) => String(x).includes('내부 role/content/JSON'))) {
    revisions.unshift(instruction)
  }
  qc.revisionInstructions = revisions

  if (qc.status === 'pass') qc.status = 'revision_required'
  qc.summary = `대본 오염/형식 누출이 감지되어 수정이 필요합니다. ${String(qc.summary || '')}`.trim()
  return qc
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
      task: 'longform_script_qc',
      contaminationGuard: 'v1'
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
    const contaminationSignals = test ? [] : detectContamination(input?.draft)

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
          input: userPrompt(input, contaminationSignals),
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
        usage: data?.usage || null,
        contaminationGuard: 'v1'
      })
    }

    let qc: any
    try {
      qc = JSON.parse(text)
    } catch {
      return res.status(502).json({ ok: false, error: 'OpenAI returned invalid QC JSON', rawText: text })
    }

    qc = enforceContamination(qc, contaminationSignals)

    return res.status(200).json({
      ok: true,
      provider: 'OpenAI',
      model: data?.model || model,
      qc,
      usage: data?.usage || null,
      contaminationSignals,
      contaminationGuard: 'v1'
    })
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
}
