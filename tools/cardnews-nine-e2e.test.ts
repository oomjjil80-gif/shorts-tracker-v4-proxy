import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createCardnewsHttp } from '../lib/cardnews/http.js'

// Real API adapters, real PNG/ZIP bytes, durable store adapter recreation; provider network is entirely mocked.
test('nine panels: approved Gemini → store → restart → replace only panel 2 → ordered ZIP; no unapproved calls', async () => {
  const blobs = createMemoryBlobStore(), key = 'free-test-workspace'.repeat(2)
  let handler = createCardnewsHttp({ blobs })
  const call = async (taskType: string, body: any = {}, get = false) => {
    let status = 0, data: any
    await handler({ method: get ? 'GET' : 'POST', headers: { 'x-sync-key': key }, body: { taskType, ...body }, query: { taskType, ...body } } as any,
      { setHeader() {}, status(s: number) { status = s; return this }, json(v: any) { data = v; return this }, send(v: any) { data = v; return this } } as any)
    return { status, data }
  }
  const png = (color: string) => execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i',`color=c=${color}:s=1080x1350`,'-frames:v','1','-threads','1','-f','image2pipe','-vcodec','png','pipe:1'])
  const initial = png('red'), replacement = png('blue')
  let calls = 0
  const oldFetch = globalThis.fetch, oldKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'mock-no-paid-key'
  globalThis.fetch = (async (url: any, init: any) => {
    assert.match(String(url), /generativelanguage.googleapis.com/)
    const payload = JSON.parse(init.body)
    assert.equal(payload.response_format[0].aspect_ratio, '4:5')
    assert.equal(payload.input[1].type, 'image', 'storyboard bytes reach Gemini')
    calls++
    return new Response(JSON.stringify({ output_image: { data: (calls > 9 ? replacement : initial).toString('base64'), mime_type: 'image/png' } }))
  }) as typeof fetch
  try {
    const state: any = { material: '마지막 9장에서만 외눈박이 거인과 인간 도둑의 정체 공개', cover: {id:'cv_abcd',title:'치즈 도둑의 비밀',coverLine:'누가 들어왔을까',promise:'마지막 장에서 도둑의 정체를 확인한다'}, cards:Array.from({length:8},(_,i)=>({id:`c${i+1}`,headline:`장면 ${i+1}`,body:i===7?'거인과 인간 도둑이 눈을 마주친다':'치즈 작업장에서 벌어진 일'})), scriptConfirmedAt:'2026-11-02',review:{ok:true},images:{},refs:{} }
    const pid = 'p_free00001'
    let saved = await call('cardnews_save',{projectId:pid,state,baseRev:0})
    assert.equal(saved.status,200); assert.equal(saved.data.saved.state.productionPlan.steps.length,11)
    const ids = ['cover',...state.cards.map((c:any)=>c.id)]
    const make = async (id:string) => {
      const body = { projectId:pid, baseRev:saved.data.saved.rev, cardId:id, imageInput:{profile:'cardnews',aspectRatio:'4:5',prompt:'approved scene '+id,references:[{role:'storyboard',data:initial.toString('base64'),mimeType:'image/png'}]} }
      const before=calls, quote=await call('cardnews_image_generate',body)
      assert.equal(quote.status,402); assert.equal(calls,before)
      const approved={...body,approvalId:quote.data.approval.approvalId,costApproved:true,approvedUsd:quote.data.estimate.usd}
      const generated=await call('cardnews_image_generate',approved)
      assert.equal(generated.status,200)
      assert.equal((await call('cardnews_image_generate',approved)).status,409)
      assert.equal(calls,before+1)
      const stored=await call('cardnews_image_put',{dataBase64:generated.data.image.base64})
      assert.equal(stored.status,200)
      const cur=state.images[id] || {versions:[]}, version={id:`v${cur.versions.length+1}`,ref:stored.data.ref}
      state.images[id]={selected:version.id,versions:[...cur.versions,version]}
      saved=await call('cardnews_save',{projectId:pid,state,baseRev:saved.data.saved.rev})
      assert.equal(saved.status,200)
    }
    for(const id of ids) await make(id)
    const originals=structuredClone(state.images)
    await make('c1') // panel 2 only
    for(const id of ids.filter(x=>x!=='c1')) assert.deepEqual(state.images[id],originals[id])
    assert.equal(calls,10)
    handler=createCardnewsHttp({blobs})
    const restored=await call('cardnews_get',{projectId:pid},true)
    assert.deepEqual(restored.data.saved.state.images.c1.versions.map((v:any)=>v.ref),state.images.c1.versions.map((v:any)=>v.ref))
    const zip=await call('cardnews_zip_get',{projectId:pid},true)
    assert.equal(zip.status,200)
    let pos=0
    for(let i=0;i<9;i++) {
      const size=zip.data.readUInt32LE(pos+18),n=zip.data.readUInt16LE(pos+26),start=pos+30+n
      assert.equal(zip.data.subarray(pos+30,start).toString(),`panel-0${i+1}.png`)
      assert.deepEqual(zip.data.subarray(start,start+size),i===1?replacement:initial)
      pos=start+size
    }
    assert.equal(zip.data.readUInt32LE(pos),0x02014b50)
    state.refs={storyboard:{cover:{ref:state.images.cover.versions[0].ref}}}
    saved=await call('cardnews_save',{projectId:pid,state,baseRev:saved.data.saved.rev})
    assert.equal((await call('cardnews_zip_get',{projectId:pid},true)).status,400,'storyboard crop cannot be exported as a final')
    assert.equal(calls,10)
  } finally { globalThis.fetch=oldFetch; if(oldKey===undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY=oldKey }
})
