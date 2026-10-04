import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256 } from '../../lib/jobs/blobs.js'
import { openAiTts } from '../../lib/generative/providers.js'
import { GENERAL_SHORTS_DEFAULT_VOICE_PROFILE } from '../../lib/generative/voiceProfile.js'
import { probe } from '../../lib/media/ffmpeg.js'
import { StageError, type StageExecutor } from '../types.js'

type TtsFn = typeof openAiTts

export function createSourceShortsNarrationAssetExecutor(deps:{apiKey?:string;tts?:TtsFn}={}):StageExecutor {
  const apiKey=deps.apiKey??process.env.OPENAI_API_KEY??''
  const tts=deps.tts??openAiTts
  return {
    stage:'ASSET',
    estimateUsd:()=>0.05,
    inputHash:(job)=>sha256(`source-shorts-asset|v1|${job.planRef}|${job.planRev}`),
    async run({job,blobs,signal}){
      if(job.profile!=='source_shorts') throw new StageError('PROFILE_UNSUPPORTED','source Shorts ASSET only handles source_shorts')
      if(!job.planRef) throw new StageError('PLAN_MISSING','source Shorts narration requires a plan')
      const plan:any=await blobs.getJson(job.planRef)
      if(!plan||plan.schema!=='job-plan/1'||plan.profile!=='source_shorts') throw new StageError('PLAN_INVALID','invalid source Shorts plan')
      const voice=plan?.variantPlan?.voiceover
      const text=String(voice?.text||'').trim()
      if(!text) return {outputHash:sha256('source-shorts-no-voiceover'),result:{voiceover:false}}
      if(signal.aborted) throw new Error('aborted')
      if(!apiKey) throw new StageError('PROVIDER_DOWN','OPENAI_API_KEY is not configured',true)
      if(text.length>700) throw new StageError('NARRATION_TOO_LONG','source Shorts narration is limited to 700 characters')
      const beats=Array.isArray(plan?.variantPlan?.beats)?plan.variantPlan.beats:[]
      const total=beats.reduce((n:number,b:any)=>n+Math.max(0,Number(b?.trimEnd||0)-Number(b?.trimStart||0)),0)
      if(!(total>0)) throw new StageError('PLAN_INVALID','source Shorts narration requires positive beat duration')

      const cacheKey=sha256(`source-shorts-tts-v1|${GENERAL_SHORTS_DEFAULT_VOICE_PROFILE.id}|${text}`)
      const cachePath=`source-shorts-cache/tts/${cacheKey}.json`
      let meta:any=await blobs.getJson(cachePath).catch(()=>null)
      let bytes:Buffer|null=meta?.ref?await blobs.getBytes(meta.ref).catch(()=>null):null
      let generated=false
      if(!bytes){
        const made=await tts(text,apiKey,GENERAL_SHORTS_DEFAULT_VOICE_PROFILE)
        bytes=made.bytes
        const audioHash=sha256(bytes)
        const ref=`source-shorts-assets/audio/${audioHash}.mp3`
        await blobs.putBytes(ref,bytes,made.contentType)
        meta={ref,sha256:audioHash,contentType:made.contentType,provider:made.provider,model:made.model,voiceProfileId:GENERAL_SHORTS_DEFAULT_VOICE_PROFILE.id}
        await blobs.putJson(cachePath,meta)
        generated=true
      }
      const work=await mkdtemp(join(tmpdir(),'source-shorts-tts-'))
      try{
        const p=join(work,'voice.mp3'); await writeFile(p,bytes)
        const info=await probe(p); const duration=Number(info.duration||0)
        if(!(duration>0)) throw new StageError('NARRATION_INVALID','generated narration duration is invalid')
        if(duration>total+0.15) throw new StageError('NARRATION_TOO_LONG',`narration ${duration.toFixed(2)}s exceeds edit ${total.toFixed(2)}s`)
        return {
          outputRef:meta.ref, outputHash:meta.sha256,
          result:{
            voiceover:true,voiceoverRef:meta.ref,voiceoverSha256:meta.sha256,durationSec:Number(duration.toFixed(2)),
            voiceProfileId:GENERAL_SHORTS_DEFAULT_VOICE_PROFILE.id,
            sourceVolume:Number.isFinite(Number(voice?.sourceVolume))?Math.max(0,Math.min(1,Number(voice.sourceVolume))):0.24,
            voiceVolume:Number.isFinite(Number(voice?.voiceVolume))?Math.max(0.5,Math.min(1.5,Number(voice.voiceVolume))):1,
            generated,textLength:text.length
          },
          provider:meta.provider,model:meta.model
        }
      } finally { await rm(work,{recursive:true,force:true}) }
    }
  }
}
