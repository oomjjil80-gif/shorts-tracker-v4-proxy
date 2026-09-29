import { createHash } from 'node:crypto'
// canonicalize() comes from the shared compiler so plan/manifest addresses are stable across repos.
import { canonicalize } from '../tracker-core/renderManifest.js'

export interface JobBlobStore {
  putJson(path: string, value: unknown): Promise<{ path: string; sha256: string }>
  getJson<T = unknown>(path: string): Promise<T | null>
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

// Content-addressed: same value => same path. Immutable by construction (never overwritten).
export async function putAddressed(store: JobBlobStore, prefix: string, value: unknown): Promise<{ path: string; sha256: string }> {
  const hash = sha256(canonicalize(value))
  return store.putJson(`${prefix}/${hash}.json`, value)
}

export function createMemoryBlobStore(): JobBlobStore & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    async putJson(path, value) {
      const body = JSON.stringify(value)
      if (!files.has(path)) files.set(path, body)
      return { path, sha256: sha256(files.get(path)!) }
    },
    async getJson(path) { const v = files.get(path); return v === undefined ? null : JSON.parse(v) }
  }
}

// Private Vercel Blob, create-once (allowOverwrite:false). "already exists" is success: the path is content-addressed.
export function createVercelJobBlobStore(deps?: { put?: any; get?: any }): JobBlobStore {
  const lazy = async () => (deps?.put && deps?.get ? { put: deps.put, get: deps.get } : await import('@vercel/blob'))
  return {
    async putJson(path, value) {
      const { put } = await lazy()
      const body = JSON.stringify(value)
      try {
        await put(path, body, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json' })
      } catch (e: any) {
        if (!/already exists|exists/i.test(String(e?.message || e))) throw e
      }
      return { path, sha256: sha256(body) }
    },
    async getJson(path) {
      const { get } = await lazy()
      const result: any = await get(path, { access: 'private', useCache: false })
      if (!result || result.statusCode !== 200 || !result.stream) return null
      return JSON.parse(await new Response(result.stream).text())
    }
  }
}
