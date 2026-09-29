import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { putAddressed, sha256 } from '../../lib/jobs/blobs.js'
import { StageError, type StageExecutor } from '../types.js'

function run(cmd:string,args:string[],signal:AbortSignal){
  return new Promise<void>((resolve,reject)=>{
    const p=spawn(cmd,args,{stdio:['ignore','ignore','pipe']}); let err=''
    p.stderr.on('data',d=>err+=String(d).slice(-4000))
    p.on('error',reject); p.on('close',c=>c===0?resolve():reject(new Error(err||('exit '+c))))
    signal.addEventListener('abort',()=>p.kill('SIGTERM'),{once:true})
  })
}
export const renderExecutor: StageExecutor = {
  stage:'RENDER', estimateUsd:()=>0,
  inputHash:(job)=>sha256(String(job.approvedManifestHash||job.id)),
  async run({job,blobs,resolveSourceAsset,signal}){
    const compileRuns = await (blobs as any).getJson?.(`qc/compile/${job.approvedManifestHash}.json`).catch?.(()=>null)
    void compileRuns
    const source=await resolveSourceAsset(job.sourceAssetId)
    const manifestRef=(job as any).lastOutputRef
    if(!manifestRef) throw new StageError('MANIFEST_REF_MISSING','render requires compile output ref')
    const m:any=await blobs.getJson(manifestRef)
    const segs=m?.payload?.segments||m?.payload?.timeline?.segments
    if(!Array.isArray(segs)||!segs.length) throw new StageError('MANIFEST_INVALID','no renderable segments')
    const work=await mkdtemp(join(tmpdir(),'tracker-render-'))
    try{
      const src=join(work,'source.mp4'), list=join(work,'concat.txt'), out=join(work,'final.mp4')
      const res=await fetch(source.playbackUrl||source.url)
      if(!res.ok) throw new StageError('SOURCE_DOWNLOAD_FAILED',`source GET ${res.status}`,true)
      await writeFile(src,Buffer.from(await res.arrayBuffer()))
      const parts:string[]=[]
      for(let i=0;i<segs.length;i++){
        const s=Number(segs[i].sourceStart??segs[i].trimStart??segs[i].start), e=Number(segs[i].sourceEnd??segs[i].trimEnd??segs[i].end)
        if(!(e>s)) throw new StageError('MANIFEST_INVALID',`bad segment ${i}`)
        const part=join(work,`p${i}.mp4`)
        await run(ffmpegPath!,['-y','-ss',String(s),'-to',String(e),'-i',src,'-vf','scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920','-c:v','libx264','-preset','veryfast','-crf','20','-c:a','aac','-b:a','160k','-movflags','+faststart',part],signal)
        parts.push(part)
      }
      await writeFile(list,parts.map(p=>`file '${p.replaceAll("'","'\\''")}'`).join('\n'))
      await run(ffmpegPath!,['-y','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',out],signal)
      const bytes=await readFile(out); const hash=sha256(bytes)
      const stored=await blobs.putBytes?.(`renders/${hash}.mp4`,bytes,'video/mp4')
      if(!stored?.path) throw new StageError('RENDER_STORE_FAILED','blob store does not support binary render output')
      return {outputRef:stored.path,outputHash:hash,result:{renderHash:hash,bytes:bytes.length},costUsd:0}
    } finally { await rm(work,{recursive:true,force:true}) }
  }
}
