import type { Request, Response } from 'express'
import { runVisualDirector } from '../lib/visualDirectorCore.js'

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
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
}


const LONGFORM_CHAPTER_SCHEMA = {
  type:'object',
  additionalProperties:false,
  required:['title','hook','targetMinutes','chapters','ending','shortsSpinOff','warnings'],
  properties:{
    title:{type:'string'},
    hook:{type:'string'},
    targetMinutes:{type:'integer'},
    chapters:{
      type:'array',
      minItems:1,
      maxItems:1,
      items:{
        type:'object',
        additionalProperties:false,
        required:['chapterNo','title','purpose','segments'],
        properties:{
          chapterNo:{type:'integer'},
          title:{type:'string'},
          purpose:{type:'string'},
          segments:{
            type:'array',
            items:{
              type:'object',
              additionalProperties:false,
              required:['speaker','text','visualHint','factStatus'],
              properties:{
                speaker:{type:'string'},
                text:{type:'string'},
                visualHint:{type:'string'},
                factStatus:{type:'string',enum:['verified','interpretation','verify_before_publish']}
              }
            }
          }
        }
      }
    },
    ending:{
      type:'object',
      additionalProperties:false,
      required:['speaker','text'],
      properties:{speaker:{type:'string'},text:{type:'string'}}
    },
    shortsSpinOff:{type:'array',items:{type:'string'}},
    warnings:{type:'array',items:{type:'string'}}
  }
} as const

const STORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['seriesType', 'title', 'subject', 'hook', 'summary', 'cutCountSuggested', 'cuts', 'imageStyleNote', 'warnings'],
  properties: {
    seriesType: { type: 'string' },
    title: { type: 'string' },
    subject: { type: 'string' },
    hook: { type: 'string' },
    summary: { type: 'string' },
    cutCountSuggested: { type: 'integer', minimum: 1, maximum: 30 },
    imageStyleNote: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    cuts: {
      type: 'array', minItems: 1, maxItems: 30,
      items: {
        type: 'object', additionalProperties: false,
        required: ['purpose', 'situation', 'narration', 'directorNote', 'imagePrompt', 'dialogueLines'],
        properties: {
          purpose: { type: 'string' },
          situation: { type: 'string' },
          narration: { type: 'string' },
          directorNote: { type: 'string' },
          imagePrompt: { type: 'string' },
          dialogueLines: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['speaker', 'text', 'voice'],
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

function systemPrompt(seriesType: string, targetSeconds: number, targetCutCount: number, imageStyleNote: string) {
  const rules: Record<string, string> = {
    general_issue: '한국어 쇼츠용 시사/일반 이슈. 첫 1~2초 훅을 강하게 만들되 사실과 추측을 섞지 말고 과장된 단정을 피한다.',
    horror: '한국어 괴담 쇼츠. 초반 불안감, 정보 지연, 후반 반전 또는 여운을 만든다.',
    two_year_intern: '두살인턴 IP. 2살 외형과 달관한 직장인 사고방식의 부조화가 핵심이며 과장된 아기말은 사용하지 않는다.',
    freeform: '한국어 자유형 쇼츠. 입력 소재에 가장 적합한 구조를 선택한다.'
  }
  return [
    '당신은 Shorts Production Tracker의 Story Writer다.',
    rules[seriesType] || rules.freeform,
    `목표 길이 ${targetSeconds}초, 목표 CUT ${targetCutCount}개.`,
    '각 CUT의 narration은 실제 TTS에 바로 사용할 수 있는 자연스러운 한국어로 작성한다.',
    'imagePrompt는 이미지 생성 모델이 이해할 수 있는 구체적인 장면 지시로 작성하고 이미지 안 텍스트는 금지한다.',
    `전체 이미지 스타일 참고: ${imageStyleNote || '일관된 9:16 쇼츠 비주얼'}.`,
    '반드시 지정된 JSON schema만 출력한다.'
  ].join('\n')
}

function extractText(data: any) {
  if (typeof data?.output_text === 'string') return data.output_text
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') return content.text
    }
  }
  return ''
}

export default async function handler(req: Request, res: Response) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: { message: 'OPENAI_API_KEY is not configured' } })

  const body = req.body || {}
  const input = body.input || {}

  if (body.taskType === 'longform_chapter') {
    const chapterNo = Math.max(1, Number(body.chapterNo || 1))
    const totalChapters = Math.max(chapterNo, Number(body.totalChapters || input?.chapterCount || 6))
    const targetMinutes = Math.max(1, Math.round(Number(input?.targetMinutes || 15) / totalChapters))
    const previous = body.previousChapter || null
    const longformModel = String(process.env.OPENAI_LONGFORM_MODEL || process.env.OPENAI_QC_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini')
    const prompt = [
      `전체 ${totalChapters}개 중 ${chapterNo}번 챕터 하나만 작성하라. 실제 유튜브 제작용 자연스러운 한국어 대본이다.`,
      '사실/해석을 구분하되 검수 경고 때문에 집필을 중단하지 않는다.',
      `이번 챕터 targetMinutes는 ${targetMinutes}, chapters 배열은 정확히 1개, chapterNo는 ${chapterNo}.`,
      chapterNo === 1 ? '첫 챕터는 강한 hook을 작성한다.' : 'hook은 빈 문자열.',
      chapterNo === totalChapters ? '마지막 챕터 ending을 작성한다.' : 'ending.text는 빈 문자열.',
      'segment는 완결된 의미 단위이며 speaker는 기본적으로 내레이션. visualHint는 실제 화면 설계.',
      '[Production Master Brief]\n' + JSON.stringify(input.productionMasterBrief || {}),
      '[Provider Brief]\n' + JSON.stringify(input.providerBrief || {}),
      '[소재]\n' + JSON.stringify({title:input.title,summary:input.summary,whyNow:input.whyNow,viewerValue:input.viewerValue,longformProfile:input.longformProfile,benchmarkReference:input.benchmarkReference,storyMap:input.storyMap}),
      '[검증 사실]\n' + JSON.stringify(input.verifiedFacts || []),
      '[확인 필요]\n' + JSON.stringify(input.claimsToVerify || []),
      '[출처]\n' + JSON.stringify(input.sources || []),
      '[이전 챕터]\n' + JSON.stringify(previous || {})
    ].join('\n\n')
    const payload:any = {
      model: longformModel,
      input: prompt,
      text: { format: { type:'json_schema', name:'longform_chapter', strict:true, schema:LONGFORM_CHAPTER_SCHEMA } }
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
      if (!text) return res.status(502).json({ ok:false, error:'GPT longform fallback returned no text' })
      let draft:any
      try { draft = JSON.parse(text) } catch { return res.status(502).json({ ok:false, error:'GPT longform fallback returned invalid JSON' }) }
      if (!Array.isArray(draft?.chapters) || draft.chapters.length !== 1) {
        return res.status(502).json({ ok:false, error:'GPT longform fallback returned invalid chapter count' })
      }
      draft.chapters[0].chapterNo = chapterNo
      return res.status(200).json({ ok:true, provider:'OpenAI', model:data?.model || longformModel, draft, usage:data?.usage || null, generationMode:'gpt_fallback_chapter', chapterNo, totalChapters })
    } catch (error:any) {
      return res.status(500).json({ ok:false, error:error?.message || String(error) })
    }
  }

  if (body.taskType === 'visual_director') {
    try {
      const model = String(process.env.OPENAI_VISUAL_DIRECTOR_MODEL || process.env.OPENAI_QC_MODEL || 'gpt-5.6-terra')
      const result = await runVisualDirector(String(process.env.OPENAI_API_KEY), model, input)
      return res.status(result.status).json(result.body)
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) })
    }
  }

  const topic = String(input.topic || '').trim()
  if (!topic) return res.status(400).json({ error: { message: 'topic is required' } })

  const model = String(body.modelId || process.env.OPENAI_MODEL || 'gpt-5-mini')
  const targetSeconds = Math.max(10, Math.min(180, Number(input.targetSeconds) || 45))
  const targetCutCount = Math.max(1, Math.min(30, Number(input.targetCutCount) || 8))
  const reasoningEffort = ['minimal', 'low', 'medium', 'high'].includes(body.reasoningEffort) ? body.reasoningEffort : 'low'
  const payload = {
    model,
    reasoning: { effort: reasoningEffort },
    instructions: systemPrompt(String(input.seriesType || 'freeform'), targetSeconds, targetCutCount, String(input.imageStyleNote || '')),
    input: topic,
    text: { format: { type: 'json_schema', name: 'story_draft', strict: true, schema: STORY_SCHEMA } }
  }

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const raw = await response.text()
    let data: any = {}
    try { data = raw ? JSON.parse(raw) : {} } catch {}
    if (!response.ok) return res.status(response.status).json({ error: { message: data?.error?.message || raw || 'OpenAI API request failed' } })
    const text = extractText(data)
    if (!text) return res.status(502).json({ error: { message: 'OpenAI response had no text output' } })
    const draft = JSON.parse(text)
    return res.status(200).json({ draft, meta: { provider: 'openai', model, responseId: data?.id || null, usage: data?.usage || null } })
  } catch (error: any) {
    return res.status(500).json({ error: { message: error?.message || String(error) } })
  }
}
