// Read-only recovery of the already-paid Odyssey script checkpoints.
// No calls to providers and no writes to R2. Require caller to check workspace ownership.
import { sha256, type JobBlobStore } from './blobs.js'
import { SLEEP_CHAPTERS, SLEEP_INTRO } from '../generative/sleepClassic.js'
const PLAN_VERSION = 'longform-sections/2-research'
type Sentence = { say?: string }
export type SavedChapter = { chapter: number; heading: string; originalText: string; repairs: Array<{ pass: number; text: string }>; source: string }
const textOf = (value: unknown): string => {
  if (!Array.isArray(value)) return ''
  return value.map((x: any) => typeof x === 'string' ? x : typeof x?.say === 'string' ? x.say : '').filter(Boolean).join(' ').trim()
}
export async function recoverSleepDraft(blobs: JobBlobStore, planRef: string) {
  const chapters: SavedChapter[] = []
  const missing: number[] = []
  const checkedVersions: string[] = []
  let reviewIssues: string[] = []
  for (const version of ['4', '3', '2', '1']) {
    const ck = `longform-plan-checkpoints/${sha256(`${planRef}|${PLAN_VERSION}|sleep-classic/${version}`)}`
    const saved = await Promise.all(SLEEP_CHAPTERS.map(async (c, i) => {
      const section: any = await blobs.getJson(`${ck}/section-${String(i + 1).padStart(3, '0')}.json`).catch(() => null)
      let originalText = textOf(section?.sentences)
      let source = 'section'
      if (!originalText) {
        const count = Math.max(1, Math.ceil(c.beats.length / 2))
        const parts = await Promise.all(Array.from({length:count}, (_, p) => blobs.getJson(`${ck}/sleep-chapter-${i + 1}-part-${p + 1}.json`).catch(() => null)))
        originalText = parts.map(textOf).filter(Boolean).join(' ')
        if (originalText && i === 0) originalText = SLEEP_INTRO + ' ' + originalText
        source = 'saved parts'
      }
      const repairs: Array<{pass:number;text:string}> = []
      for (let pass = 1; pass <= 4; pass++) {
        const saved: any = await blobs.getJson(`${ck}/sleep-repair-v${pass}-chapter-${i + 1}.json`).catch(() => null)
        const txt = textOf(saved?.sentences)
        if (txt) repairs.push({pass,text:txt})
      }
      return originalText ? {chapter:i + 1,heading:c.heading,originalText,repairs,source} : null
    }))
    const found = saved.filter((x): x is NonNullable<typeof x> => !!x)
    if (found.length) {
      chapters.push(...found)
      checkedVersions.push(version)
      const r: any = await blobs.getJson(`${ck}/sleep-quality.json`).catch(() => null)
      if (Array.isArray(r?.issues)) reviewIssues = r.issues.map(String)
      break
    }
  }
  for (let i=1; i<=SLEEP_CHAPTERS.length; i++) if (!chapters.some(c=>c.chapter===i)) missing.push(i)
  return {schema:'sleep-draft-recovery/1',title:'잠들기 전 듣는 오디세이아 | 아무도 아니다, 외눈박이 거인의 동굴 (1편)',
    chapters,missing,found:chapters.length,total: SLEEP_CHAPTERS.length,reviewIssues,checkedVersions,
    readOnly:true,paidCalls:0}
}
