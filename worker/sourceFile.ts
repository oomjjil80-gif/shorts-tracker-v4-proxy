import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StageError, type SourceAssetLike, type SourceFile } from './types.js'

// Streams the registered private Blob to disk and proves it is the registered file (sha256) before any stage uses it.
export function createBlobSourceFileResolver(get: (path: string, opts: any) => Promise<any>) {
  return async function resolveSourceFile(asset: SourceAssetLike): Promise<SourceFile> {
    if (!asset.blobPath?.startsWith('source-collector/')) throw new StageError('SOURCE_PATH_INVALID', 'source blobPath is outside source-collector/')
    const result = await get(asset.blobPath, { access: 'private' })
    if (!result || result.statusCode !== 200 || !result.stream) throw new StageError('SOURCE_BLOB_NOT_FOUND', `source blob not found: ${asset.sourceAssetId}`, true)
    const dir = await mkdtemp(join(tmpdir(), 'tracker-src-'))
    const path = join(dir, 'source.mp4')
    const hash = createHash('sha256')
    try {
      const body = Readable.fromWeb(result.stream as any)
      body.on('data', (c: Buffer) => hash.update(c))
      await pipeline(body, createWriteStream(path))
    } catch (e: any) {
      await rm(dir, { recursive: true, force: true })
      throw new StageError('SOURCE_DOWNLOAD_FAILED', String(e?.message || e), true)
    }
    const actual = hash.digest('hex')
    if (asset.sha256 && actual !== asset.sha256) {
      await rm(dir, { recursive: true, force: true })
      throw new StageError('SOURCE_HASH_MISMATCH', `source bytes (${actual.slice(0, 12)}…) differ from the registered sha256`)
    }
    return { path, cleanup: () => rm(dir, { recursive: true, force: true }) }
  }
}
