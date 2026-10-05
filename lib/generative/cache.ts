export type CachedAssetMeta = { ref?: string | null; sha256?: string | null }

export function cacheEntryIsCanonical(entry: CachedAssetMeta | null | undefined, ref: string, digest: string): boolean {
  return !!entry && entry.ref === ref && (!entry.sha256 || entry.sha256 === digest)
}
