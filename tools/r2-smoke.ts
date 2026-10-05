import { randomUUID } from 'node:crypto'
import { put, get, head, list, presign, storageBackend } from '../lib/objectStorage.js'

async function main() {
  const required=['R2_ENDPOINT','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY']
  const missing=required.filter(k=>!String(process.env[k]||'').trim())
  if(missing.length) throw new Error('missing env: '+missing.join(','))
  if(storageBackend()!=='r2') throw new Error('storageBackend is not r2')

  const path='smoke/r2-'+Date.now()+'-'+randomUUID()+'.txt'
  const body='tracker-r2-smoke-'+randomUUID()

  const saved:any=await put(path, body, {access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'text/plain'})
  console.log('[R2_SMOKE] PUT PASS', JSON.stringify({path,etag:saved?.etag||null}))

  const h:any=await head(path)
  if(!h || h.pathname!==path) throw new Error('HEAD did not return the object')
  if(Number(h.size)!==Buffer.byteLength(body)) throw new Error(`HEAD size mismatch: ${h.size} != ${Buffer.byteLength(body)}`)
  console.log('[R2_SMOKE] HEAD PASS', JSON.stringify({size:h.size,contentType:h.contentType||null}))

  const g:any=await get(path,{access:'private',useCache:false})
  if(!g?.stream) throw new Error('GET did not return a stream')
  const text=await new Response(g.stream).text()
  if(text!==body) throw new Error('GET body mismatch')
  console.log('[R2_SMOKE] GET PASS', JSON.stringify({bytes:text.length}))

  const page:any=await list({prefix:path,limit:1})
  if(!page?.blobs?.some((x:any)=>x.pathname===path)) throw new Error('LIST did not include the object')
  console.log('[R2_SMOKE] LIST PASS', JSON.stringify({count:page.blobs.length}))

  const signed:any=await presign(path,5*60*1000)
  if(!signed?.url) throw new Error('presign returned no URL')
  const res=await fetch(signed.url)
  const signedBody=await res.text()
  if(!res.ok || signedBody!==body) throw new Error('signed GET failed: '+res.status)
  console.log('[R2_SMOKE] PRESIGN PASS', JSON.stringify({status:res.status,validUntil:signed.validUntil}))
  console.log('[R2_SMOKE] ALL PASS')

  const apiBase=String(process.env.CONTINUITY_API_URL||'').replace(/\/$/,'')
  if(apiBase){
    const healthRes=await fetch(apiBase+'/api/continuity-health')
    const health:any=await healthRes.json().catch(()=>({}))
    if(!healthRes.ok || health?.storage!=='r2') throw new Error('continuity health failed')
    console.log('[CONTINUITY] HEALTH PASS', JSON.stringify({storage:health.storage}))

    const capsRes=await fetch(apiBase+'/api/story')
    const caps:any=await capsRes.json().catch(()=>({}))
    if(!capsRes.ok || caps?.capabilities?.sourceCollectorConfigured!==true || !String(caps?.capabilities?.sourceAssetRegistry||'').startsWith('r2')) {
      throw new Error('continuity capabilities failed')
    }
    console.log('[CONTINUITY] API PASS', JSON.stringify({registry:caps.capabilities.sourceAssetRegistry}))

    const homeRes=await fetch(apiBase+'/',{headers:{Accept:'text/html'}})
    const home=await homeRes.text()
    if(!homeRes.ok || !/<(?:!doctype\s+html|html)[\s>]/i.test(home)) throw new Error('continuity Tracker UI proxy failed')
    console.log('[CONTINUITY] UI PASS', JSON.stringify({status:homeRes.status,bytes:home.length}))

    const sourceUrl=String(process.env.CONTINUITY_SOURCE_URL||'').trim()
    if(sourceUrl){
      const collectRes=await fetch(apiBase+'/api/story',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({taskType:'source_collect',sourceUrl})
      })
      const collected:any=await collectRes.json().catch(()=>({}))
      if(!collectRes.ok || !collected?.ok || !collected?.sourceAssetId) throw new Error('source collect failed: '+JSON.stringify(collected))
      const sourceAssetId=String(collected.sourceAssetId)
      console.log('[CONTINUITY] SOURCE COLLECT PASS', JSON.stringify({sourceAssetId,bytes:collected?.source?.bytes||null}))

      const playRes=await fetch(apiBase+'/api/story',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({taskType:'source_playback',sourceAssetId})
      })
      const play:any=await playRes.json().catch(()=>({}))
      if(!playRes.ok || !play?.playbackUrl) throw new Error('source playback signing failed')
      const media=await fetch(play.playbackUrl,{headers:{Range:'bytes=0-1023'}})
      if(!(media.status===200 || media.status===206)) throw new Error('signed playback GET failed: '+media.status)
      await media.body?.cancel()
      console.log('[CONTINUITY] PLAYBACK PASS', JSON.stringify({status:media.status}))

      const frameRes=await fetch(apiBase+'/api/story',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({taskType:'source_frame',sourceAssetId,second:0.5})
      })
      const frame=Buffer.from(await frameRes.arrayBuffer())
      if(!frameRes.ok || !String(frameRes.headers.get('content-type')||'').includes('image/jpeg') || frame.length<1000) {
        throw new Error('source frame failed: '+frameRes.status)
      }
      console.log('[CONTINUITY] FRAME PASS', JSON.stringify({bytes:frame.length}))
    }
  }
}

main().catch((e)=>{ console.error('[R2_SMOKE] FAIL', e?.stack||e); process.exit(1) })
