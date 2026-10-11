// A read-only-from-manuscript, zero-provider route to salvage an already FAILED Odyssey PLAN.
// The phone uploads the locally saved, human-corrected ChatGPT recovery package.
// Do not restart PLAN or ASSET: the store parks the SAME job after recording a successful manual PLAN.
import { sleepClassicOutline, splitSleepParagraphs, SLEEP_CHAPTERS, SLEEP_CLASSIC_ID } from '../generative/sleepClassic.js'
import { validateLongformScript, type LongformBrief, type LongformScript } from '../generative/longform.js'
import { sha256 } from './blobs.js'

export const SLEEP_OFFLINE_RECOVERY_SCHEMA = 'odyssey-salvage/1'
export type SleepOfflineImport = {
  schema: string
  source_job_id: string
  chapters: Array<{ index: number; repaired_text: string; original_text?: string }>
}
const description = [
  '낯선 섬으로 떠밀려 간 오디세우스가 외눈박이 거인을 만났습니다. 그가 지혜롭게 선택한 거짓 이름에는 뜻밖의 탈출 방법이 숨어 있습니다.',
  '호메로스의 고전 오디세이아 제9권을 바탕으로 항해와 동굴에서 벌어진 일을 조용한 목소리로 풀어냅니다. 거인의 집을 둘러싼 위협, 동료들과 함께 준비한 꾀, 멀어지는 섬을 향해 터뜨린 외침이 하나의 이야기로 이어집니다.',
  '검은 정지 화면과 차분한 낭독으로 듣는 수면용 고전 이야기입니다. 시간이나 분량을 억지로 늘리지 않고 사건의 흐름에 따라 자연스럽게 끝맺습니다.'
].join(' ')
export const SLEEP_RECOVERY_METADATA = {
  description,
  tags: ['호메로스', '그리스신화', '이타카', '키클롭스', '폴리페모스', '파이아케스', '로토파고이', '고대그리스', '수면오디오북'],
  hashtags: ['#오디세이아', '#고대그리스', '#고전낭독', '#키클롭스'],
  pinnedComment: '오디세우스가 폴리페모스 앞에서 자신의 이름을 아무도 아니다라고 밝혔을 때, 여러분은 동료를 지키기 위해 어떤 선택을 하셨을 것 같으신가요?'
}
export function makeSavedOdysseyScript(payload: unknown, expectedJobId: string, brief: LongformBrief): LongformScript {
  const v = payload as SleepOfflineImport | null
  if (brief?.profile !== 'wisdom_longform' || brief?.sleepClassic !== SLEEP_CLASSIC_ID) throw new Error('NOT_SLEEP_CLASSIC')
  if (!v || v.schema !== SLEEP_OFFLINE_RECOVERY_SCHEMA || v.source_job_id !== expectedJobId) throw new Error('RECOVERY_JOB_MISMATCH')
  if (!Array.isArray(v.chapters) || v.chapters.length !== SLEEP_CHAPTERS.length) throw new Error('RECOVERY_CHAPTER_COUNT')
  if (JSON.stringify(v).length > 500_000) throw new Error('RECOVERY_TOO_LARGE')
  const seen = new Set<number>()
  const sections = v.chapters.map((ch) => {
    if (!ch || !Number.isInteger(ch.index) || ch.index < 1 || ch.index > SLEEP_CHAPTERS.length || seen.has(ch.index))
      throw new Error('RECOVERY_CHAPTER_INDEX')
    seen.add(ch.index)
    const text = String(ch.repaired_text || '').replace(/\r/g, '').trim()
    // Preserve the user's existing original text, never replace it with generated filler.
    if (text.length < 100 || text.length > 30_000) throw new Error('RECOVERY_CHAPTER_INVALID')
    return { id: 's' + ch.index, sentences: splitSleepParagraphs(text.split(/\n{2,}/).filter(Boolean)) }
  })
  if (sections.some((c, i) => c.id !== 's' + (i + 1))) throw new Error('RECOVERY_CHAPTER_ORDER')
  const outline = sleepClassicOutline()
  const script: LongformScript = {
    schema: 'wisdom-longform-script/1', sleepClassic: 'odyssey-cyclops-v1',
    title: '왜 오디세우스는 아무도 아니다라고 했을까? | 오디세이아 수면 이야기',
    hook: outline.hook, figure: outline.figure, thumbnail: outline.thumbnail,
    sections, metadata: SLEEP_RECOVERY_METADATA
  }
  const errors = validateLongformScript(script, brief)
  if (errors.length) throw new Error('RECOVERY_SCRIPT_INVALID: ' + errors.slice(0,12).join(', '))
  return script
}
export const offlineOdysseyFingerprint = (script: LongformScript) => sha256(JSON.stringify(script))
