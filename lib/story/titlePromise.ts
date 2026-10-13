// 제작 6단계: 제목·썸네일 "약속"(Title Promise)을 먼저 잠그고, 그 약속이 Claude 집필 → GPT 검수 → 구간 수정 → 최종 확인까지
// 같은 식별자(promiseId)로 이어지게 하는 순수 함수 모음. 모델 호출 없음(결정적), 기존 STORY DNA/PLAN/QC는 그대로 두고 옵트인으로만 붙는다.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const PROMISE_SCHEMA = 'title-promise/1'
export type TitlePromise = {
  schema: typeof PROMISE_SCHEMA
  promiseId: string
  title: string
  thumbnail: { concept: string; lines: string[] }
  coreEvent: string // 제목·썸네일이 약속하는 실제 핵심 사건
  mustShow: string[] // 대본·최종 영상이 반드시 보여줘야 하는 핵심 단어/장면
  approvedAt: string
  signature?: string // 서버가 승인 시 발급하는 HMAC. 이 값이 없거나 틀리면 승인된 약속이 아니다
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

// 승인 서명 비밀키: TITLE_PROMISE_SECRET 우선, 없으면 서버가 이미 가진 API 키에서 파생(해시만 사용, 노출 없음; 키를 교체하면 이전 승인은 무효가 된다).
// 둘 다 없으면 서명할 수 없으므로 승인 자체를 만들 수 없다(fail closed).
export function promiseSecret(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = String(env.TITLE_PROMISE_SECRET || '').trim()
  if (explicit.length >= 16) return explicit
  const keys = [env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY].map((x) => String(x || '').trim()).filter(Boolean)
  return keys.length ? 'title-promise/v1|' + keys.join('|') : null
}
const signatureOf = (p: Pick<TitlePromise, 'promiseId' | 'approvedAt'>, secret: string) => createHmac('sha256', secret).update(`${p.promiseId}|${p.approvedAt}`).digest('hex')

// 서버가 승인할 때만 서명한다(promise_lock). 클라이언트가 내용과 sha256 식별자를 다시 계산해 만든 객체는 서명이 없어 승인으로 인정되지 않는다.
export function issueTitlePromise(input: any, now: Date = new Date(), secret: string | null = promiseSecret()): { ok: true; promise: TitlePromise } | { ok: false; errors: string[]; code?: string } {
  const r = lockTitlePromise(input, now)
  if (!r.ok) return r
  if (!secret) return { ok: false, code: 'PROMISE_SIGNING_NOT_CONFIGURED', errors: ['server approval signing is not configured (set TITLE_PROMISE_SECRET)'] }
  return { ok: true, promise: { ...r.promise, signature: signatureOf(r.promise, secret) } }
}

// 내용 + 식별자 + 서버 서명이 모두 맞아야 "승인된 약속"이다(브라우저 저장본·재작성·위조 거부).
export function verifyPromise(p: any, secret: string | null = promiseSecret()): p is TitlePromise {
  if (!secret || !p || p.schema !== PROMISE_SCHEMA || typeof p.promiseId !== 'string' || typeof p.signature !== 'string' || typeof p.approvedAt !== 'string') return false
  const again = lockTitlePromise(p, new Date(0))
  if (!again.ok || again.promise.promiseId !== p.promiseId) return false
  const want = Buffer.from(signatureOf(p, secret), 'hex'), got = Buffer.from(p.signature, 'hex')
  return want.length === got.length && timingSafeEqual(want, got)
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

export type QcIssue = { severity: string; category: string; location: string; claim: string; evidence: string; problem: string; recommendation: string; deterministic?: boolean; carriedOver?: boolean }
const issue = (category: string, location: string, problem: string, recommendation: string, evidence = ''): QcIssue => ({ severity: 'required', category, location, claim: problem, evidence, problem, recommendation, deterministic: true })

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
// 부분 재검수는 수정 범위만 다시 보므로, 범위 밖의 이전 미해결 필수/블로커 이슈는 해결된 것이 아니다: 그대로 남긴다(위치를 해석할 수 없는 이슈 포함).
export function carryOverUnresolved(prior: QcIssue[], scope: string[]): QcIssue[] {
  const set = new Set(scope.map((s) => s.toLowerCase()))
  return (Array.isArray(prior) ? prior : []).filter((it) => FIXABLE.has(String(it?.severity).toLowerCase()) && !set.has(String(it?.location).trim().toLowerCase()))
    .map((it) => ({ ...it, carriedOver: true } as QcIssue))
}

// ── 최종 텍스트 점검: 완성본의 제목·썸네일 문구·나레이션 텍스트가 처음 승인한 약속을 담고 있는가 (입력 누락은 통과가 아니라 실패)
// 주의: 제목/썸네일 문구/나레이션 텍스트의 포함 여부만 확인한다. 렌더된 영상·이미지의 실제 내용을 검증하지 않는다.
export function finalPromiseCheck(p: any, final: { title?: string; thumbnailLines?: string[]; narration?: string }): { ok: boolean; promiseId: string | null; method: 'text_match'; verifiesVideoContent: false; failures: Array<{ code: string; detail: string }> } {
  if (!verifyPromise(p)) return { ok: false, promiseId: typeof p?.promiseId === 'string' ? p.promiseId : null, method: 'text_match', verifiesVideoContent: false, failures: [{ code: 'PROMISE_INVALID', detail: 'approved promise is missing or does not match its promiseId' }] }
  const failures: Array<{ code: string; detail: string }> = []
  const lines = (Array.isArray(final?.thumbnailLines) ? final.thumbnailLines : []).map(norm).filter(Boolean), narration = norm(final?.narration)
  if (!clean(final?.title)) failures.push({ code: 'MISSING_TITLE', detail: 'final title was not provided' })
  else if (norm(final.title) !== norm(p.title)) failures.push({ code: 'TITLE_CHANGED', detail: `final title "${clean(final.title)}" differs from the approved title` })
  if (!lines.length) failures.push({ code: 'MISSING_THUMBNAIL', detail: 'final thumbnail text was not provided' })
  else for (const l of p.thumbnail.lines) if (!lines.some((x) => x.includes(norm(l)))) failures.push({ code: 'THUMBNAIL_CHANGED', detail: `approved thumbnail line "${l}" is not in the final thumbnail` })
  if (!narration) failures.push({ code: 'MISSING_NARRATION', detail: 'final narration text was not provided' })
  else for (const term of p.mustShow) if (!narration.includes(norm(term))) failures.push({ code: 'PROMISE_NOT_DELIVERED', detail: `"${term}" never appears in the final narration` })
  return { ok: failures.length === 0, promiseId: p.promiseId, method: 'text_match', verifiesVideoContent: false, failures }
}

// ── 구간 수정 실행기 (Claude 수정 핸들러와 GPT 폴백이 같은 로직을 쓴다; 모델 호출만 주입) ─────────────
export const PARTIAL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['target', 'text', 'visualHint', 'factStatus'], properties: {
    target: { type: 'string' }, text: { type: 'string' }, visualHint: { type: 'string' }, factStatus: { type: 'string', enum: ['verified', 'interpretation', 'verify_before_publish'] }
  } } } }
} as const

export function partialRevisionPrompt(input: any, promise: TitlePromise | null, targets: Target[], issues: any[], extra = ''): string {
  const draft = input?.draft || {}
  const around = (t: Target) => {
    if (t.kind !== 'segment') return {}
    const segs = draft.chapters.find((c: any) => Number(c.chapterNo) === t.chapterNo).segments
    return { before: String(segs[t.index! - 1]?.text || ''), after: String(segs[t.index! + 1]?.text || '') }
  }
  return [
    '당신은 경제·생활 롱폼 대본의 부분 수정 작가다. 아래 "수정 대상 구간"만 고친다. 다른 구간은 건드리지 않고 출력하지도 않는다.',
    '새로운 외부 사실을 만들지 말고 제공된 handoff와 QC 지시만 사용한다. 앞뒤 문맥(before/after)과 자연스럽게 이어지게 쓴다.',
    ...(promise ? ['', promiseBrief(promise)] : []),
    '', '[handoff]', JSON.stringify(input?.handoff || {}, null, 2),
    '', '[QC 이슈 — 수정 대상 구간만]', JSON.stringify(issues, null, 2),
    '', '[수정 대상 구간]', JSON.stringify(targets.map((t) => ({ target: t.key, currentText: targetText(draft, t), ...(t.kind === 'segment' ? { visualHint: String(draft.chapters.find((c: any) => Number(c.chapterNo) === t.chapterNo).segments[t.index!].visualHint || '') } : {}), ...around(t) })), null, 2),
    '', '각 대상마다 {target, text, visualHint, factStatus} 하나씩만 반환한다. target 값은 위 목록의 값을 그대로 쓴다. hook/ending은 visualHint를 빈 문자열로 둔다.',
    extra
  ].join('\n')
}

export type PartialModelCall = (prompt: string) => Promise<{ items: any[]; usage: any; model: string; provider: string }>
export async function runPartialRevision(input: any, call: PartialModelCall, extraPrompt = ''): Promise<{ status: number; body: any }> {
  if (!input?.draft || typeof input.draft !== 'object' || !input?.qc) return { status: 400, body: { ok: false, error: 'draft and qc are required' } }
  if (input.qc.status !== 'revision_required') return { status: 409, body: { ok: false, error: `Revision is not allowed for QC status: ${String(input.qc.status || 'unknown')}` } }
  const promise = verifyPromise(input?.approvedPromise) ? (input.approvedPromise as TitlePromise) : null
  const plan = revisionTargets(input.qc.issues, input.draft)
  // 구간으로 매핑되지 않는 이슈(또는 약속 없는 제목 이슈)는 부분 수정으로 고칠 수 없다: 호출자가 기존 전체 수정으로 폴백한다 (모델 호출 없음)
  // 자동으로 전체 대본을 다시 쓰지 않는다(유료·위험): 호출자는 사용자에게 알리고 사용자가 명시적으로 승인한 경우에만 전체 수정을 요청한다.
  if (!plan.partial || (plan.titleRestore && !promise)) return { status: 200, body: { ok: true, scope: 'manual_required', reason: 'issues cannot be mapped to specific segments; automatic whole-script rewrite is not performed', unmapped: plan.unmapped.map((x: any) => ({ location: x.location, category: x.category })) } }
  try {
    let draft = input.draft, changed: string[] = [], ignored: string[] = [], usage: any = null, model = '', provider = ''
    if (plan.targets.length) {
      const issues = (input.qc.issues || []).filter((x: any) => FIXABLE.has(String(x?.severity).toLowerCase()) && String(x?.location).toLowerCase() !== 'title')
      const r = await call(partialRevisionPrompt(input, promise, plan.targets, issues, extraPrompt))
      const m = mergePartial(input.draft, r.items, plan.targets)
      draft = m.draft; changed = m.changed; ignored = m.ignored; usage = r.usage; model = r.model; provider = r.provider
      // 요청한 모든 구간이 돌아와야 한다: 빠진 구간이 있으면 일부만 고친 대본을 성공으로 돌려주지 않는다
      const missing = plan.targets.map((t) => t.key).filter((k) => !changed.includes(k))
      if (missing.length) return { status: 502, body: { ok: false, error: { code: 'PARTIAL_INCOMPLETE', message: `model did not return every requested segment: ${missing.join(', ')}`, missing } } }
    }
    if (promise) draft = { ...draft, title: promise.title } // 제목은 잠긴 값: 모델이 아니라 승인본으로 복원
    return { status: 200, body: { ok: true, provider: provider || null, model: model || null, scope: 'partial', draft, usage, revisedTargets: changed, ignoredTargets: ignored, titleRestored: plan.titleRestore, promiseId: promise?.promiseId ?? null, qcScope: rescopeLocations(changed, draft), revisionCount: 1 } }
  } catch (e: any) { return { status: Number(e?.status) || 500, body: { ok: false, error: e?.message || String(e) } } }
}
