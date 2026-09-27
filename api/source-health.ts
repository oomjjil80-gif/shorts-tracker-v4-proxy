import type { Request, Response } from 'express'

export default function handler(_req: Request, res: Response) {
  const cobaltConfigured = Boolean(String(process.env.COBALT_API_URL || '').trim())
  const blobConfigured = Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID)
  return res.status(cobaltConfigured && blobConfigured ? 200 : 503).json({
    ok:cobaltConfigured && blobConfigured,
    service:'Tracker Source Collector',
    cobaltConfigured,
    blobConfigured,
    supported:['instagram','tiktok','reddit','x','youtube','facebook','bilibili','xiaohongshu']
  })
}
