// 카드뉴스 서버 기능(최소): 장별 대본 작성(Claude) → 독립 검수(GPT) → 문제 장만 수정(Claude) + 원고/승인 상태 저장·복구.
// 기존 구성만 재사용한다: GPT = longformPlanner.respond(기존 Responses 호출), Claude = claude-story와 같은 Messages 호출,
// 저장 = JobBlobStore(워크스페이스 = sha256(X-Sync-Key)). 유료 호출은 사용자가 예상 비용을 승인한 요청에서만 일어난다.
import { createHash } from 'node:crypto'
import { respond } from '../generative/longformPlanner.js'
import type { JobBlobStore } from '../jobs/blobs.js'
import { cleanPlan, planIssues, type VisualPlan, type PlanIssue } from './visualPlan.js'

export const CARDNEWS_SCHEMA = 'cardnews/1'
export const CARD_LIMITS = Object.freeze({ headline: 18, body: 90, min: 5, max: 10 })
export type Cover = { id: string; title: string; coverLine: string; promise: string }
export type Card = { id: string; role: 'hook' | 'body' | 'ending'; headline: string; body: string; visualPlan?: VisualPlan }
export type Issue = { cardId: string | null; code: string; severity: 'required' | 'warning'; message: string }
export type CardnewsDeps = {
  gpt: (name: string, schema: any, instructions: string, input: string) => Promise<any>
  claude: (system: string, input: string, name?: string) => Promise<{ text: string; model: string }>
}
export class CardnewsError extends Error { constructor(public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message) } }

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
// 예상 비용(안내값, 확정 단가 아님): 호출 1회당. 환경변수로만 조정한다.
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
export function cardnewsEstimate(task: 'compose' | 'review' | 'fix', env: Record<string, string | undefined> = process.env) {
  // compose = the whole deck (story + scene plans) in one call, plus at most ONE repair call for only the flagged cards' plans
  const usd = task === 'compose' ? num(env.CARDNEWS_COMPOSE_USD, 0.05) : task === 'review' ? num(env.CARDNEWS_REVIEW_USD, 0.03) : num(env.CARDNEWS_FIX_USD, 0.02)
  return { task, calls: task === 'compose' ? 2 : 1, usd, confirmed: false, note: '호출 1회 기준 안내값이며 확정 단가가 아닙니다.' }
}
// 승인 없는 요청은 어떤 공급자도 부르지 않고 예상 비용만 돌려준다.
export function needApproval(task: 'compose' | 'review' | 'fix', input: any) {
  const est = cardnewsEstimate(task)
  if (input?.costApproved !== true || !(Number(input?.approvedUsd) >= est.usd)) throw new CardnewsError('COST_APPROVAL_REQUIRED', '예상 비용을 확인하고 승인해야 AI를 호출합니다.', { estimate: est })
  return est
}

export function normalizeCover(c: any): Cover {
  const cover = { id: clean(c?.id), title: clean(c?.title), coverLine: clean(c?.coverLine), promise: clean(c?.promise) }
  if (!/^cv_[0-9a-f]{4,16}$/.test(cover.id) || cover.title.length < 4 || cover.title.length > 60 || cover.promise.length < 8) throw new CardnewsError('BAD_REQUEST', '승인된 표지(id·제목·약속)가 필요합니다.')
  return cover
}
export function normalizeCards(list: any, { min = CARD_LIMITS.min as number } = {}): Card[] {
  if (!Array.isArray(list) || list.length < min || list.length > CARD_LIMITS.max) throw new CardnewsError('BAD_REQUEST', `카드는 ${min}~${CARD_LIMITS.max}장이어야 합니다.`)
  return list.map((c: any, i: number) => ({ id: clean(c?.id) || `c${i + 1}`, role: (i === 0 ? 'hook' : i === list.length - 1 ? 'ending' : 'body') as Card['role'], headline: clean(c?.headline), body: clean(c?.body), ...(cleanPlan(c?.visualPlan) ? { visualPlan: cleanPlan(c?.visualPlan)! } : {}) }))
}
const clamp = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…')
const fitCard = (c: Card): Card => ({ ...c, headline: clamp(c.headline, CARD_LIMITS.headline), body: clamp(c.body, CARD_LIMITS.body) })

const RULES = `카드뉴스(인스타그램 4:5) 편집 품질 계약. 정확히 첫 장=강한 궁금증을 만드는 훅, 중간=서로 다른 새 정보와 증거를 한 장씩 공개, 마지막=정체·결론 공개. 각 장 제목은 ${CARD_LIMITS.headline}자 이하, 본문은 ${CARD_LIMITS.body}자 이하. 한국어. 소재에 없는 사실을 지어내거나 과장하지 않는다.
최우선: 소재의 첫 문장을 표지·첫 장에 그대로 복사하지 말고 시청자가 다음 장을 넘기게 만드는 자연스러운 완결형 한국어 제목을 작성한다. 의미 없는 말줄임표·문장 중간 잘림·"천장엔?" 같은 불완전한 제목 금지.
첫 장은 정체·지명·고유명사를 숨겨도 설명이 성립하면 숨긴다. 단, 마지막 장에서 공개할 사실을 첫 장이나 중간 장에서 먼저 누설하지 않는다.
2~끝에서 각 장은 이전 장과 다른 질문에 답해야 한다. 같은 사실을 단어만 바꾸어 반복하거나 "물이 들어온다→물이 흐른다"처럼 정보량 없이 장 수를 채우지 않는다. 소재 정보가 부족하면 근거 없는 내용을 추가하지 말고 확인 가능한 구조·원인·효과·대비·역사적 맥락을 분리해 설명한다.
각 장마다 독립적인 시각 증거 또는 장면 하나가 있어야 한다. 텍스트만 읽어야 이해되는 추상 문구 대신 실제 그릴 수 있는 물체·행동·단면·비교를 택한다.
최종 출력 전에 덱 전체를 내부 검토해 약한 훅, 앞뒤 중복, 조기 정체 공개, 소재와 무관한 주장, 부자연스러운 제목이 있으면 같은 생성 호출 안에서 바로 수정한다. `
const PLAN_PROPS = { type: 'object', additionalProperties: false, required: ['subject', 'composition', 'distinction'], properties: { subject: { type: 'string' }, composition: { type: 'string' }, distinction: { type: 'string' } } }
const CARDS_SCHEMA = (n: number) => ({ type: 'object', additionalProperties: false, required: ['cards'], properties: { cards: { type: 'array', minItems: n, maxItems: n, items: { type: 'object', additionalProperties: false, required: ['headline', 'body', 'visualPlan'], properties: { headline: { type: 'string' }, body: { type: 'string' }, visualPlan: PLAN_PROPS } } } } })
const PLAN_FIX_SCHEMA = { type: 'object', additionalProperties: false, required: ['cards'], properties: { cards: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'visualPlan'], properties: { id: { type: 'string' }, visualPlan: PLAN_PROPS } } } } }
const PLAN_RULES = `각 장의 visualPlan: subject=이 장이 보여줄 핵심 피사체(구체적으로), composition=카메라 구도·시점, distinction=앞뒤 장과 시각적으로 무엇이 다른지. 덱 전체를 한 번에 보고 설계한다. 와이드→클로즈업→단면도 같은 순서를 기계적으로 반복하지 말고 이 장의 이야기에 가장 맞는 장면을 고른다. 같은 피사체·같은 구도를 두 장에서 쓰지 않는다. 마지막 장에서 공개할 정체나 반전은 앞 장의 장면 계획에 미리 드러내지 않는다. 이미지 안에는 글자를 넣지 않는다.`
const FIX_SCHEMA = { type: 'object', additionalProperties: false, required: ['cards'], properties: { cards: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'headline', 'body'], properties: { id: { type: 'string' }, headline: { type: 'string' }, body: { type: 'string' } } } } } }

// 대본 작성자 = Claude(JSON 텍스트로 받는다), 검수자 = GPT(구조화 출력). 작성자와 검수자가 서로 다른 모델이다.
export function parseJsonObject(text: string): any {
  const t = String(text || '').replace(/```(?:json)?/g, ''), a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a < 0 || b <= a) throw new CardnewsError('PROVIDER_DOWN', 'Claude 응답에 JSON이 없습니다.')
  try { return JSON.parse(t.slice(a, b + 1)) } catch { throw new CardnewsError('PROVIDER_DOWN', 'Claude 응답 JSON을 읽을 수 없습니다.') }
}
const write = async (deps: CardnewsDeps, name: string, schema: any, instructions: string, input: string) =>
  parseJsonObject((await deps.claude(`${instructions}\n반드시 JSON 객체 하나만 출력한다(설명·코드블록 금지). 형식(JSON Schema): ${JSON.stringify(schema)}`, input, name)).text)

export async function composeCards(input: any, deps: CardnewsDeps) {
  const cover = normalizeCover(input?.cover), material = clean(input?.material).slice(0, 6000)
  if (material.length < 20) throw new CardnewsError('BAD_REQUEST', '소재를 20자 이상 입력하세요.')
  const count = Math.min(CARD_LIMITS.max, Math.max(CARD_LIMITS.min, Math.round(Number(input?.count) || 8)))
  needApproval('compose', input) // 승인 전에는 아래 공급자 호출에 도달하지 않는다
  const j = await write(deps, 'cardnews_compose', CARDS_SCHEMA(count), `${RULES}\n${PLAN_RULES}\n소재에서 임시 추출한 참고 제목(첫 장 제목으로 복사하지 말 것): ${cover.title}\n표지 문구: ${cover.coverLine}\n약속하는 핵심 내용: ${cover.promise}\n정확히 ${count}장을 쓴다.`, material)
  let cards = normalizeCards(j?.cards, { min: count }).map(fitCard)
  // 이미지(유료) 전에 무료 규칙 검사. 문제가 있는 장의 계획만 한 번 고친다(전체 재설계 없음, 자동 반복 없음).
  let issues = planIssues(cards, cover), order = ['claude:compose']
  const flagged = [...new Set(issues.map((i) => i.cardId))]
  if (flagged.length) {
    const fixed = await write(deps, 'cardnews_plan_fix', PLAN_FIX_SCHEMA, `${PLAN_RULES}\n제목: ${cover.title}\n아래 지적된 장의 visualPlan만 다시 쓴다. 장 id를 그대로 돌려주고, 지적되지 않은 장은 쓰지 않는다.`,
      JSON.stringify({ 전체장면: cards.map((c) => ({ id: c.id, headline: c.headline, body: c.body, visualPlan: c.visualPlan ?? null })), 지적: issues.map((i) => ({ cardId: i.cardId, code: i.code, message: i.message })) }))
    const got = new Map<string, any>((Array.isArray(fixed?.cards) ? fixed.cards : []).map((c: any) => [clean(c?.id), c]))
    cards = cards.map((c) => (flagged.includes(c.id) && cleanPlan(got.get(c.id)?.visualPlan) ? { ...c, visualPlan: cleanPlan(got.get(c.id).visualPlan)! } : c))
    issues = planIssues(cards, cover); order = [...order, 'claude:plan_fix']
  }
  return { cards, planIssues: issues, order, estimate: cardnewsEstimate('compose') }
}

const REVIEW_SYSTEM = `너는 카드뉴스의 독립 검수자다. 작성자와 다른 시각으로 각 장을 읽고 실제 문제만 지적한다. 형식적 통과 판정 금지.
검사: 훅이 약함, 제목·약속과 내용 불일치, 소재에 없는 사실(환각), 과장, 장 간 중복, 읽기 어려움. 문제가 없으면 빈 배열.
형식: {"findings":[{"cardId":"c3","code":"WEAK_HOOK|TITLE_MISMATCH|UNSUPPORTED_CLAIM|EXAGGERATION|DUPLICATE|UNCLEAR","severity":"required|warning","message":"한 문장"}]}`
export function parseReview(text: string, cards: Card[]): Issue[] {
  const m = /\{[\s\S]*\}/.exec(String(text || '')); if (!m) throw new CardnewsError('REVIEW_INVALID', '검수 결과에 JSON이 없습니다.')
  let j: any; try { j = JSON.parse(m[0]) } catch { throw new CardnewsError('REVIEW_INVALID', '검수 결과 JSON을 읽을 수 없습니다.') }
  if (!Array.isArray(j?.findings)) throw new CardnewsError('REVIEW_INVALID', '검수 결과에 findings 배열이 없습니다.')
  const ids = new Set(cards.map((c) => c.id))
  return j.findings.slice(0, 20).map((f: any) => {
    if (!clean(f?.message)) throw new CardnewsError('REVIEW_INVALID', '검수 지적에 이유가 없습니다.')
    return { cardId: ids.has(clean(f?.cardId)) ? clean(f.cardId) : null, code: clean(f?.code).slice(0, 40) || 'UNCLEAR', severity: f?.severity === 'required' ? 'required' : 'warning', message: clean(f.message).slice(0, 300) } as Issue
  })
}
const REVIEW_SCHEMA = { type: 'object', additionalProperties: false, required: ['findings'], properties: { findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cardId', 'code', 'severity', 'message'], properties: { cardId: { type: 'string' }, code: { type: 'string' }, severity: { type: 'string', enum: ['required', 'warning'] }, message: { type: 'string' } } } } } }
export async function reviewCardsWithGpt(input: any, deps: CardnewsDeps) {
  const cover = normalizeCover(input?.cover), cards = normalizeCards(input?.cards), material = clean(input?.material).slice(0, 6000)
  needApproval('review', input)
  const r = await deps.gpt('cardnews_review', REVIEW_SCHEMA, REVIEW_SYSTEM, JSON.stringify({ cover: { title: cover.title, coverLine: cover.coverLine, promise: cover.promise }, material, cards: cards.map((c) => ({ id: c.id, role: c.role, headline: c.headline, body: c.body })) }))
  return { issues: parseReview(JSON.stringify(r ?? {}), cards), reviewerModel: 'gpt', order: ['claude:compose', 'gpt:review'], estimate: cardnewsEstimate('review') }
}
export const reviewCardsWithClaude = reviewCardsWithGpt // 예전 이름(호환)

// 문제 장만 다시 쓴다. 지적받지 않은 장은 그대로(바이트 단위로 동일)이며, 지정하지 않은 장을 모델이 바꿔 와도 무시한다.
export async function fixFlaggedWithClaude(input: any, deps: CardnewsDeps) {
  const cover = normalizeCover(input?.cover), cards = normalizeCards(input?.cards), material = clean(input?.material).slice(0, 6000)
  const issues: Issue[] = Array.isArray(input?.issues) ? input.issues : []
  const ids = [...new Set(issues.map((i) => clean(i?.cardId)).filter((id) => cards.some((c) => c.id === id)))]
  if (!ids.length) throw new CardnewsError('BAD_REQUEST', '고칠 장이 지정되지 않았습니다.')
  needApproval('fix', input)
  const targets = cards.filter((c) => ids.includes(c.id))
  const j = await write(deps, 'cardnews_fix', FIX_SCHEMA, `${RULES}\n제목(변경 금지): ${cover.title}\n약속하는 핵심 내용: ${cover.promise}\n아래 [다시 쓸 장]만 지적 사항을 반영해 다시 쓴다. 장 id를 그대로 돌려준다. 다른 장은 쓰지 않는다.`,
    JSON.stringify({ material, 다시쓸장: targets, 지적: issues.filter((i) => ids.includes(clean(i.cardId))).map((i) => ({ cardId: i.cardId, message: i.message })) }))
  const got = new Map<string, any>((Array.isArray(j?.cards) ? j.cards : []).map((c: any) => [clean(c?.id), c]))
  const missing = ids.filter((id) => !clean(got.get(id)?.headline) && !clean(got.get(id)?.body))
  if (missing.length) throw new CardnewsError('FIX_INCOMPLETE', `요청한 장이 빠졌습니다: ${missing.join(', ')}`)
  const next = cards.map((c) => (ids.includes(c.id) ? fitCard({ ...c, headline: clean(got.get(c.id).headline), body: clean(got.get(c.id).body) }) : c))
  return { cards: next, changed: ids, order: ['claude:compose', 'gpt:review', 'claude:fix'], estimate: cardnewsEstimate('fix') }
}
export const fixFlaggedWithGpt = fixFlaggedWithClaude // 예전 이름(호환)

// ── 원고·승인 상태 저장/복구(워크스페이스별 1건, 낙관적 잠금). 이미지 데이터는 저장하지 않는다.
export const MAX_STATE_BYTES = 120_000
export type Saved = { schema: typeof CARDNEWS_SCHEMA; rev: number; savedAt: string; state: any }
const pathOf = (ws: string) => `cardnews/${ws}/state.json`
// 이미지는 서버에 저장된 원본의 참조(ref)와 버전 정보만 상태에 둔다(바이트는 상태/브라우저 저장소에 넣지 않는다).
const IMAGE_REF = (ws: string) => new RegExp(`^cardnews/${ws}/images/[0-9a-f]{64}\\.(png|jpg|webp)$`)
export function sanitizeImages(v: any, ws: string) {
  const out: Record<string, { selected: string; versions: Array<{ id: string; ref: string; style: string; at: string }> }> = {}
  if (!v || typeof v !== 'object') return out
  const re = IMAGE_REF(ws)
  for (const [cardId, e] of Object.entries<any>(v).slice(0, CARD_LIMITS.max)) {
    const versions = (Array.isArray(e?.versions) ? e.versions : []).slice(0, 12).filter((x: any) => re.test(String(x?.ref ?? ''))).map((x: any) => ({ id: String(x.id ?? '').slice(0, 40), ref: String(x.ref), style: String(x.style ?? '').slice(0, 40), at: String(x.at ?? '').slice(0, 40) })).filter((x: any) => x.id)
    if (!versions.length) continue
    out[String(cardId).slice(0, 20)] = { selected: versions.some((x: any) => x.id === e?.selected) ? String(e.selected) : versions[versions.length - 1].id, versions }
  }
  return out
}
// 장별 스토리보드·캐릭터·그림체 기준 이미지(서버 저장본의 참조만)와 짧은 고정 규칙. 후속편에서도 그대로 다시 쓴다.
export function sanitizeRefs(v: any, ws: string) {
  const re = IMAGE_REF(ws), ok = (x: any) => re.test(String(x?.ref ?? ''))
  const one = (x: any) => ({ ref: String(x.ref), label: String(x?.label ?? '').slice(0, 60), at: String(x?.at ?? '').slice(0, 40) })
  const storyboard: Record<string, any> = {}
  for (const [cardId, x] of Object.entries<any>(v?.storyboard && typeof v.storyboard === 'object' ? v.storyboard : {}).slice(0, CARD_LIMITS.max + 1)) if (ok(x)) storyboard[String(cardId).slice(0, 20)] = one(x)
  const list = (a: any, n: number) => (Array.isArray(a) ? a.filter(ok).slice(0, n).map(one) : [])
  return { panels: list(v?.panels, 12), storyboard, character: list(v?.character, 2), style: list(v?.style, 1), fixedTraits: String(v?.fixedTraits ?? '').slice(0, 600), forbid: String(v?.forbid ?? '').slice(0, 600), revealCardId: String(v?.revealCardId ?? '').slice(0, 20), hideRule: String(v?.hideRule ?? '').slice(0, 600) }
}
export function sanitizeState(s: any, ws = '') {
  if (!s || typeof s !== 'object') throw new CardnewsError('BAD_REQUEST', 'state가 필요합니다.')
  const out: any = {
    material: String(s.material ?? '').slice(0, 6000), count: Math.min(CARD_LIMITS.max, Math.max(CARD_LIMITS.min, Math.round(Number(s.count) || 8))),
    form: { title: String(s.form?.title ?? '').slice(0, 120), coverLine: String(s.form?.coverLine ?? '').slice(0, 80), promise: String(s.form?.promise ?? '').slice(0, 400) },
    cover: s.cover ? normalizeCover(s.cover) : null, cards: Array.isArray(s.cards) ? s.cards.slice(0, CARD_LIMITS.max).map((c: any, i: number) => ({ id: clean(c?.id) || `c${i + 1}`, role: ['hook', 'body', 'ending'].includes(c?.role) ? c.role : 'body', headline: String(c?.headline ?? '').slice(0, 200), body: String(c?.body ?? '').slice(0, 800), ...(cleanPlan(c?.visualPlan) ? { visualPlan: cleanPlan(c?.visualPlan)! } : {}) })) : [],
    review: s.review && typeof s.review === 'object' ? s.review : null, theme: String(s.theme ?? 'night').slice(0, 20), style: String(s.style ?? '').slice(0, 40), images: sanitizeImages(s.images, ws), refs: sanitizeRefs(s.refs, ws), scriptConfirmedAt: typeof s.scriptConfirmedAt === 'string' && s.cover ? s.scriptConfirmedAt.slice(0, 40) : null, pendingAiIds: Array.isArray(s.pendingAiIds) ? s.pendingAiIds.map((x: any) => String(x).slice(0, 20)).slice(0, CARD_LIMITS.max) : null
  }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_STATE_BYTES) throw new CardnewsError('STATE_TOO_LARGE', '저장할 카드뉴스가 너무 큽니다.')
  return out
}
export async function getSaved(blobs: JobBlobStore, ws: string): Promise<Saved | null> { return (await blobs.getJson<Saved>(pathOf(ws))) ?? null }
export async function putSaved(blobs: JobBlobStore, ws: string, input: any): Promise<Saved> {
  const state = sanitizeState(input?.state, ws), cur = await getSaved(blobs, ws), base = Number(input?.baseRev ?? 0)
  if (cur && cur.rev !== base) throw new CardnewsError('REV_CONFLICT', '다른 기기에서 먼저 저장된 카드뉴스가 있습니다.', { server: cur })
  if (!cur && base !== 0) throw new CardnewsError('REV_CONFLICT', '저장된 카드뉴스가 없습니다.', { server: null })
  const doc: Saved = { schema: CARDNEWS_SCHEMA, rev: (cur?.rev ?? 0) + 1, savedAt: new Date().toISOString(), state }
  await blobs.putJson(pathOf(ws), doc, { overwrite: true })
  return doc
}

export function claudeFromEnv(env: Record<string, string | undefined> = process.env, f: typeof fetch = fetch): CardnewsDeps['claude'] {
  return async (system, input) => {
    const key = env.ANTHROPIC_API_KEY || ''; if (!key) throw new CardnewsError('PROVIDER_DOWN', 'ANTHROPIC_API_KEY is not configured')
    const model = env.ANTHROPIC_STORY_MODEL || 'claude-sonnet-5'
    const res = await f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: input }] }) })
    const raw = await res.text().catch(() => ''); if (!res.ok) throw new CardnewsError('PROVIDER_DOWN', `Claude HTTP ${res.status}${res.status === 429 ? ' (rate/usage limit)' : ''}`)
    let data: any = {}; try { data = raw ? JSON.parse(raw) : {} } catch { throw new CardnewsError('REVIEW_INVALID', 'Claude returned invalid JSON') }
    return { text: (data?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(''), model: String(data?.model || model) }
  }
}
export function depsFromEnv(env: Record<string, string | undefined> = process.env): CardnewsDeps {
  return {
    gpt: async (name, schema, instructions, input) => { const k = env.OPENAI_API_KEY || ''; if (!k) throw new CardnewsError('PROVIDER_DOWN', 'OPENAI_API_KEY is not configured'); return respond(k, name, schema, instructions, input) },
    claude: claudeFromEnv(env)
  }
}

// ── 카드 이미지 원본 저장(기존 JobBlobStore = Tracker의 R2/Blob 재사용). 내용 해시로 주소를 정해 같은 이미지는 한 번만 저장되고 이전 버전은 지워지지 않는다.
export const MAX_IMAGE_BYTES = 6_000_000
const sniff = (b: Buffer): { ext: 'png' | 'jpg' | 'webp'; mime: string } | null =>
  b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? { ext: 'png', mime: 'image/png' }
  : b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? { ext: 'jpg', mime: 'image/jpeg' }
  : b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? { ext: 'webp', mime: 'image/webp' } : null
export async function putImage(blobs: JobBlobStore, ws: string, input: any) {
  const b64 = String(input?.dataBase64 ?? '').replace(/^data:[^;]+;base64,/, '')
  if (!b64 || b64.length > Math.ceil(MAX_IMAGE_BYTES * 1.4)) throw new CardnewsError('BAD_REQUEST', '이미지 데이터가 없거나 너무 큽니다.')
  const bytes = Buffer.from(b64, 'base64'), kind = sniff(bytes)
  if (!kind || bytes.length > MAX_IMAGE_BYTES) throw new CardnewsError('BAD_REQUEST', 'PNG/JPEG/WEBP 이미지가 아닙니다.')
  const sha = createHash('sha256').update(bytes).digest('hex'), ref = `cardnews/${ws}/images/${sha}.${kind.ext}`
  const r = await blobs.putBytes(ref, bytes, kind.mime)
  // 저장이 확인된 뒤에만 성공으로 돌려준다(읽어서 같은 바이트인지 확인): 저장 실패를 완료로 처리하지 않는다
  const back = await blobs.getBytes(ref)
  if (!back || createHash('sha256').update(back).digest('hex') !== sha) throw new CardnewsError('STORE_FAILED', '이미지를 서버에 저장하지 못했습니다.')
  return { ref, sha256: sha, bytes: r.bytes, mimeType: kind.mime }
}
export async function getImage(blobs: JobBlobStore, ws: string, ref: string) {
  if (!IMAGE_REF(ws).test(ref)) throw new CardnewsError('BAD_REQUEST', '이 작업 공간의 이미지가 아닙니다.')
  const bytes = await blobs.getBytes(ref); const kind = bytes ? sniff(bytes) : null
  if (!bytes || !kind) throw new CardnewsError('NOT_FOUND', '이미지를 찾을 수 없습니다.')
  return { mimeType: kind.mime, dataBase64: bytes.toString('base64') }
}
