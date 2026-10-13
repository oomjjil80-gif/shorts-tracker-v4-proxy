// 제작 6단계: 제목·썸네일 "약속"(Title Promise)을 먼저 잠그고, 그 약속이 Claude 집필 → GPT 검수 → 구간 수정 → 최종 확인까지
// 같은 식별자(promiseId)로 이어지게 하는 순수 함수 모음. 모델 호출 없음(결정적), 기존 STORY DNA/PLAN/QC는 그대로 두고 옵트인으로만 붙는다.
import { createHash } from 'node:crypto'

export const PROMISE_SCHEMA = 'title-promise/1'
export type TitlePromise = {
  schema: typeof PROMISE_SCHEMA
  promiseId: string
  title: string
  thumbnail: { concept: string; lines: string[] }
  coreEvent: string // 제목·썸네일이 약속하는 실제 핵심 사건
  mustShow: string[] // 대본·최종 영상이 반드시 보여줘야 하는 핵심 단어/장면
  approvedAt: string
}
export const PROMISE_CATEGORIES = ['title_promise', 'originality', 'repeat_video', 'immersion', 'thumbnail_overclaim'] as const
const PROMISE_CATS = new Set<string>(PROMISE_CATEGORIES)
export const isPromiseCategory = (c: unknown) => PROMISE_CATS.has(String(c))

const norm = (s: unknown) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
const idOf = (p: Pick<TitlePromise, 'title' | 'thumbnail' | 'coreEvent' | 'mustShow'>) =>
  'tp_' + createHash('sha256').update(JSON.stringify([p.title, p.thumbnail.concept, p.thumbnail.lines, p.coreEvent, p.mustShow])).digest('hex').slice(0, 24)

// 사용자가 제목·썸네일을 승인할 때 호출: 검증 후 잠그고 식별자를 만든다.
export function lockTitlePromise(input: any, now: Date = new Date()): { ok: true; promise: TitlePromise } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const title = clean(input?.title), concept = clean(input?.thumbnail?.concept), coreEvent = clean(input?.coreEvent)
  const lines = (Array.isArray(input?.thumbnail?.lines) ? input.thumbnail.lines : []).map(clean).filter(Boolean)
  const mustShow = [...new Set((Array.isArray(input?.mustShow) ? input.mustShow : []).map(clean).filter(Boolean))] as string[]
  if (title.length < 4 || title.length > 80) errors.push('title must be 4~80 characters')
  if (!concept) errors.push('thumbnail.concept is required')
  if (lines.length < 1 || lines.length > 3 || lines.some((l: string) => l.length > 24)) errors.push('thumbnail.lines must be 1~3 lines of at most 24 characters')
  if (coreEvent.length < 8) errors.push('coreEvent (the real event the title/thumbnail promise) is required')
  if (mustShow.length < 1 || mustShow.length > 5 || mustShow.some((m) => m.length < 2 || m.length > 30)) errors.push('mustShow must be 1~5 terms of 2~30 characters')
  // 약속은 눈에 보이는 곳(제목·썸네일)에 있어야 한다: 핵심 단어가 하나도 드러나지 않으면 "약속"이 아니다
  const visible = norm(`${title} ${concept} ${lines.join(' ')}`)
  if (!errors.length && !mustShow.some((m) => visible.includes(norm(m)))) errors.push('no mustShow term appears in the title or thumbnail: the promise must name the core event')
  if (errors.length) return { ok: false, errors }
  const base = { title, thumbnail: { concept, lines }, coreEvent, mustShow }
  return { ok: true, promise: { schema: PROMISE_SCHEMA, promiseId: idOf(base), ...base, approvedAt: now.toISOString() } }
}

// 어디서 받든(브라우저 저장본 포함) 내용과 식별자가 일치해야 "승인된 약속"으로 인정한다.
export function verifyPromise(p: any): p is TitlePromise {
  if (!p || p.schema !== PROMISE_SCHEMA || typeof p.promiseId !== 'string') return false
  const again = lockTitlePromise(p, new Date(0))
  return again.ok && again.promise.promiseId === p.promiseId
}

export function promiseBrief(p: TitlePromise): string {
  return [
    `[승인된 제목·썸네일 약속 — promiseId ${p.promiseId}]`,
    `제목(변경 금지): ${p.title}`,
    `썸네일 문구: ${p.thumbnail.lines.join(' / ')}`,
    `썸네일 콘셉트: ${p.thumbnail.concept}`,
    `약속한 핵심 사건: ${p.coreEvent}`,
    `반드시 보여줄 것: ${p.mustShow.join(', ')}`,
    '대본은 이 약속을 실제로 이행해야 한다. 제목을 바꾸지 말고, 약속한 핵심 사건을 훅에서 예고하고 본문에서 보여주며, 과장하거나 다른 사건으로 바꾸지 말라.'
  ].join('\n')
}

// ── 대본 구조 헬퍼 (기존 Claude longform draft 형태: title, hook, chapters[{chapterNo,segments[{text,visualHint,factStatus}]}], ending{text})
export const scriptText = (draft: any): string => [draft?.hook, ...(Array.isArray(draft?.chapters) ? draft.chapters : []).flatMap((c: any) => (Array.isArray(c?.segments) ? c.segments : []).map((s: any) => s?.text)), draft?.ending?.text].filter(Boolean).join('\n')

export type QcIssue = { severity: string; category: string; location: string; claim: string; evidence: string; problem: string; recommendation: string }
const issue = (category: string, location: string, problem: string, recommendation: string, evidence = ''): QcIssue => ({ severity: 'required', category, location, claim: problem, evidence, problem, recommendation })

// 모델 없이 확인되는 것만: 제목 유지, 약속한 핵심 단어가 대본에 존재하는지.
export function checkDraftAgainstPromise(draft: any, p: TitlePromise): QcIssue[] {
  const out: QcIssue[] = []
  if (norm(draft?.title) !== norm(p.title)) out.push(issue('title_promise', 'title', `대본 제목이 승인된 제목과 다릅니다: "${clean(draft?.title)}"`, '제목은 승인된 제목으로 되돌립니다(자동).', p.title))
  const body = norm(scriptText(draft))
  for (const term of p.mustShow) if (!body.includes(norm(term))) out.push(issue('title_promise', 'hook', `약속한 핵심 장면/단어 "${term}"이 대본에 없습니다.`, `훅이 "${p.coreEvent}"를 예고하고 본문이 "${term}"을 실제로 보여주도록 수정합니다.`, term))
  return out
}

// ── 구간 매핑 / 부분 수정 ─────────────────────────────────────────────
export type Target = { key: string; kind: 'hook' | 'ending' | 'segment'; chapterNo?: number; index?: number }
const segKey = (chapterNo: number, index: number) => `c${chapterNo}s${index + 1}`

// QC의 location 문자열("chapter 2 / segment 3", "hook", "ending", "chapter 2")을 구간 목록으로 바꾼다. 해석 불가면 null.
export function parseLocation(location: string, draft: any): Target[] | null {
  const loc = String(location || '').trim().toLowerCase()
  const chapters: any[] = Array.isArray(draft?.chapters) ? draft.chapters : []
  if (/^(hook|훅)/.test(loc)) return [{ key: 'hook', kind: 'hook' }]
  if (/^(ending|엔딩|마무리)/.test(loc)) return [{ key: 'ending', kind: 'ending' }]
  const m = /chapter\s*(\d+)\s*\/\s*segment\s*(\d+)/.exec(loc)
  if (m) {
    const ch = chapters.find((c) => Number(c?.chapterNo) === Number(m[1])), idx = Number(m[2]) - 1
    if (!ch || !Array.isArray(ch.segments) || idx < 0 || idx >= ch.segments.length) return null
    return [{ key: segKey(Number(m[1]), idx), kind: 'segment', chapterNo: Number(m[1]), index: idx }]
  }
  const c = /^chapter\s*(\d+)\s*$/.exec(loc)
  if (c) {
    const ch = chapters.find((x) => Number(x?.chapterNo) === Number(c[1]))
    if (!ch || !Array.isArray(ch.segments) || !ch.segments.length) return null
    return ch.segments.map((_: any, i: number) => ({ key: segKey(Number(c[1]), i), kind: 'segment' as const, chapterNo: Number(c[1]), index: i }))
  }
  return null
}

const FIXABLE = new Set(['blocker', 'required'])
// 수정이 필요한 이슈(필수/블로커 + 약속 이슈)를 수정 대상 구간으로 매핑한다.
// 제목 이슈는 모델이 고치지 않는다(승인된 제목으로 결정적으로 복원). 구간으로 매핑되지 않는 이슈가 있으면 partial=false(전체 수정으로 폴백).
export function revisionTargets(issues: QcIssue[], draft: any): { targets: Target[]; titleRestore: boolean; unmapped: QcIssue[]; partial: boolean } {
  const byKey = new Map<string, Target>(), unmapped: QcIssue[] = []
  let titleRestore = false
  for (const it of Array.isArray(issues) ? issues : []) {
    if (!FIXABLE.has(String(it?.severity).toLowerCase())) continue
    if (String(it?.location).toLowerCase() === 'title') { titleRestore = true; continue }
    const t = parseLocation(it?.location, draft)
    if (!t) { unmapped.push(it); continue }
    for (const x of t) byKey.set(x.key, x)
  }
  const targets = [...byKey.values()]
  return { targets, titleRestore, unmapped, partial: unmapped.length === 0 && (targets.length > 0 || titleRestore) }
}

export const targetText = (draft: any, t: Target): string =>
  t.kind === 'hook' ? String(draft?.hook ?? '') : t.kind === 'ending' ? String(draft?.ending?.text ?? '') : String(draft?.chapters?.find((c: any) => Number(c?.chapterNo) === t.chapterNo)?.segments?.[t.index!]?.text ?? '')

// 모델이 돌려준 수정 조각(items: [{target,text,visualHint?,factStatus?}])을 지정된 구간에만 합친다. 그 밖의 구간·자산은 바이트 단위로 그대로 둔다.
export function mergePartial(original: any, items: any[], targets: Target[]): { draft: any; changed: string[]; ignored: string[] } {
  const draft = JSON.parse(JSON.stringify(original)), allowed = new Map(targets.map((t) => [t.key, t])), changed: string[] = [], ignored: string[] = []
  for (const it of Array.isArray(items) ? items : []) {
    const t = allowed.get(String(it?.target))
    const text = clean(it?.text)
    if (!t || !text) { ignored.push(String(it?.target)); continue }
    if (t.kind === 'hook') draft.hook = text
    else if (t.kind === 'ending') draft.ending = { ...(draft.ending ?? {}), text }
    else {
      const seg = draft.chapters.find((c: any) => Number(c.chapterNo) === t.chapterNo).segments[t.index!]
      seg.text = text
      if (typeof it.visualHint === 'string' && it.visualHint.trim()) seg.visualHint = it.visualHint.trim()
      if (['verified', 'interpretation', 'verify_before_publish'].includes(it.factStatus)) seg.factStatus = it.factStatus
    }
    changed.push(t.key)
  }
  return { draft, changed, ignored }
}

// 재검수 범위: 수정된 구간 + 같은 챕터의 앞뒤 구간(연결성) + 훅. 이 범위 밖의 이슈는 이번 재검수 결과에서 제외한다.
export function rescopeLocations(changedKeys: string[], draft: any): string[] {
  const out = new Set<string>(['title'])
  for (const key of changedKeys) {
    if (key === 'hook' || key === 'ending') { out.add(key); continue }
    const m = /^c(\d+)s(\d+)$/.exec(key); if (!m) continue
    const ch = draft?.chapters?.find((c: any) => Number(c.chapterNo) === Number(m[1])), n = Array.isArray(ch?.segments) ? ch.segments.length : 0
    for (const s of [Number(m[2]) - 1, Number(m[2]), Number(m[2]) + 1]) if (s >= 1 && s <= n) out.add(`chapter ${m[1]} / segment ${s}`)
  }
  return [...out]
}
export function filterIssuesToScope(issues: QcIssue[], scope: string[]): QcIssue[] {
  const set = new Set(scope.map((s) => s.toLowerCase()))
  return (Array.isArray(issues) ? issues : []).filter((it) => set.has(String(it?.location).trim().toLowerCase()))
}

// ── 최종 영상 확인: 완성본의 제목·썸네일·나레이션이 처음 승인한 약속을 이행하는가 (입력 누락은 통과가 아니라 실패)
export function finalPromiseCheck(p: any, final: { title?: string; thumbnailLines?: string[]; narration?: string }): { ok: boolean; promiseId: string | null; failures: Array<{ code: string; detail: string }> } {
  if (!verifyPromise(p)) return { ok: false, promiseId: typeof p?.promiseId === 'string' ? p.promiseId : null, failures: [{ code: 'PROMISE_INVALID', detail: 'approved promise is missing or does not match its promiseId' }] }
  const failures: Array<{ code: string; detail: string }> = []
  const lines = (Array.isArray(final?.thumbnailLines) ? final.thumbnailLines : []).map(norm).filter(Boolean), narration = norm(final?.narration)
  if (!clean(final?.title)) failures.push({ code: 'MISSING_TITLE', detail: 'final title was not provided' })
  else if (norm(final.title) !== norm(p.title)) failures.push({ code: 'TITLE_CHANGED', detail: `final title "${clean(final.title)}" differs from the approved title` })
  if (!lines.length) failures.push({ code: 'MISSING_THUMBNAIL', detail: 'final thumbnail text was not provided' })
  else for (const l of p.thumbnail.lines) if (!lines.some((x) => x.includes(norm(l)))) failures.push({ code: 'THUMBNAIL_CHANGED', detail: `approved thumbnail line "${l}" is not in the final thumbnail` })
  if (!narration) failures.push({ code: 'MISSING_NARRATION', detail: 'final narration text was not provided' })
  else for (const term of p.mustShow) if (!narration.includes(norm(term))) failures.push({ code: 'PROMISE_NOT_DELIVERED', detail: `"${term}" never appears in the final narration` })
  return { ok: failures.length === 0, promiseId: p.promiseId, failures }
}
