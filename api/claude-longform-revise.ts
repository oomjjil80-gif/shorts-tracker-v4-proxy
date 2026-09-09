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

function textFromClaude(data: any) {
  const blocks = Array.isArray(data?.content) ? data.content : []
  return blocks
    .filter((block: any) => block?.type === 'text')
    .map((block: any) => String(block?.text || ''))
    .join('\n')
    .trim()
}

function extractJson(text: string) {
  const cleaned = String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  try {
    return JSON.parse(cleaned)
  } catch {}

  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1))
  }

  throw new Error('No parseable JSON object found')
}

const LONGFORM_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    hook: { type: 'string' },
    targetMinutes: { type: 'integer' },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          chapterNo: { type: 'integer' },
          title: { type: 'string' },
          purpose: { type: 'string' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                speaker: { type: 'string' },
                text: { type: 'string' },
                visualHint: { type: 'string' },
                factStatus: {
                  type: 'string',
                  enum: ['verified', 'interpretation', 'verify_before_publish']
                }
              },
              required: ['speaker', 'text', 'visualHint', 'factStatus'],
              additionalProperties: false
            }
          }
        },
        required: ['chapterNo', 'title', 'purpose', 'segments'],
        additionalProperties: false
      }
    },
    ending: {
      type: 'object',
      properties: {
        speaker: { type: 'string' },
        text: { type: 'string' }
      },
      required: ['speaker', 'text'],
      additionalProperties: false
    },
    shortsSpinOff: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } }
  },
  required: ['title', 'hook', 'targetMinutes', 'chapters', 'ending', 'shortsSpinOff', 'warnings'],
  additionalProperties: false
} as const

function buildSystemPrompt() {
  return [
    '당신은 Content Production Tracker의 경제·생활 롱폼 대본 수정 작가다.',
    '기본은 GPT QC가 지적한 필수 문제만 정확하게 고친다. 단, rewriteMode가 켜진 반복 실패 구간은 기존 문장을 보존하려 하지 말고 해당 문제 구간을 통째로 새로 쓴다.',
    '',
    '[수정 원칙]',
    '- verifiedFacts를 사실 기준으로 사용한다.',
    '- claimsToVerify는 확인 전까지 확정 사실처럼 단정하지 않는다.',
    '- sources와 입력 자료가 뒷받침하지 않는 새 사실·숫자·시행일·예외조건을 추가하지 않는다.',
    '- GPT revisionInstructions와 required 이슈를 우선 해결한다.',
    '- warning은 문맥상 필요할 때만 다듬고 좋은 문장은 이유 없이 전면 재작성하지 않는다.',
    '- rewriteMode=true이면 반복된 required/blocker와 연결된 segment/챕터만 폐기 후 재작성한다. 검증된 Fact Pack 밖의 사실을 새로 만들지 않는다.',
    '- 재작성 대상 밖의 좋은 구간, 제목의 핵심 질문, BM Reference와 Story Map의 큰 흐름은 유지한다.',
    '- 원래 제목, 훅, 챕터 수, 챕터 흐름은 가능한 한 유지한다.',
    '- economy_benchmark에서는 그루, 민재 등 과거 경제그루터기 캐릭터를 유지하지 않는다. 기존 초안에 섞여 있으면 대화 의존성을 제거하고 중립 내레이션으로 정리한다.',
    '- 경제·생활 설명형 특성상 원인 → 생활 연결 → 사람마다 결과가 다른 이유 → 변수/대응 시나리오 → 열린 결말 흐름을 유지한다.',
    '- 공포·과장·정치적 선동을 피하고 자연스러운 한국어 구어체와 TTS 친화 문장으로 쓴다.',
    '- 수정 후에도 근거가 부족한 내용은 삭제·완화하거나 verify_before_publish로 남긴다.',
    '',
    '[출력 규칙]',
    '- 반드시 원래 Claude Longform Draft와 동일한 JSON 구조만 출력한다.',
    '- Markdown 코드블록, 설명문, 수정 요약은 출력하지 않는다.'
  ].join('\n')
}

function buildUserPrompt(input: any) {
  const handoff = input?.handoff || {}
  const draft = input?.draft || {}
  const qc = input?.qc || {}
  const requiredIssues = (Array.isArray(qc?.issues) ? qc.issues : [])
    .filter((x: any) => ['blocker', 'required'].includes(String(x?.severity || '').toLowerCase()))

  return [
    '[소재 메타데이터]',
    JSON.stringify({
      title: handoff.title || '',
      summary: handoff.summary || '',
      whyNow: handoff.whyNow || '',
      viewerValue: handoff.viewerValue || '',
      channelKey: handoff.channelKey || '',
      contentFormat: handoff.contentFormat || ''
    }, null, 2),
    '',
    '[verifiedFacts]',
    JSON.stringify(Array.isArray(handoff.verifiedFacts) ? handoff.verifiedFacts : [], null, 2),
    '',
    '[claimsToVerify]',
    JSON.stringify(Array.isArray(handoff.claimsToVerify) ? handoff.claimsToVerify : [], null, 2),
    '',
    '[sources]',
    JSON.stringify(Array.isArray(handoff.sources) ? handoff.sources : [], null, 2),
    '',
    '[반복 QC 재작성 모드]',
    JSON.stringify({ rewriteMode: Boolean(input?.rewriteMode), repeatedIssueKeys: Array.isArray(input?.repeatedIssueKeys) ? input.repeatedIssueKeys : [] }, null, 2),
    '',
    '[GPT QC 필수 수정 지시]',
    JSON.stringify(Array.isArray(qc.revisionInstructions) ? qc.revisionInstructions : [], null, 2),
    '',
    '[GPT QC blocker/required 이슈]',
    JSON.stringify(requiredIssues, null, 2),
    '',
    '[원본 Claude Longform Draft]',
    JSON.stringify(draft, null, 2),
    '',
    input?.rewriteMode
      ? '같은 QC 문제가 3회 이상 반복됐다. 반복 문제와 연결된 구간은 기존 문장을 살리려 하지 말고 삭제 후 verifiedFacts·claimsToVerify·sources와 현재 GPT 필수 수정지시만으로 새로 작성하라. 나머지 좋은 구간과 큰 구조는 유지하고 동일 JSON 구조만 반환하라.'
      : '위 자료만 사용해 정확히 1회 수정본을 작성하라. 새로운 외부 사실을 보충하지 말고, 필요한 부분만 수정한 뒤 동일 JSON 구조만 반환하라.'
  ].join('\n')
}

export default async function handler(req: Request, res: Response) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const apiKey = process.env.ANTHROPIC_API_KEY
  const model = process.env.ANTHROPIC_STORY_MODEL || 'claude-sonnet-5'

  if (req.method === 'GET') {
    return res.status(apiKey ? 200 : 503).json({
      ok: Boolean(apiKey),
      provider: 'Anthropic',
      model,
      keyConfigured: Boolean(apiKey),
      task: 'longform_script_revision_once'
    })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'ANTHROPIC_API_KEY is not configured' })
  }

  const input = req.body?.input || {}
  if (!input?.draft || typeof input.draft !== 'object') {
    return res.status(400).json({ ok: false, error: 'Claude longform draft is required' })
  }
  if (!input?.qc || typeof input.qc !== 'object') {
    return res.status(400).json({ ok: false, error: 'GPT QC result is required' })
  }
  if (input.qc.status !== 'revision_required') {
    return res.status(409).json({ ok: false, error: `Revision is not allowed for QC status: ${String(input.qc.status || 'unknown')}` })
  }

  try {
    const payload = {
      model,
      max_tokens: 16000,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: buildUserPrompt(input) }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: LONGFORM_DRAFT_SCHEMA
        }
      }
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    const raw = await response.text()
    let data: any = {}
    try { data = raw ? JSON.parse(raw) : {} } catch {}

    if (!response.ok) {
      console.error('Anthropic revision request failed', response.status, raw.slice(0, 2000))
      return res.status(response.status).json({
        ok: false,
        error: data?.error?.message || raw || 'Anthropic API revision request failed'
      })
    }

    const text = textFromClaude(data)
    if (data?.stop_reason === 'max_tokens') {
      console.error('Claude revision output truncated at max_tokens')
      return res.status(502).json({ ok: false, error: 'Claude revision output was truncated before completion' })
    }
    if (!text) {
      return res.status(502).json({ ok: false, error: 'Claude revision response had no text output' })
    }

    let draft: any
    try {
      draft = extractJson(text)
    } catch {
      console.error('Claude revision returned invalid JSON', text.slice(0, 2000))
      return res.status(502).json({ ok: false, error: 'Claude revision returned invalid JSON', rawText: text })
    }

    return res.status(200).json({
      ok: true,
      provider: 'Anthropic',
      model: data?.model || model,
      draft,
      usage: data?.usage || null,
      revisionCount: 1,
      rewriteMode: Boolean(input?.rewriteMode)
    })
  } catch (error: any) {
    console.error('Claude revision handler failed', error)
    return res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
}
