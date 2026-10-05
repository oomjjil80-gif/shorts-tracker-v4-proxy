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
}

main().catch((e)=>{ console.error('[R2_SMOKE] FAIL', e?.stack||e); process.exit(1) })
