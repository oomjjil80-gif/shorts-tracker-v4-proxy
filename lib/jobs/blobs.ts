import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
// canonicalize() comes from the shared compiler so plan/manifest addresses are stable across repos.
import { canonicalize } from '../tracker-core/renderManifest.js'
import * as objectStorage from '../objectStorage.js'

export interface JobBlobStore {
  // Create-once by default. `overwrite` is only for the few mutable POINTERS (e.g. generative-sources/<id>.json); without
  // it an existing path is kept and the call still "succeeds", which silently froze rerun outputs.
  putJson(path: string, value: unknown, opts?: { overwrite?: boolean }): Promise<{ path: string; sha256: string }>
  getJson<T = unknown>(path: string): Promise<T | null>
  // Binary artifacts (rendered MP4, contact sheets). Content-addressed by the caller; never overwritten.
  putBytes(path: string, bytes: Buffer, contentType: string): Promise<{ path: string; sha256: string; bytes: number }>
  getBytes(path: string): Promise<Buffer | null>
  // A large file on disk (e.g. a 60-120+ minute final MP4): hashed and uploaded as a STREAM, never read whole into
  // memory. Create-once like putBytes: an existing path (a retry of the same content) is not uploaded again.
  putFile(path: string, filePath: string, contentType: string): Promise<{ path: string; bytes: number; uploaded: boolean }>
  // The other way: a large blob (e.g. a rendered longform segment) STREAMED to a file on disk; false when it is not there.
  getFile?(path: string, filePath: string): Promise<boolean>
  // Short-lived URL a browser can play (private blobs only; never stored, never part of any hash).
  presign?(path: string, validForMs?: number): Promise<{ url: string; validUntil: number } | null>
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
// sha256 of a file, streamed (constant memory whatever the size)
export async function sha256File(filePath: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) h.update(chunk as Buffer)
  return h.digest('hex')
}

// Content-addressed: same value => same path. Immutable by construction (never overwritten).
export async function putAddressed(store: JobBlobStore, prefix: string, value: unknown): Promise<{ path: string; sha256: string }> {
  const hash = sha256(canonicalize(value))
  return store.putJson(`${prefix}/${hash}.json`, value)
}

export function createMemoryBlobStore(): JobBlobStore & { files: Map<string, string>; binaries: Map<string, Buffer> } {
  const files = new Map<string, string>()
  const binaries = new Map<string, Buffer>()
  return {
    files, binaries,
    async putBytes(path, bytes) { if (!binaries.has(path)) binaries.set(path, Buffer.from(bytes)); return { path, sha256: sha256(binaries.get(path)!), bytes: binaries.get(path)!.length } },
    async getBytes(path) { const b = binaries.get(path); return b ? Buffer.from(b) : null },
    // test store only: keeps the bytes in memory (the real store streams)
    async putFile(path, filePath) { const had = binaries.has(path); if (!had) binaries.set(path, await readFile(filePath)); return { path, bytes: binaries.get(path)!.length, uploaded: !had } },
    async getFile(path, filePath) { const b = binaries.get(path); if (!b) return false; await writeFile(filePath, b); return true },
    async presign(path) { return binaries.has(path) || files.has(path) ? { url: `memory://${path}`, validUntil: Date.now() + 3_600_000 } : null },
    async putJson(path, value, opts) {
      const body = JSON.stringify(value)
      if (!files.has(path) || opts?.overwrite === true) files.set(path, body)
      return { path, sha256: sha256(files.get(path)!) }
    },
    async getJson(path) { const v = files.get(path); return v === undefined ? null : JSON.parse(v) }
  }
}

// Private Vercel Blob, create-once (allowOverwrite:false). "already exists" is success: the path is content-addressed.
export function createVercelJobBlobStore(deps?: { put?: any; get?: any; head?: any; issueSignedToken?: any; presignUrl?: any }): JobBlobStore {
  const lazy = async () => (deps?.put && deps?.get ? deps : objectStorage)
  const exists = async (path: string): Promise<boolean> => {
    const mod: any = await lazy()
    if (typeof mod.head === 'function') {
      try {
        const found = await mod.head(path)
        return Boolean(found)
      } catch (e: any) {
        const detail = `${String(e?.name || '')} ${String(e?.code || '')} ${String(e?.message || e)}`
        if (/BlobNotFound|not.?found|does not exist|404/i.test(detail)) return false
        throw e
      }
    }
    const result: any = await mod.get(path, { access: 'private', useCache: false })
    if (!result || result.statusCode === 404) return false
    if (result.statusCode !== 200) throw new Error(`Blob existence check failed: ${result.statusCode}`)
    try { await result.stream?.cancel?.() } catch {}
    return true
  }
  return {
    async putJson(path, value, opts) {
      const body = JSON.stringify(value)
      const overwrite = opts?.overwrite === true
      if (!overwrite && await exists(path)) return { path, sha256: sha256(body) }
      const { put } = await lazy()
      try {
        await put(path, body, { access: 'private', addRandomSuffix: false, allowOverwrite: overwrite, contentType: 'application/json' })
      } catch (e: any) {
        if (overwrite || !/already exists|exists/i.test(String(e?.message || e))) throw e
      }
      return { path, sha256: sha256(body) }
    },
    async getJson(path) {
      const { get } = await lazy()
      const result: any = await get(path, { access: 'private', useCache: false })
      if (!result || result.statusCode !== 200 || !result.stream) return null
      return JSON.parse(await new Response(result.stream).text())
    },
    async putBytes(path, bytes, contentType) {
      const digest = sha256(bytes)
      if (await exists(path)) return { path, sha256: digest, bytes: bytes.length }
      const { put } = await lazy()
      try {
        await put(path, bytes, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType })
      } catch (e: any) {
        if (!/already exists|exists/i.test(String(e?.message || e))) throw e
      }
      return { path, sha256: digest, bytes: bytes.length }
    },
    async putFile(path, filePath, contentType) {
      const { size } = await stat(filePath)
      if (await exists(path)) return { path, bytes: size, uploaded: false }
      const mod: any = await lazy()
      if (typeof mod.putFile !== 'function') throw new Error('this object store cannot stream files')
      await mod.putFile(path, filePath, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType })
      return { path, bytes: size, uploaded: true }
    },
    async getBytes(path) {
      const { get } = await lazy()
      const result: any = await get(path, { access: 'private', useCache: false })
      if (!result || result.statusCode !== 200 || !result.stream) return null
      return Buffer.from(await new Response(result.stream).arrayBuffer())
    },
    async getFile(path, filePath) {
      const { get } = await lazy()
      const result: any = await get(path, { access: 'private', useCache: false })
      if (!result || result.statusCode !== 200 || !result.stream) return false
      try { await pipeline(Readable.fromWeb(result.stream), createWriteStream(filePath)) } catch (e) { await rm(filePath, { force: true }); throw e }
      return true
    },
    async presign(path, validForMs = 60 * 60 * 1000) {
      const mod: any = await lazy()
      if (typeof mod.presign === 'function') return mod.presign(path, validForMs)
      if (!mod.issueSignedToken || !mod.presignUrl) return null
      const token = await mod.issueSignedToken({ pathname: path, operations: ['get'] })
      const validUntil = Date.now() + validForMs
      const signed = await mod.presignUrl(token, { pathname: path, operation: 'get', validUntil, access: 'private' })
      return { url: signed.presignedUrl, validUntil }
    }
  }
}
