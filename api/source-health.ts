import type { VercelRequest, VercelResponse } from '@vercel/node'

export default function handler(_req: VercelRequest, res: VercelResponse) {
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
