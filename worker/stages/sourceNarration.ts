import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, type JobBlobStore } from '../../lib/jobs/blobs.js'
import type { Job } from '../../lib/jobs/types.js'
import { openAiTts } from '../../lib/generative/providers.js'
import { GENERAL_SHORTS_DEFAULT_VOICE_PROFILE } from '../../lib/generative/voiceProfile.js'
import { probe, runOk } from '../../lib/media/ffmpeg.js'
import { StageError } from '../types.js'

type TtsFn = typeof openAiTts

export type SourceShortsNarration = {
  ref: string
  sha256: string
  durationSec: number
  sourceVolume: number
  voiceVolume: number
  voiceProfileId: string
  generated: boolean
}

export async function resolveSourceShortsNarration(o:{
  job: Job
  blobs: JobBlobStore
  signal?: AbortSignal
  apiKey?: string
  tts?: TtsFn
}):Promise<SourceShortsNarration|null>{
  const {job,blobs,signal}=o
  if(job.profile!=='source_shorts') return null
  if(!job.planRef) return null

  const plan:any=await blobs.getJson(job.planRef)
  if(!plan||plan.schema!=='job-plan/1'||plan.profile!=='source_shorts') throw new StageError('PLAN_INVALID','invalid source Shorts plan')
  const voice=plan?.variantPlan?.voiceover
  const lines=Array.isArray(voice?.lines)?voice.lines.map((x:any)=>({
    start:Number(x?.start), end:Number(x?.end), text:String(x?.text||'').trim()
  })).filter((x:any)=>Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.end>x.start&&x.text):[]
  if(!lines.length) return null
  if(signal?.aborted) throw new Error('aborted')

  const apiKey=o.apiKey??process.env.OPENAI_API_KEY??''
  const tts=o.tts??openAiTts
  if(!apiKey) throw new StageError('PROVIDER_DOWN','OPENAI_API_KEY is not configured',true)

  const beats=Array.isArray(plan?.variantPlan?.beats)?plan.variantPlan.beats:[]
  const total=beats.reduce((n:number,b:any)=>n+Math.max(0,Number(b?.trimEnd||0)-Number(b?.trimStart||0)),0)
  if(!(total>0)) throw new StageError('PLAN_INVALID','source Shorts narration requires positive beat duration')

  const sourceToOutput=(t:number)=>{
    let clock=0
    for(const b of beats){
      const s=Number(b?.trimStart),e=Number(b?.trimEnd)
      if(Number.isFinite(s)&&Number.isFinite(e)&&t>=s-1e-6&&t<=e+1e-6)return clock+Math.max(0,t-s)
      clock+=Math.max(0,e-s)
    }
    return null
  }
  const timed=lines.map((x:any)=>({...x,outStart:sourceToOutput(x.start)})).filter((x:any)=>x.outStart!==null)
  if(!timed.length) return null
  if(timed.some((x:any)=>x.text.length>160)) throw new StageError('NARRATION_TOO_LONG','a timed dub line exceeds 160 characters')

  const cacheKey=sha256(`source-shorts-tts-timed-v1|${GENERAL_SHORTS_DEFAULT_VOICE_PROFILE.id}|${JSON.stringify(timed.map((x:any)=>[Number(x.outStart.toFixed(2)),x.text]))}`)
  const cachePath=`source-shorts-cache/tts-timed/${cacheKey}.json`
  let meta:any=await blobs.getJson(cachePath).catch(()=>null)
  let bytes:Buffer|null=meta?.ref?await blobs.getBytes(meta.ref).catch(()=>null):null
  let generated=false

  const work=await mkdtemp(join(tmpdir(),'source-shorts-tts-'))
  try{
    const composite=join(work,'voice.wav')
    if(!bytes){
      const inputs:string[]=[]
      const filters:string[]=[]
      const refs:any[]=[]
      for(let i=0;i<timed.length;i++){
        const line=timed[i]
        const made=await tts(line.text,apiKey,GENERAL_SHORTS_DEFAULT_VOICE_PROFILE)
        const p=join(work,`line-${i}.mp3`)
        await writeFile(p,made.bytes)
        const info=await probe(p)
        const duration=Number(info.duration||0)
        if(!(duration>0)) throw new StageError('NARRATION_INVALID',`timed dub line ${i+1} has invalid duration`)
        const nextStart=i+1<timed.length?Number(timed[i+1].outStart):total
        const available=Math.max(0.35,nextStart-Number(line.outStart))
        if(duration>available+0.2) throw new StageError('NARRATION_TOO_LONG',`timed dub line ${i+1} (${duration.toFixed(2)}s) exceeds its ${available.toFixed(2)}s slot`)
        inputs.push('-i',p)
        const delay=Math.max(0,Math.round(Number(line.outStart)*1000))
        filters.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${delay}|${delay},apad,atrim=duration=${total.toFixed(3)}[d${i}]`)
        refs.push({text:line.text,start:Number(Number(line.outStart).toFixed(2)),durationSec:Number(duration.toFixed(2))})
      }
      filters.push(`${timed.map((_:any,i:number)=>`[d${i}]`).join('')}amix=inputs=${timed.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${total.toFixed(3)}[mix]`)
      await runOk(['-y',...inputs,'-filter_complex',filters.join(';'),' -map'.trim(),'[mix]','-c:a','pcm_s16le','-ar','44100','-ac','2',composite],{signal,timeoutMs:120000})
      const generatedBytes=await import('node:fs/promises').then(m=>m.readFile(composite))
      bytes=generatedBytes
      const audioHash=sha256(generatedBytes)
      const ref=`source-shorts-assets/audio/${audioHash}.wav`
      await blobs.putBytes(ref,generatedBytes,'audio/wav')
      meta={ref,sha256:audioHash,contentType:'audio/wav',provider:'openai',model:GENERAL_SHORTS_DEFAULT_VOICE_PROFILE.model,voiceProfileId:GENERAL_SHORTS_DEFAULT_VOICE_PROFILE.id,lines:refs}
      await blobs.putJson(cachePath,meta)
      generated=true
    } else {
      await writeFile(composite,bytes as Buffer)
    }

    const info=await probe(composite)
    const duration=Number(info.duration||0)
    if(!(duration>0)) throw new StageError('NARRATION_INVALID','generated timed dub track duration is invalid')
    return {
      ref:meta.ref,
      sha256:meta.sha256,
      durationSec:Number(duration.toFixed(2)),
      sourceVolume:Number.isFinite(Number(voice?.sourceVolume))?Math.max(0,Math.min(1,Number(voice.sourceVolume))):0,
      voiceVolume:Number.isFinite(Number(voice?.voiceVolume))?Math.max(0.5,Math.min(1.5,Number(voice.voiceVolume))):1,
      voiceProfileId:GENERAL_SHORTS_DEFAULT_VOICE_PROFILE.id,
      generated
    }
  } finally {
    await rm(work,{recursive:true,force:true})
  }
}
