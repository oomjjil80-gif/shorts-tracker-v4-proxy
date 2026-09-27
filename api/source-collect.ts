import type { Request, Response } from 'express'
import { put } from '@vercel/blob'
import { randomUUID } from 'node:crypto'

// Source Collector v1 — URL to Tracker source asset\nconst ALLOWED_HOSTS = new Set([
  'instagram.com','www.instagram.com',
  'tiktok.com','www.tiktok.com','vm.tiktok.com',
  'reddit.com','www.reddit.com','v.redd.it',
  'x.com','www.x.com','twitter.com','www.twitter.com',
  'youtube.com','www.youtube.com','youtu.be',
  'facebook.com','www.facebook.com','fb.watch',
  'bilibili.com','www.bilibili.com',
  'xiaohongshu.com','www.xiaohongshu.com'
])

function cors(req: Request, res: Response) {
  const origin = String(req.headers.origin || '')
  if (/^https:\/\/shorts-production-tracker(?:-[a-z0-9-]+)?\.vercel\.app$/i.test(origin) ||
      /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept')
}

function safeSourceUrl(raw: unknown) {
  const value = String(raw || '').trim()
  if (!value) throw new Error('sourceUrl is required')
  const u = new URL(value)
  const host = u.hostname.toLowerCase()
  if (!ALLOWED_HOSTS.has(host)) throw new Error('unsupported source host')
  return u.toString()
}

function cleanFilename(name: unknown) {
  const fallback = 'source-' + randomUUID() + '.mp4'
  const s = String(name || fallback).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 160)
  return s || fallback
}

async function fetchMedia(url: string, authHeader: string | undefined) {
  const headers: Record<string,string> = { Accept: '*/*' }
  if (authHeader) headers.Authorization = authHeader
  const r = await fetch(url, { headers, redirect: 'follow' })
  if (!r.ok || !r.body) throw new Error('media fetch failed: ' + r.status)
  const len = Number(r.headers.get('content-length') || 0)
  const max = Number(process.env.SOURCE_COLLECTOR_MAX_BYTES || 150 * 1024 * 1024)
  if (len && len > max) throw new Error('source media exceeds size limit')
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length > max) throw new Error('source media exceeds size limit')
  return { buf, contentType: r.headers.get('content-type') || 'video/mp4' }
}

export default async function handler(req: Request, res: Response) {
  cors(req,res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error:{ message:'POST required' } })

  const cobaltBase = String(process.env.COBALT_API_URL || '').trim().replace(/\/$/,'')
  if (!cobaltBase) return res.status(503).json({ error:{ code:'COLLECTOR_NOT_CONFIGURED', message:'COBALT_API_URL is not configured' } })

  try {
    const sourceUrl = safeSourceUrl(req.body?.sourceUrl)
    const cobaltHeaders: Record<string,string> = { 'Accept':'application/json', 'Content-Type':'application/json' }
    const cobaltKey = String(process.env.COBALT_API_KEY || '').trim()
    if (cobaltKey) cobaltHeaders.Authorization = 'Api-Key ' + cobaltKey

    const cr = await fetch(cobaltBase + '/', {
      method:'POST',
      headers:cobaltHeaders,
      body:JSON.stringify({
        url:sourceUrl,
        downloadMode:'auto',
        videoQuality:String(req.body?.videoQuality || '1080'),
        filenameStyle:'basic',
        youtubeVideoCodec:'h264'
      })
    })
    const raw = await cr.text()
    let data:any = {}
    try { data = raw ? JSON.parse(raw) : {} } catch {}
    if (!cr.ok || data?.status === 'error') {
      return res.status(cr.status >= 400 ? cr.status : 502).json({ error:{ code:'COBALT_ERROR', message:data?.error?.code || data?.error?.message || raw || 'cobalt request failed' } })
    }

    if (data?.status === 'picker') {
      return res.status(200).json({ ok:true, needsSelection:true, sourceUrl, picker:data })
    }
    if (!['tunnel','redirect'].includes(data?.status) || !data?.url) {
      return res.status(502).json({ error:{ code:'UNEXPECTED_COBALT_RESPONSE', message:'No downloadable media URL returned' }, cobalt:data })
    }

    const media = await fetchMedia(String(data.url), cobaltKey ? ('Api-Key ' + cobaltKey) : undefined)
    const filename = cleanFilename(data.filename)
    const id = randomUUID()
    const path = 'source-collector/' + new Date().toISOString().slice(0,10) + '/' + id + '-' + filename
    const blob:any = await put(path, media.buf, {
      access:'private',
      addRandomSuffix:false,
      contentType:media.contentType
    })

    return res.status(200).json({
      ok:true,
      needsSelection:false,
      source:{
        id,
        originalUrl:sourceUrl,
        platform:new URL(sourceUrl).hostname,
        filename,
        bytes:media.buf.length,
        contentType:media.contentType,
        blobPath:path,
        blobUrl:blob.url || null,
        collectedAt:new Date().toISOString()
      }
    })
  } catch (e:any) {
    return res.status(400).json({ error:{ code:'SOURCE_COLLECT_FAILED', message:e?.message || String(e) } })
  }
}
