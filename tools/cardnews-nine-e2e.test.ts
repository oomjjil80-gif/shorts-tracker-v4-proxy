import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createCardnewsHttp } from '../lib/cardnews/http.js'
import { createHash } from 'node:crypto'
import imageHandler from '../api/image.js'
import { monthInKst } from '../lib/generative/monthlyBudgetPolicy.js'

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

// 감사 P1-E: 8장 덱이 아닌 카드뉴스 이미지도 서버 1회용 승인 + Ledger. /api/image 직접 호출(profile cardnews)은 Gemini 전에 거부(가짜 fetch, 유료 0)

const PNG = '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
const KEY = 'k'.repeat(32), WS = createHash('sha256').update(KEY).digest('hex')
const imageInput = { prompt: '4장 덱 2장 장면', aspectRatio: '4:5', imageSize: '1K', cutIndex: 1, references: [], profile: 'cardnews' }
async function withFakeGemini<T>(fn: (calls: () => number) => Promise<T>) {
  const prevKey = process.env.GEMINI_API_KEY, prevFetch = globalThis.fetch; let n = 0
  process.env.GEMINI_API_KEY = 'test-key'
  globalThis.fetch = (async () => { n++; return new Response(JSON.stringify({ id: 'r', output_image: { data: Buffer.from(PNG, 'hex').toString('base64'), mime_type: 'image/png' } }), { status: 200 }) }) as any
  try { return await fn(() => n) } finally { globalThis.fetch = prevFetch; if (prevKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevKey }
}
const run = async (h: any, req: any) => { let status = 0, json: any; await h({ query: {}, headers: {}, ...req }, { setHeader() {}, end() { return this }, status(s: number) { status = s; return this }, json(b: any) { json = b; return this } }); return { status, json } }

test('/api/image 직접 호출(profile cardnews)은 승인 없이 Gemini에 가지 않는다(403)', () => withFakeGemini(async (calls) => {
  const r = await run(imageHandler, { method: 'POST', body: { contractVersion: '1.5', taskType: 'cut_image', input: imageInput } })
  assert.equal(r.status, 403); assert.equal(r.json.error.code, 'CARDNEWS_APPROVAL_REQUIRED'); assert.equal(calls(), 0)
  // JSON 본문으로 내부 호출 표시를 흉내 내도 통과하지 못한다(Symbol은 JSON에 없음)
  const spoof = await run(imageHandler, { method: 'POST', body: { input: imageInput, internal: true, 'Symbol(tracker.internalImageCall)': true } })
  assert.equal(spoof.status, 403); assert.equal(calls(), 0)
}))

test('cardnews_image_direct: 402 견적 → 승인 1회 → Gemini 1회 → Ledger 기록, 재사용·동시 요청·내용 변경은 차단', () => withFakeGemini(async (calls) => {
  const blobs = createMemoryBlobStore(), h = createCardnewsHttp({ blobs })
  const post = (body: any) => run(h, { method: 'POST', headers: { 'x-sync-key': KEY }, body: { taskType: 'cardnews_image_direct', ...body } })
  assert.equal((await run(h, { method: 'POST', headers: {}, body: { taskType: 'cardnews_image_direct', imageInput } })).status, 401)
  const q = await post({ imageInput }); assert.equal(q.status, 402); assert.equal(q.json.estimate.usd, 0.067); assert.equal(calls(), 0)
  const ok = { imageInput, costApproved: true, approvedUsd: 0.067, approvalId: q.json.approval.approvalId }
  const changed = await post({ ...ok, imageInput: { ...imageInput, prompt: '다른 장면' } }); assert.equal(changed.status, 402); assert.equal(calls(), 0)
  const [a, b] = await Promise.all([post(ok), post(ok)])
  assert.deepEqual([a.status, b.status].sort(), [200, 409]); assert.equal(calls(), 1)
  assert.ok((a.status === 200 ? a : b).json.image.base64)
  assert.equal((await post(ok)).status, 409); assert.equal(calls(), 1)
  const ledger: any = await blobs.getJson(`ai-spend/${WS}/${monthInKst(new Date())}.json`)
  assert.equal(ledger.calls, 1); assert.equal(ledger.usd, 0.067)
  // 4:5·cardnews가 아닌 입력은 견적도 내지 않는다
  assert.equal((await post({ imageInput: { ...imageInput, aspectRatio: '9:16' } })).status, 400); assert.equal(calls(), 1)
}))
