// Durable record of one paid provider call, kept in the shared JobBlobStore (same atomic create-once `claim` the single-use
// approvals and the TTS flight use). It answers, for the SAME request after a lost response / restart / another instance:
//  - done         -> the stored result can be returned without calling (and paying) the provider again
//  - in_progress  -> another request owns it right now (nothing is repeated)
//  - unknown      -> the provider may already have processed and billed it, but there is no result: NO automatic repeat
//  - free         -> nothing is pending (or the earlier attempt was answered with an error, so nothing was generated): a new attempt may start
// Paths: <base>.g<N>.json (claim, create-once) and <base>.g<N>.result.json (outcome, written by the owner).
import type { JobBlobStore } from '../jobs/blobs.js'

export const FLIGHT_STALE_MS = 5 * 60_000
const MAX_GENERATIONS = 8
export type FlightState = { state: 'free'; gen: number } | { state: 'done'; result: any } | { state: 'in_progress' } | { state: 'unknown'; reason: string }

async function retry3(fn: () => Promise<unknown>): Promise<boolean> {
  for (let i = 0; i < 3; i++) { try { await fn(); return true } catch { if (i < 2) await new Promise((r) => setTimeout(r, 150 * (i + 1))) } }
  return false
}

export async function readFlight(blobs: JobBlobStore, base: string, o: { now?: number; staleMs?: number } = {}): Promise<FlightState> {
  const now = o.now ?? Date.now(), staleMs = o.staleMs ?? FLIGHT_STALE_MS
  for (let gen = 0; gen < MAX_GENERATIONS; gen++) {
    const claim: any = await blobs.getJson(`${base}.g${gen}.json`)
    if (!claim) return { state: 'free', gen }
    const r: any = await blobs.getJson(`${base}.g${gen}.result.json`).catch(() => null)
    if (r?.status === 'failed_safe') continue // answered with an error: nothing was generated, the next attempt is allowed
    if (r?.status === 'done') return { state: 'done', result: r }
    if (r) return { state: 'unknown', reason: String(r.status) }
    if (now - Number(claim.startedAt ?? 0) > staleMs) return { state: 'unknown', reason: 'owner_vanished' }
    return { state: 'in_progress' }
  }
  return { state: 'unknown', reason: 'too_many_attempts' }
}

// Atomic: exactly one of several concurrent callers (any instance) gets true for a generation.
export async function claimFlight(blobs: JobBlobStore, base: string, gen: number): Promise<boolean> {
  if (!blobs.claim) throw new Error('flight store cannot claim atomically')
  return blobs.claim(`${base}.g${gen}.json`, { startedAt: Date.now(), gen })
}

export const recordFlight = (blobs: JobBlobStore, base: string, gen: number, value: Record<string, unknown>) =>
  retry3(() => blobs.putJson(`${base}.g${gen}.result.json`, { ...value, at: new Date().toISOString() }, { overwrite: true }))
export { retry3 as retryStore }
