import express from 'express'
const app = express()
app.use(express.json({ limit:'256kb' }))

const STORY_SCHEMA={
  type:'object',
  additionalProperties:false,
  required:[
    'seriesType','title','subject','hook','summary',
    'cutCountSuggested','cuts','imageStyleNote','warnings'
  ],
  properties:{
    seriesType:{type:'string'},
    title:{type:'string'},
    subject:{type:'string'},
    hook:{type:'string'},
    summary:{type:'string'},
    imageStyleNote:{type:'string'},
    cutCountSuggested:{type:'integer',minimum:1,maximum:30},
    warnings:{type:'array',items:{type:'string'}},
    cuts:{
      type:'array',
      minItems:1,
      maxItems:30,
      items:{
        type:'object',
        additionalProperties:false,
        required:[
          'purpose','situation','narration',
          'directorNote','imagePrompt','dialogueLines'
        ],
        properties:{
          purpose:{type:'string'},
          situation:{type:'string'},
          narration:{type:'string'},
          directorNote:{type:'string'},
          imagePrompt:{type:'string'},
          dialogueLines:{
            type:'array',
            items:{
              type:'object',
              additionalProperties:false,
              required:['speaker','text','voice'],
              properties:{
                speaker:{type:'string'},
                text:{type:'string'},
                voice:{type:'string'}
              }
            }
          }
        }
      }
    }
  }
}

function allowCors(req:express.Request,res:express.Response){
  const origin=String(req.headers.origin||'')

  const allowed=
    /^http:\/\/localhost(?::\d+)?$/i.test(origin)||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin)||
    /^https:\/\/shorts-production-tracker\.vercel\.app$/i.test(origin)||
    /^https:\/\/shorts-production-tracker-[a-z0-9-]+\.vercel\.app$/i.test(origin)

  if(allowed){
    res.setHeader('Access-Control-Allow-Origin',origin)
    res.setHeader('Vary','Origin')
  }

  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers','Content-Type')
}

app.use((req,res,next)=>{
  allowCors(req,res)

  if(req.method==='OPTIONS'){
    return res.status(204).end()
  }

  next()
})

function systemPrompt(
  seriesType:string,
  targetSeconds:number,
  targetCutCount:number,
  imageStyleNote:string
){
  const rules:Record<string,string>={
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
    rules[seriesType]||rules.freeform,
    `목표 길이 ${targetSeconds}초, 목표 CUT ${targetCutCount}개.`,
    '각 CUT의 narration은 실제 TTS에 바로 사용할 수 있는 자연스러운 한국어로 작성한다.',
    'imagePrompt는 이미지 생성 모델이 이해할 수 있는 구체적인 장면 지시로 작성하고 이미지 안 텍스트는 금지한다.',
    `전체 이미지 스타일 참고: ${imageStyleNote||'일관된 9:16 쇼츠 비주얼'}.`,
    '반드시
