import type { Request, Response } from 'express'

function setCors(_req: Request, res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
  res.setHeader('Cache-Control', 'no-store')
}

const LONGFORM_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title','hook','targetMinutes','chapters','ending','shortsSpinOff','warnings'],
  properties: {
    title: { type: 'string' },
    hook: { type: 'string' },
    targetMinutes: { type: 'integer' },
    chapters: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chapterNo','title','purpose','segments'],
        properties: {
          chapterNo: { type: 'integer' },
          title: { type: 'string' },
          purpose: { type: 'string' },
          segments: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['speaker','text','visualHint','factStatus'],
              properties: {
                speaker: { type: 'string' },
                text: { type: 'string' },
                visualHint: { type: 'string' },
                factStatus: { type: 'string', enum: ['verified','interpretation','verify_before_publish'] }
              }
            }
          }
        }
      }
    },
    ending: {
      type: 'object',
      additionalProperties: false,
      required: ['speaker','text'],
      properties: { speaker:{type:'string'}, text:{type:'string'} }
    },
    shortsSpinOff: { type:'array', items:{type:'string'} },
    warnings: { type:'array', items:{type:'string'} }
  }
} as const

function extractText(data: any) {
  if (typeof data?.output_text === 'string') return data.output_text.trim()
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') return content.text.trim()
    }
  }
  return ''
}

function chapterPrompt(input:any, chapterNo:number, totalChapters:number, previousChapter:any) {
  const storyMapLines = String(input?.storyMap || '').split('\n').map((x:string)=>x.trim()).filter(Boolean)
  const currentMap = storyMapLines[chapterNo - 1] || ''
  const previousTail = previousChapter ? {
    title: previousChapter.title || '',
    purpose: previousChapter.purpose || '',
    tail: (Array.isArray(previousChapter.segments) ? previousChapter.segments : []).slice(-2).map((s:any)=>String(s?.text || '')).filter(Boolean)
  } : null
  const targetMinutes = Math.max(5, Math.min(30, Number(input?.targetMinutes || 15)))
  const chapterMinutes = Math.max(2, targetMinutes / Math.max(1, totalChapters))
  return `
당신은 경제·생활 설명형 유튜브 롱폼 전문 작가다.
전체 ${totalChapters}개 챕터 중 ${chapterNo}번 챕터 하나만 작성한다.

[소재]
제목: ${String(input?.title || '')}
요약: ${String(input?.summary || '')}
왜 지금 중요한가: ${String(input?.whyNow || '')}
시청자 가치: ${String(input?.viewerValue || '')}
프로필: ${String(input?.longformProfile || 'standard')}

[이번 챕터 Story Map]
${currentMap || '전체 논리 흐름의 해당 순서를 따른다.'}

[Production Master Brief]
${JSON.stringify(input?.productionMasterBrief || {}, null, 2)}

[확인된 사실]
${JSON.stringify(input?.verifiedFacts || [], null, 2)}

[추가 검증 필요]
${JSON.stringify(input?.claimsToVerify || [], null, 2)}

[출처]
${JSON.stringify(input?.sources || [], null, 2)}

[이전 챕터 연결 문맥]
${JSON.stringify(previousTail || {}, null, 2)}

규칙:
- chapters 배열은 정확히 1개.
- chapterNo는 반드시 ${chapterNo}.
- targetMinutes는 ${Math.max(2, Math.round(chapterMinutes))}.
- 이전 챕터를 반복하지 않고 논리를 이어간다.
- 하나의 소질문에 실질적으로 답한다.
- segment는 완결된 의미 단위로 작성한다.
- visualHint는 실제 화면 설명 설계다.
- factStatus는 verified, interpretation, verify_before_publish 중 하나.
- 첫 챕터가 아니면 hook은 빈 문자열.
- 마지막 챕터가 아니면 ending.text는 빈 문자열.
- 과장·선동·보장 표현 금지.
`.trim()
}

export default async function handler(req: Request, res: Response) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' })
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ ok:false, error:'OPENAI_API_KEY is not configured' })

  const input = req.body?.input || {}
  const chapterNo = Math.max(1, Number(req.body?.chapterNo || 1))
  const totalChapters = Math.max(chapterNo, Number(req.body?.totalChapters || input?.chapterCount || 1))
  const previousChapter = req.body?.previousChapter || null
  const model = String(process.env.OPENAI_STORY_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini')

  const payload:any = {
    model,
    store:false,
    reasoning:{ effort:'medium' },
    instructions:'한국어 롱폼 대본을 작성한다. 제공된 사실과 해석을 구분하고 JSON Schema를 정확히 따른다.',
    input:chapterPrompt(input, chapterNo, totalChapters, previousChapter),
    max_output_tokens:7000,
    text:{ format:{ type:'json_schema', name:'gpt_longform_chapter', strict:true, schema:LONGFORM_DRAFT_SCHEMA } }
  }

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method:'POST',
      headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
      body:JSON.stringify(payload)
    })
    const raw = await response.text()
    let data:any = {}
    try { data = raw ? JSON.parse(raw) : {} } catch {}
    if (!response.ok) return res.status(response.status).json({ ok:false, error:data?.error?.message || raw || 'OpenAI longform request failed' })
    const text = extractText(data)
    if (!text) return res.status(502).json({ ok:false, error:'OpenAI longform response had no text output' })
    let draft:any
    try { draft = JSON.parse(text) } catch { return res.status(502).json({ ok:false, error:'OpenAI longform returned invalid JSON', rawText:text }) }
    if (!Array.isArray(draft?.chapters) || draft.chapters.length !== 1) return res.status(502).json({ ok:false, error:'OpenAI longform returned invalid chapter count' })
    draft.chapters[0].chapterNo = chapterNo
    return res.status(200).json({ ok:true, provider:'OpenAI', model:data?.model || model, draft, usage:data?.usage || null, chapterNo, totalChapters })
  } catch (error:any) {
    return res.status(500).json({ ok:false, error:error?.message || String(error) })
  }
}
