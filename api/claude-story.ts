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
    '당신은 유튜브 콘텐츠 제작 시스템의 전문 롱폼 Story Writer다.',
    '이번 작업의 목표는 그럴듯한 초안을 채우는 것이 아니라 실제 영상 제작에 바로 넘길 수 있는 완성도 높은 원고를 만드는 것이다.',
    '채널 이름보다 콘텐츠의 실제 주제와 longformProfile을 우선한다.',
    'economy_benchmark 프로필에서는 검증된 성공작의 논증 순서와 시청 유지 구조를 최대한 보존하되 문장·고유 표현·원본 영상 자체를 복제하지 않는다.',
    '경제, 주거, 직장, 세대, 가족, 생활의 경계 소재를 억지로 한 카테고리에 가두지 않는다.',
    '',
    '[채널 핵심]',
    '- 어려운 경제 제도를 생활 속 문제로 번역한다.',
    '- 단순 뉴스 요약이 아니라 원인 → 내 삶과 연결 → 사람마다 결과가 다른 이유 → 대응 시나리오 순으로 설명한다.',
    '- 확정 사실과 해석을 구분한다.',
    '- 제공된 verifiedFacts를 사실의 기준으로 사용한다.',
    '- claimsToVerify에 있는 내용은 확정 사실처럼 단정하지 않는다.',
    '- 투자·대출·정책 결과를 개인에게 보장되는 결과처럼 표현하지 않는다.',
    '',
    '[화자 규칙]',
    '- economy_benchmark 프로필은 기본적으로 단일 중립 내레이션으로 작성한다.',
    '- 그루, 민재 등 과거 경제그루터기 캐릭터를 자동 등장시키지 않는다.',
    '- 특정 캐릭터/진행자가 소재나 Master Brief에 명시적으로 지정된 경우에만 사용한다.',
    '',
    '[내용 밀도와 논리 구조 — 최우선]',
    '- 쓰기 전에 전체 질문과 챕터별 소질문의 인과 순서를 내부적으로 먼저 정리한 뒤 원고를 작성한다. 계획 과정은 출력하지 않는다.',
    '- 각 챕터는 하나의 명확한 질문에 답해야 하며, purpose에는 그 챕터가 전체 논증에서 왜 필요한지가 드러나야 한다.',
    '- 추상적인 상식, 분위기 설명, 비슷한 말을 바꿔 말하는 문장으로 분량을 채우지 않는다.',
    '- 중요한 주장에는 필요한 경우 왜 그런지, 누구에게 해당하는지, 근거 또는 사례, 예외나 반론을 붙여 실제 이해가 진행되게 한다.',
    '- 각 segment는 이전 segment보다 새로운 정보·논리·사례·반론·관점 중 최소 하나를 전진시켜야 한다.',
    '- 같은 결론을 표현만 바꿔 반복하지 않는다. 앞 문단을 요약만 하며 이어가는 문단을 만들지 않는다.',
    '- 원인과 결과 사이의 중간 논리를 생략하지 않는다. 듣는 사람이 "그래서 왜?"라고 물을 지점을 먼저 메운다.',
    '- 서로 다른 해결책이나 항목을 제시할 때는 상위 주제와 순서를 분명히 잡아 첫째·둘째·셋째처럼 듣는 사람이 현재 위치를 알 수 있게 한다.',
    '- 각 챕터 말미에는 다음 챕터가 왜 이어지는지 자연스러운 논리 다리를 만든다. 뜬금없는 주제 전환을 금지한다.',
    '',
    '[TTS / CUT 제작 가능성]',
    '- 각 segment는 나중에 하나 이상의 CUT으로 안전하게 나눌 수 있는 완결된 의미 단위로 작성한다.',
    '- 문장의 핵심 의미를 다음 segment에 걸쳐 완성하지 않는다. segment 끝은 의미와 문장 모두 자연스럽게 닫힌다.',
    '- 하나의 segment에 서로 다른 핵심 주장 두 개를 억지로 넣지 않는다.',
    '- 한 주제를 여러 segment로 나눌 경우 각 segment의 역할이 명확해야 하며 다음 segment 시작에서 연결 대상을 알아들을 수 있게 한다.',
    '- TTS에서 호흡하기 어려운 과도한 장문을 피하고 말하기 좋은 문장 길이로 쪼갠다.',
    '',
    '[시각화 규칙]',
    '- visualHint는 narration을 다른 표현으로 반복하지 않는다.',
    '- visualHint에는 화면에서 실제로 무엇을 보여주면 그 segment의 의미가 전달되는지 구체적으로 적는다.',
    '- 이미지 하나로 정확히 설명하기 어려운 숫자·비교·추상 개념은 억지 상황극을 만들지 말고 비교 구도, 상징 오브젝트, 자료형 시각화 등 맞는 표현 방식을 제시한다.',
    '- 이미지가 narration과 다른 내용을 말하게 하지 않는다. 시각적으로 멋있어도 메시지와 연결되지 않으면 사용하지 않는다.',
    '- 제작 단계에서 앞뒤 문맥을 읽어 페이지 제목형 상단 키워드를 만들 수 있도록 각 segment의 상위 주제와 논리적 역할이 분명해야 한다.',
    '',
    '[대본 원칙]',
    '- 문어체보다 실제 말하기 좋은 자연스러운 한국어를 사용한다.',
    '- 숫자는 의미와 함께 설명한다.',
    '- 지나친 공포·과장·선동을 피한다.',
    '- 결론을 하나로 강요하지 않고 시청자가 자신의 조건을 확인하도록 끝낸다.',
    '- 롱폼에서는 약 60~120초마다 새 질문·반론·데이터·사례·관점 전환 중 하나가 등장해 다음 구간을 볼 이유가 생기게 한다.',
    '- BM Reference와 Story Map이 제공되면 그것을 자유창작보다 우선하는 설계도로 취급한다.',
    '- 성공작의 큰 질문 → 소주제 순서 → 반론 → 재해석 → 결론 리듬을 유지한다.',
    '',
    '[출력 전 자체 점검]',
    '- 각 챕터가 실제로 다른 질문에 답하는지 확인한다.',
    '- 반복 문단, 빈말, 결론 없는 사례를 제거한다.',
    '- segment 경계에서 의미가 다음 segment로 물리지 않는지 확인한다.',
    '- visualHint가 실제 narration 핵심을 보여주는지 확인한다.',
    '- 전체를 들었을 때 질문 → 원인 → 근거/사례 → 반론/예외 → 대응 또는 판단 기준이 끊기지 않는지 확인한다.',
    '',
    '응답은 제공된 JSON Schema를 정확히 따라야 한다.'
  ].join('\n')
}

function buildUserPrompt(input: any) {
  const targetMinutes = Math.max(5, Math.min(30, Number(input?.targetMinutes || 15)))
  const chapterCount = Math.max(3, Math.min(10, Number(input?.chapterCount || 6)))

  return `
다음 소재로 약 ${targetMinutes}분 분량의 경제·생활 설명형 롱폼 대본을 작성하라.

[Production Master Brief]
${JSON.stringify(input?.productionMasterBrief || {}, null, 2)}

[Claude Writer Brief]
${JSON.stringify(input?.providerBrief || {}, null, 2)}

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

[롱폼 프로필]
${String(input?.longformProfile || 'standard')}

[BM Reference]
${typeof input?.benchmarkReference === 'string' ? input.benchmarkReference : JSON.stringify(input?.benchmarkReference || '', null, 2)}

[Story Map — 가능한 한 순서와 기능을 유지]
${typeof input?.storyMap === 'string' ? input.storyMap : JSON.stringify(input?.storyMap || '', null, 2)}

[Primary Category / Secondary Tags]
${JSON.stringify({ primaryCategory: input?.primaryCategory || '', secondaryTags: input?.secondaryTags || [] }, null, 2)}

[목표]
- 약 ${targetMinutes}분
- ${chapterCount}개 챕터
- economy_benchmark 프로필이면 고정 캐릭터를 사용하지 말고 단일 중립 내레이션 중심 경제·생활 설명형으로 작성. speaker는 기본적으로 내레이션을 사용
- 원본 BM의 큰 질문과 소주제 기능을 유지하되 한국의 사실·사례·데이터로 치환
- 각 챕터가 하나의 소질문에 실질적인 답을 주고, 그 답이 다음 질문을 자연스럽게 열도록 구성
- 내용이 부족한데 길이만 맞추기 위한 반복·상식·추상론 금지
- 여러 방안이나 원인을 제시할 때 상위 주제와 첫째·둘째·셋째 등 논리적 순서를 명확히 구성
- 각 segment는 하나의 핵심 의미만 담당하고 완결된 문장/의미 단위로 끝내기
- segment의 핵심 의미가 다음 segment로 물려서 완성되는 구조 금지
- visualHint는 예쁜 그림 아이디어가 아니라 해당 narration을 실제로 이해시키는 화면 설계로 작성
- 이미지로 정확히 전달하기 어려운 내용은 비교·상징·데이터 시각화 등 적합한 표현을 제안하고 억지 장면을 만들지 않기
- 시청자 유지에 기여하지 않는 역사·배경 설명을 길게 선행하지 않음
- 나중에 장면계획/CUT 자동분해가 가능하도록 chapterNo와 segment를 명확하게 구분
- chapters 배열은 정확히 ${chapterCount}개 챕터로 구성
- 각 segment의 factStatus는 verified, interpretation, verify_before_publish 중 하나만 사용
`.trim()
}


function addUsage(a: any, b: any) {
  return {
    input_tokens: Number(a?.input_tokens || 0) + Number(b?.input_tokens || 0),
    output_tokens: Number(a?.output_tokens || 0) + Number(b?.output_tokens || 0),
  }
}

async function callClaudeStory(apiKey: string, payload: any) {
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
  return { response, raw, data }
}

function splitLongformInput(input: any, startChapter: number, batchCount: number, totalChapters: number, batchMinutes: number, priorDraft: any = null) {
  const storyMapLines = String(input?.storyMap || '')
    .split('\n')
    .map((x: string) => x.trim())
    .filter(Boolean)
  const selectedMap = storyMapLines.slice(startChapter - 1, startChapter - 1 + batchCount).join('\n')
  return {
    ...input,
    targetMinutes: batchMinutes,
    chapterCount: batchCount,
    storyMap: selectedMap || input?.storyMap || '',
    continuationContext: priorDraft ? {
      instruction: '앞 배치의 내용을 반복하지 말고 논리를 자연스럽게 이어간다.',
      priorTitle: priorDraft.title || '',
      priorHook: priorDraft.hook || '',
      priorChapters: priorDraft.chapters || []
    } : null,
    splitBatch: {
      totalChapters,
      startChapter,
      endChapter: startChapter + batchCount - 1
    }
  }
}

function mergeSplitDrafts(first: any, second: any, targetMinutes: number) {
  const firstChapters = Array.isArray(first?.chapters) ? first.chapters : []
  const secondChapters = Array.isArray(second?.chapters) ? second.chapters : []
  const chapters = [...firstChapters, ...secondChapters].map((chapter: any, index: number) => ({
    ...chapter,
    chapterNo: index + 1
  }))
  return {
    title: String(first?.title || second?.title || ''),
    hook: String(first?.hook || second?.hook || ''),
    targetMinutes,
    chapters,
    ending: second?.ending || first?.ending || { speaker: '내레이션', text: '' },
    shortsSpinOff: [...(Array.isArray(first?.shortsSpinOff) ? first.shortsSpinOff : []), ...(Array.isArray(second?.shortsSpinOff) ? second.shortsSpinOff : [])].slice(0, 12),
    warnings: [...(Array.isArray(first?.warnings) ? first.warnings : []), ...(Array.isArray(second?.warnings) ? second.warnings : [])]
  }
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
    const model = process.env.ANTHROPIC_STORY_MODEL || 'claude-sonnet-5'
    if (test) {
      const payload = {
        model,
        max_tokens: 256,
        system: '짧고 정확하게 응답하라.',
        messages: [{
          role: 'user',
          content: 'Content Production Tracker Claude API 연결 테스트입니다. 한국어로 "Claude 대본 API 연결 성공"이라고만 답하세요.'
        }]
      }
      const { response, raw, data } = await callClaudeStory(apiKey, payload)
      if (!response.ok) return res.status(response.status).json({ ok:false, error:data?.error?.message || raw || 'Anthropic API request failed' })
      const text = textFromClaude(data)
      if (!text) return res.status(502).json({ ok:false, error:'Claude response had no text output' })
      return res.status(200).json({ ok:true, provider:'Anthropic', model:data?.model || model, text, usage:data?.usage || null })
    }

    const targetMinutes = Math.max(5, Math.min(30, Number(input?.targetMinutes || 15)))
    const chapterCount = Math.max(3, Math.min(10, Number(input?.chapterCount || 6)))
    const useSplitGeneration = targetMinutes >= 18 || chapterCount >= 7

    if (useSplitGeneration) {
      const firstCount = Math.ceil(chapterCount / 2)
      const secondCount = chapterCount - firstCount
      const firstMinutes = Math.max(5, Math.round(targetMinutes * firstCount / chapterCount))
      const secondMinutes = Math.max(5, targetMinutes - firstMinutes)
      const makePayload = (batchInput: any) => ({
        model,
        max_tokens: 12000,
        system: buildSystemPrompt(),
        messages: [{ role:'user', content: buildUserPrompt(batchInput) + '\n\n[분할 생성 규칙]\n이 요청은 전체 롱폼의 일부다. splitBatch의 챕터 범위만 작성하고, chapters 배열 개수는 chapterCount와 정확히 일치시킨다. continuationContext가 있으면 앞 내용을 반복하지 않고 이어간다.' }],
        output_config: { format: { type:'json_schema', schema:LONGFORM_DRAFT_SCHEMA } }
      })

      const firstInput = splitLongformInput(input, 1, firstCount, chapterCount, firstMinutes)
      const firstCall = await callClaudeStory(apiKey, makePayload(firstInput))
      if (!firstCall.response.ok) return res.status(firstCall.response.status).json({ ok:false, error:firstCall.data?.error?.message || firstCall.raw || 'Anthropic API request failed' })
      if (firstCall.data?.stop_reason === 'max_tokens') return res.status(502).json({ ok:false, error:'Claude first half was truncated before completion' })
      const firstText = textFromClaude(firstCall.data)
      let firstDraft:any
      try { firstDraft = extractJson(firstText) } catch { return res.status(502).json({ ok:false, error:'Claude returned invalid JSON for first half', rawText:firstText }) }

      const secondInput = splitLongformInput(input, firstCount + 1, secondCount, chapterCount, secondMinutes, firstDraft)
      const secondCall = await callClaudeStory(apiKey, makePayload(secondInput))
      if (!secondCall.response.ok) return res.status(secondCall.response.status).json({ ok:false, error:secondCall.data?.error?.message || secondCall.raw || 'Anthropic API request failed' })
      if (secondCall.data?.stop_reason === 'max_tokens') return res.status(502).json({ ok:false, error:'Claude second half was truncated before completion' })
      const secondText = textFromClaude(secondCall.data)
      let secondDraft:any
      try { secondDraft = extractJson(secondText) } catch { return res.status(502).json({ ok:false, error:'Claude returned invalid JSON for second half', rawText:secondText }) }

      const draft = mergeSplitDrafts(firstDraft, secondDraft, targetMinutes)
      return res.status(200).json({
        ok:true,
        provider:'Anthropic',
        model:secondCall.data?.model || firstCall.data?.model || model,
        draft,
        usage:addUsage(firstCall.data?.usage, secondCall.data?.usage),
        generationMode:'split_2_batches'
      })
    }

    const payload = {
      model,
      max_tokens: 16000,
      system: buildSystemPrompt(),
      messages: [{ role:'user', content:buildUserPrompt(input) }],
      output_config:{ format:{ type:'json_schema', schema:LONGFORM_DRAFT_SCHEMA } }
    }
    const { response, raw, data } = await callClaudeStory(apiKey, payload)
    if (!response.ok) {
      console.error('Anthropic request failed', response.status, raw.slice(0, 2000))
      return res.status(response.status).json({ ok:false, error:data?.error?.message || raw || 'Anthropic API request failed' })
    }
    const text = textFromClaude(data)
    if (!text) return res.status(502).json({ ok:false, error:'Claude response had no text output' })
    if (data?.stop_reason === 'max_tokens') return res.status(502).json({ ok:false, error:'Claude output was truncated before completion' })
    let draft:any
    try { draft = extractJson(text) } catch { return res.status(502).json({ ok:false, error:'Claude returned invalid JSON', rawText:text }) }
    return res.status(200).json({ ok:true, provider:'Anthropic', model:data?.model || model, draft, usage:data?.usage || null, generationMode:'single' })
  } catch (error: any) {
    console.error('Claude story handler failed', error)
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    })
  }
}
