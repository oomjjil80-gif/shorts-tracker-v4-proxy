import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOk, probe } from '../lib/media/ffmpeg.js'

test('P2 generated still + audio encodes with bounded x264 threads', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'p2-ffmpeg-'))
 try{
  const image=join(dir,'still.jpg'), audio=join(dir,'audio.mp3'), out=join(dir,'segment.mp4')
  await runOk(['-y','-f','lavfi','-i','color=c=white:s=1024x1536:d=0.1','-frames:v','1',image],{timeoutMs:30000})
  await runOk(['-y','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','libmp3lame',audio],{timeoutMs:30000})
  await runOk(['-y','-loop','1','-i',image,'-i',audio,'-t','1','-vf','scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p','-af','apad','-r','30','-c:v','libx264','-preset','veryfast','-threads','4','-c:a','aac','-ar','44100','-ac','2','-movflags','+faststart',out],{timeoutMs:60000})
  const p=await probe(out)
  assert.equal(p.width,1080); assert.equal(p.height,1920); assert.equal(p.videoCodec,'h264'); assert.equal(p.audioCodec,'aac')
 }finally{await rm(dir,{recursive:true,force:true})}
})
