import type { Request, Response } from 'express'

function setCors(_req: Request, res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
  res.setHeader('Cache-Control', 'no-store')
}

function extractText(data: any) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim()
  for (const item of data?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === 'string' && c.text.trim()) return c.text.trim()
    }
  }
  return ''
}

const SCHEMA:any = {
  type:'object', additionalProperties:false,
  required:['title','hook','targetMinutes','chapters','ending','shortsSpinOff','warnings'],
  properties:{
    title:{type:'string'}, hook:{type:'string'}, targetMinutes:{type:'integer'},
    chapters:{type:'array',items:{type:'object',additionalProperties:false,
      required:['chapterNo','title','purpose','segments'],
      properties:{
        chapterNo:{type:'integer'}, title:{type:'string'}, purpose:{type:'string'},
        segments:{type:'array',items:{type:'object',additionalProperties:false,
          required:['speaker','text','visualHint','factStatus'],
          properties:{speaker:{type:'string'},text:{type:'string'},visualHint:{type:'string'},
            factStatus:{type:'string',enum:['verified','interpretation','verify_before_publish']}}
        }}
      }
    }},
    ending:{type:'object',additionalProperties:false,required:['speaker','text'],properties:{speaker:{type:'string'},text:{type:'string'}}},
    shortsSpinOff:{type:'array',items:{type:'string'}}, warnings:{type:'array',items:{type:'string'}}
  }
}

export default async function handler(req:Request,res:Response){
  setCors(req,res)
  if(req.method==='OPTIONS') return res.status(204).end()
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed'})
  const apiKey=process.env.OPENAI_API_KEY
  if(!apiKey) return res.status(503).json({ok:false,error:'OPENAI_API_KEY is not configured'})
  const input=req.body?.input||{}
  const chapterNo=Math.max(1,Number(req.body?.chapterNo||1))
  const totalChapters=Math.max(chapterNo,Number(req.body?.totalChapters||input?.chapterCount||6))
  const targetMinutes=Math.max(1,Math.round(Number(input?.targetMinutes||15)/totalChapters))
  const previous=req.body?.previousChapter||null
  const prompt=[
    `전체 ${totalChapters}개 중 ${chapterNo}번 챕터 하나만 작성하라. 실제 유튜브 제작용 자연스러운 한국어 대본이다.`,
    '사실/해석을 구분하되 검수 경고 때문에 집필을 중단하지 않는다.',
    `이번 챕터 targetMinutes는 ${targetMinutes}, chapters 배열은 정확히 1개, chapterNo는 ${chapterNo}.`,
    chapterNo===1?'첫 챕터는 강한 hook을 작성한다.':'hook은 빈 문자열.',
    chapterNo===totalChapters?'마지막 챕터 ending을 작성한다.':'ending.text는 빈 문자열.',
    'segment는 완결된 의미 단위이며 speaker는 기본적으로 내레이션. visualHint는 실제 화면 설계.',
    '[Production Master Brief]\n'+JSON.stringify(input.productionMasterBrief||{}),
    '[Provider Brief]\n'+JSON.stringify(input.providerBrief||{}),
    '[소재]\n'+JSON.stringify({title:input.title,summary:input.summary,whyNow:input.whyNow,viewerValue:input.viewerValue,longformProfile:input.longformProfile,benchmarkReference:input.benchmarkReference,storyMap:input.storyMap}),
    '[검증 사실]\n'+JSON.stringify(input.verifiedFacts||[]),
    '[확인 필요]\n'+JSON.stringify(input.claimsToVerify||[]),
    '[출처]\n'+JSON.stringify(input.sources||[]),
    '[이전 챕터]\n'+JSON.stringify(previous||{})
  ].join('\n\n')
  const model=String(process.env.OPENAI_LONGFORM_MODEL||process.env.OPENAI_QC_MODEL||'gpt-5-mini')
  const payload:any={model,input:prompt,text:{format:{type:'json_schema',name:'longform_chapter',strict:true,schema:SCHEMA}}}
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(payload)})
    const raw=await r.text(); let data:any={}; try{data=raw?JSON.parse(raw):{}}catch{}
    if(!r.ok) return res.status(r.status).json({ok:false,error:data?.error?.message||raw||'OpenAI request failed'})
    const text=extractText(data)
    if(!text) return res.status(502).json({ok:false,error:'GPT longform fallback returned no text'})
    let draft:any; try{draft=JSON.parse(text)}catch{return res.status(502).json({ok:false,error:'GPT longform fallback returned invalid JSON'})}
    if(!Array.isArray(draft?.chapters)||draft.chapters.length!==1) return res.status(502).json({ok:false,error:'GPT longform fallback returned invalid chapter count'})
    draft.chapters[0].chapterNo=chapterNo
    return res.status(200).json({ok:true,provider:'OpenAI',model:data?.model||model,draft,usage:data?.usage||null,generationMode:'gpt_fallback_chapter',chapterNo,totalChapters})
  }catch(e:any){return res.status(500).json({ok:false,error:e?.message||String(e)})}
}
