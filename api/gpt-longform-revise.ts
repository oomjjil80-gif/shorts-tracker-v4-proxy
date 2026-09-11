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
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
  res.setHeader('Cache-Control', 'no-store')
}

function extractText(data:any) {
  if (typeof data?.output_text === 'string') return data.output_text.trim()
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') return content.text.trim()
    }
  }
  return ''
}

const LONGFORM_DRAFT_SCHEMA = {
  type:'object',
  additionalProperties:false,
  required:['title','hook','targetMinutes','chapters','ending','shortsSpinOff','warnings'],
  properties:{
    title:{type:'string'},
    hook:{type:'string'},
    targetMinutes:{type:'integer'},
    chapters:{
      type:'array',
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

function buildPrompt(input:any) {
  const finalize = Boolean(input?.finalizeForProduction)
  const handoff = input?.handoff || {}
  const draft = input?.draft || {}
  const qc = input?.qc || {}
  const requiredIssues = (Array.isArray(qc?.issues) ? qc.issues : [])
    .filter((x:any)=>['blocker','required'].includes(String(x?.severity||'').toLowerCase()))
  return [
    '당신은 경제·생활 롱폼 대본 수정 작가다.',
    '새로운 외부 사실을 만들지 말고 제공된 Fact Pack과 원고, QC 지시만 사용한다.',
    '',
    '[handoff]',
    JSON.stringify(handoff,null,2),
    '',
    '[QC revision instructions]',
    JSON.stringify(Array.isArray(qc?.revisionInstructions)?qc.revisionInstructions:[],null,2),
    '',
    '[QC required/blocker issues]',
    JSON.stringify(requiredIssues,null,2),
    '',
    '[draft]',
    JSON.stringify(draft,null,2),
    '',
    finalize
      ? '실제 제작 직전 최종 정리다. 제목·훅·챕터 순서·검증된 사실은 유지하고 모든 speaker를 내레이션으로 통일한다. TTS에 자연스럽게 다듬되 새 사실이나 숫자를 추가하지 않는다. 동일 JSON 구조만 반환한다.'
      : 'QC가 요구한 문제만 정확히 수정한다. 근거가 부족한 주장은 삭제·완화하거나 verify_before_publish로 남긴다. 좋은 구간은 이유 없이 전면 재작성하지 않는다. 동일 JSON 구조만 반환한다.'
  ].join('\n')
}

export default async function handler(req: Request, res: Response) {
  setCors(req,res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ok:false,error:'Method not allowed'})
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return res.status(503).json({ok:false,error:'OPENAI_API_KEY is not configured'})
  const input = req.body?.input || {}
  if (!input?.draft || typeof input.draft !== 'object') return res.status(400).json({ok:false,error:'Longform draft is required'})
  const finalize = Boolean(input?.finalizeForProduction)
  if (!finalize && (!input?.qc || input.qc.status !== 'revision_required')) {
    return res.status(409).json({ok:false,error:`Revision is not allowed for QC status: ${String(input?.qc?.status || 'unknown')}`})
  }
  const model = String(process.env.OPENAI_STORY_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini')
  try {
    const payload:any = {
      model,
      store:false,
      reasoning:{effort:'medium'},
      instructions:'한국어 롱폼 대본을 수정한다. 제공된 사실과 QC 지시만 사용하고 지정된 JSON Schema를 정확히 따른다.',
      input:buildPrompt(input),
      max_output_tokens:16000,
      text:{format:{type:'json_schema',name:'gpt_longform_revision',strict:true,schema:LONGFORM_DRAFT_SCHEMA}}
    }
    const response = await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    })
    const raw=await response.text()
    let data:any={}
    try{data=raw?JSON.parse(raw):{}}catch{}
    if(!response.ok) return res.status(response.status).json({ok:false,error:data?.error?.message || raw || 'OpenAI revision failed'})
    const text=extractText(data)
    if(!text) return res.status(502).json({ok:false,error:'OpenAI revision response had no text output'})
    let draft:any
    try{draft=JSON.parse(text)}catch{return res.status(502).json({ok:false,error:'OpenAI revision returned invalid JSON',rawText:text})}
    return res.status(200).json({
      ok:true,
      provider:'OpenAI',
      model:data?.model || model,
      draft,
      usage:data?.usage || null,
      revisionCount:finalize?0:1,
      finalizeForProduction:finalize
    })
  } catch(error:any) {
    return res.status(500).json({ok:false,error:error?.message || String(error)})
  }
}
