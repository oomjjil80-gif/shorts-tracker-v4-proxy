import type { Request, Response } from 'express'

function setCors(_req: Request, res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
  res.setHeader('Cache-Control', 'no-store')
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

  try { return JSON.parse(cleaned) } catch {}

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
  required: ['title','hook','targetMinutes','chapters','ending','shortsSpinOff','warnings'],
  additionalProperties: false
} as const

function buildSystemPrompt() {
  return [
    '당신은 유튜브 콘텐츠 제작 시스템의 전문 대본 작가다.',
    '현재 채널은 한국어 경제·생활경제 채널 경제그루터기다.',
    '',
    '[채널 핵심]',
    '- 어려운 경제 제도를 생활 속 문제로 번역한다.',
    '- 단순 뉴스 요약이 아니라 원인 → 내 삶과 연결 → 사람마다 결과가 다른 이유 → 대응 시나리오 순으로 설명한다.',
    '- 확정 사실과 해석을 구분한다.',
    '- 제공된 verifiedFacts를 사실의 기준으로 사용한다.',
    '- claimsToVerify에 있는 내용은 확정 사실처럼 단정하지 않는다.',
    '- 투자·대출·정책 결과를 개인에게 보장되는 결과처럼 표현하지 않는다.',
    '',
    '[캐릭터]',
    '- 그루: 복잡한 경제를 차분하고 쉽게 풀어주는 안내자.',
    '- 민재: 시청자가 실제로 궁금해할 질문을 대신 묻는 인물.',
    '- 민재의 질문은 억지 대화가 아니라 설명 전환점에서만 사용한다.',
    '',
    '[대본 원칙]',
    '- 문어체보다 실제 말하기 좋은 자연스러운 한국어를 사용한다.',
    '- 같은 내용을 반복하지 않는다.',
    '- 숫자는 의미와 함께 설명한다.',
    '- 지나친 공포·과장·선동을 피한다.',
    '- 결론을 하나로 강요하지 않고 시청자가 자신의 조건을 확인하도록 끝낸다.',
    '- 롱폼에서도 30~60초마다 새로운 질문·사례·숫자·비교가 등장하도록 구성한다.',
    '',
    '응답은 제공된 JSON Schema를 정확히 따라야 한다.'
  ].join('\n')
}

function buildUserPrompt(input: any) {
  const targetMinutes = Math.max(5, Math.min(30, Number(input?.targetMinutes || 15)))
  const chapterCount = Math.max(3, Math.min(10, Number(input?.chapterCount || 6)))

  return `
다음 소재로 약 ${targetMinutes}분 분량의 경제그루터기 롱폼 대본을 작성하라.

[소재 제목]
${String(input?.title || '')}

[소재 요약]
${String(input?.summary || '')}

[왜 지금 중요한가]
${String(input?.whyNow || '')}

[시청자 가치]
${String(input?.viewerValue || '')}

[확인된 사실]
${JSON.stringify(input?.verifiedFacts || [], null, 2)}

[추가 검증이 필요한 주장]
${JSON.stringify(input?.claimsToVerify || [], null, 2)}

[출처]
${JSON.stringify(input?.sources || [], null, 2)}

[훅 후보]
${JSON.stringify(input?.hookCandidates || [], null, 2)}

[목표]
- 약 ${targetMinutes}분
- ${chapterCount}개 챕터
- 그루 중심 설명
- 민재는 실제 시청자 질문이 필요한 곳에만 등장
- 각 챕터가 다음 챕터를 궁금하게 만드는 연결 구조
- 나중에 장면계획/CUT 자동분해가 가능하도록 chapterNo와 segment를 명확하게 구분
- chapters 배열은 정확히 ${chapterCount}개 챕터로 구성
- 각 segment의 factStatus는 verified, interpretation, verify_before_publish 중 하나만 사용
`.trim()
}

export default async function handler(req: Request, res: Response) {
  setCors(req, res)

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'ANTHROPIC_API_KEY is not configured' })
  }

  const input = req.body?.input || {}
  const test = Boolean(req.body?.test)

  try {
    const payload: any = test
      ? {
          model: process.env.ANTHROPIC_STORY_MODEL || 'claude-sonnet-5',
          max_tokens: 256,
          system: '짧고 정확하게 응답하라.',
          messages: [{
            role: 'user',
            content: 'Content Production Tracker Claude API 연결 테스트입니다. 한국어로 "Claude 대본 API 연결 성공"이라고만 답하세요.'
          }]
        }
      : {
          model: process.env.ANTHROPIC_STORY_MODEL || 'claude-sonnet-5',
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
      console.error('Anthropic request failed', response.status, raw.slice(0, 2000))
      return res.status(response.status).json({
        ok: false,
        error: data?.error?.message || raw || 'Anthropic API request failed'
      })
    }

    const text = textFromClaude(data)
    if (!text) return res.status(502).json({ ok: false, error: 'Claude response had no text output' })

    if (test) {
      return res.status(200).json({
        ok: true,
        provider: 'Anthropic',
        model: data?.model || payload.model,
        text,
        usage: data?.usage || null
      })
    }

    if (data?.stop_reason === 'max_tokens') {
      return res.status(502).json({ ok: false, error: 'Claude output was truncated before completion' })
    }

    let draft: any
    try {
      draft = extractJson(text)
    } catch {
      return res.status(502).json({
        ok: false,
        error: 'Claude returned invalid JSON',
        rawText: text
      })
    }

    return res.status(200).json({
      ok: true,
      provider: 'Anthropic',
      model: data?.model || payload.model,
      draft,
      usage: data?.usage || null
    })
  } catch (error: any) {
    console.error('Claude story handler failed', error)
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    })
  }
}
