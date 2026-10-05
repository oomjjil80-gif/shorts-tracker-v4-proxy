import { get, list, put } from './objectStorage.js'
import { randomUUID } from 'node:crypto'

export type SourceAssetInput = {
  id: string; platform: string; originalUrl: string; blobPath: string;
  filename: string; bytes: number; contentType: string; blobUrl: string | null;
  duration: number; width: number; height: number; collectedAt: string;
  sha256: string; videoCodec: string; audioCodec: string | null;
  title?: string; videoId?: string; resolver?: string; resolveMs?: number;
}
export type SourceAsset = SourceAssetInput & { sourceAssetId: string; createdAt: string; schemaVersion: 1 }
const defaults = { get, list, put, env: process.env }
type Dependencies = typeof defaults
const ID = /^src_\d{13}_[a-f0-9]{32}$/

function prefix(env: NodeJS.ProcessEnv) {
  // Preview collections must not replace the production workspace's latest source.
  const scope = env.VERCEL_ENV === 'preview' ? 'preview' : env.VERCEL_ENV === 'development' ? 'development' : 'production'
  return `source-assets/v1/${scope}/`
}
export function registryPath(sourceAssetId: string, env: NodeJS.ProcessEnv = process.env) {
  if (!ID.test(sourceAssetId)) throw Object.assign(new Error('Invalid sourceAssetId'), { code: 'INVALID_SOURCE_ASSET_ID', status: 400 })
  return prefix(env) + sourceAssetId + '.json'
}
export function createSourceAssetId(now = Date.now()) {
  // Blob list() is lexicographic: an inverted, fixed-width timestamp puts newest
  // records first without a shared mutable index or a lost-update race.
  return `src_${String(9999999999999 - now).padStart(13, '0')}_${randomUUID().replaceAll('-', '')}`
}
export async function registerSourceAsset(source: SourceAssetInput, deps: Dependencies = defaults): Promise<SourceAsset> {
  const now = Date.now()
  const asset: SourceAsset = { ...source, sourceAssetId: createSourceAssetId(now), createdAt: new Date(now).toISOString(), schemaVersion: 1 }
  try {
    await deps.put(registryPath(asset.sourceAssetId, deps.env), JSON.stringify(asset), {
      access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json'
    })
  } catch {
    // Never report collection success when the durable record is missing.
    throw Object.assign(new Error('Source Asset Registry could not be saved'), { code: 'SOURCE_REGISTRY_WRITE_FAILED', status: 503 })
  }
  return asset
}
export async function getSourceAsset(sourceAssetId: string, deps: Dependencies = defaults): Promise<SourceAsset> {
  const path = registryPath(sourceAssetId, deps.env)
  const result = await deps.get(path, { access: 'private', useCache: false })
  if (!result) throw Object.assign(new Error('Source asset not found'), { code: 'SOURCE_ASSET_NOT_FOUND', status: 404 })
  if (result.statusCode !== 200 || result.blob.size > 65536) throw new Error('Invalid Source Asset Registry record')
  const asset = await new Response(result.stream).json() as SourceAsset
  if (asset.schemaVersion !== 1 || asset.sourceAssetId !== sourceAssetId || !asset.blobPath?.startsWith('source-collector/')) {
    throw new Error('Invalid Source Asset Registry record')
  }
  return asset
}
export async function listSourceAssets(options: { limit?: unknown; cursor?: unknown } = {}, deps: Dependencies = defaults) {
  const limit = options.limit === undefined ? 10 : Number(options.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Object.assign(new Error('limit must be an integer from 1 to 50'), { status: 400 })
  const cursor = options.cursor === undefined ? undefined : String(options.cursor)
  if (cursor && cursor.length > 2048) throw Object.assign(new Error('Invalid cursor'), { status: 400 })
  const page = await deps.list({ prefix: prefix(deps.env), limit, ...(cursor ? { cursor } : {}) })
  const sources = await Promise.all(page.blobs.map(blob => {
    const id = blob.pathname.slice(prefix(deps.env).length).replace(/\.json$/, '')
    return getSourceAsset(id, deps)
  }))
  return { source: sources[0] || null, sources, hasMore: page.hasMore, cursor: page.cursor || null }
}
