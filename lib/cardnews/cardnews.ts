// 카드뉴스 서버 기능(최소): 장별 이야기 AI 구성(GPT) → 독립 검수(Claude) → 문제 장만 수정(GPT) + 원고/승인 상태 저장·복구.
// 기존 구성만 재사용한다: GPT = longformPlanner.respond(기존 Responses 호출), Claude = claude-story와 같은 Messages 호출,
// 저장 = JobBlobStore(워크스페이스 = sha256(X-Sync-Key)). 유료 호출은 사용자가 예상 비용을 승인한 요청에서만 일어난다.
import { respond } from '../generative/longformPlanner.js'
import type { JobBlobStore } from '../jobs/blobs.js'

export const CARDNEWS_SCHEMA = 'cardnews/1'
export const CARD_LIMITS = Object.freeze({ headline: 18, body: 90, min: 5, max: 10 })
export type Cover = { id: string; title: string; coverLine: string; promise: string }
export type Card = { id: string; role: 'hook' | 'body' | 'ending'; headline: string; body: string }
export type Issue = { cardId: string | null; code: string; severity: 'required' | 'warning'; message: string }
export type CardnewsDeps = {
  gpt: (name: string, schema: any, instructions: string, input: string) => Promise<any>
  claude: (system: string, input: string) => Promise<{ text: string; model: string }>
}
export class CardnewsError extends Error { constructor(public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message) } }

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
// 예상 비용(안내값, 확정 단가 아님): 호출 1회당. 환경변수로만 조정한다.
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
export function cardnewsEstimate(task: 'compose' | 'review' | 'fix', env: Record<string, string | undefined> = process.env) {
  const usd = task === 'compose' ? num(env.CARDNEWS_COMPOSE_USD, 0.03) : task === 'review' ? num(env.CARDNEWS_REVIEW_USD, 0.03) : num(env.CARDNEWS_FIX_USD, 0.02)
  return { task, calls: 1, usd, confirmed: false, note: '호출 1회 기준 안내값이며 확정 단가가 아닙니다.' }
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
  return list.map((c: any, i: number) => ({ id: clean(c?.id) || `c${i + 1}`, role: (i === 0 ? 'hook' : i === list.length - 1 ? 'ending' : 'body') as Card['role'], headline: clean(c?.headline), body: clean(c?.body) }))
}
const clamp = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…')
const fitCard = (c: Card): Card => ({ ...c, headline: clamp(c.headline, CARD_LIMITS.headline), body: clamp(c.body, CARD_LIMITS.body) })

const RULES = `카드뉴스(인스타그램 4:5) 규칙: 첫 장=훅(숫자·질문·반전), 중간=전개, 마지막=결말. 제목 문구 ${CARD_LIMITS.headline}자 이하, 본문 ${CARD_LIMITS.body}자 이하. 소재에 없는 사실을 만들지 않는다. 과장 표현 금지. 한국어.`
const CARDS_SCHEMA = (n: number) => ({ type: 'object', additionalProperties: false, required: ['cards'], properties: { cards: { type: 'array', minItems: n, maxItems: n, items: { type: 'object', additionalProperties: false, required: ['headline', 'body'], properties: { headline: { type: 'string' }, body: { type: 'string' } } } } } })
const FIX_SCHEMA = { type: 'object', additionalProperties: false, required: ['cards'], properties: { cards: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'headline', 'body'], properties: { id: { type: 'string' }, headline: { type: 'string' }, body: { type: 'string' } } } } } }

export async function composeCards(input: any, deps: CardnewsDeps) {
  const cover = normalizeCover(input?.cover), material = clean(input?.material).slice(0, 6000)
  if (material.length < 20) throw new CardnewsError('BAD_REQUEST', '소재를 20자 이상 입력하세요.')
  const count = Math.min(CARD_LIMITS.max, Math.max(CARD_LIMITS.min, Math.round(Number(input?.count) || 8)))
  needApproval('compose', input) // 승인 전에는 아래 공급자 호출에 도달하지 않는다
  const j = await deps.gpt('cardnews_compose', CARDS_SCHEMA(count), `${RULES}\n제목(변경 금지): ${cover.title}\n표지 문구: ${cover.coverLine}\n약속하는 핵심 내용: ${cover.promise}\n정확히 ${count}장을 쓴다.`, material)
  const cards = normalizeCards(j?.cards, { min: count }).map(fitCard)
  return { cards, order: ['gpt:compose'], estimate: cardnewsEstimate('compose') }
}

const REVIEW_SYSTEM = `너는 카드뉴스의 독립 검수자다. 작성자와 다른 시각으로 각 장을 읽고 실제 문제만 지적한다. 형식적 통과 판정 금지.
검사: 훅이 약함, 제목·약속과 내용 불일치, 소재에 없는 사실(환각), 과장, 장 간 중복, 읽기 어려움. 문제가 없으면 빈 배열.
반드시 JSON만: {"findings":[{"cardId":"c3","code":"WEAK_HOOK|TITLE_MISMATCH|UNSUPPORTED_CLAIM|EXAGGERATION|DUPLICATE|UNCLEAR","severity":"required|warning","message":"한 문장"}]}`
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
export async function reviewCardsWithClaude(input: any, deps: CardnewsDeps) {
  const cover = normalizeCover(input?.cover), cards = normalizeCards(input?.cards), material = clean(input?.material).slice(0, 6000)
  needApproval('review', input)
  const r = await deps.claude(REVIEW_SYSTEM, JSON.stringify({ cover: { title: cover.title, coverLine: cover.coverLine, promise: cover.promise }, material, cards: cards.map((c) => ({ id: c.id, role: c.role, headline: c.headline, body: c.body })) }))
  return { issues: parseReview(r.text, cards), reviewerModel: r.model, order: ['gpt:compose', 'claude:review'], estimate: cardnewsEstimate('review') }
}

// 문제 장만 다시 쓴다. 지적받지 않은 장은 그대로(바이트 단위로 동일)이며, 지정하지 않은 장을 모델이 바꿔 와도 무시한다.
export async function fixFlaggedWithGpt(input: any, deps: CardnewsDeps) {
  const cover = normalizeCover(input?.cover), cards = normalizeCards(input?.cards), material = clean(input?.material).slice(0, 6000)
  const issues: Issue[] = Array.isArray(input?.issues) ? input.issues : []
  const ids = [...new Set(issues.map((i) => clean(i?.cardId)).filter((id) => cards.some((c) => c.id === id)))]
  if (!ids.length) throw new CardnewsError('BAD_REQUEST', '고칠 장이 지정되지 않았습니다.')
  needApproval('fix', input)
  const targets = cards.filter((c) => ids.includes(c.id))
  const j = await deps.gpt('cardnews_fix', FIX_SCHEMA, `${RULES}\n제목(변경 금지): ${cover.title}\n약속하는 핵심 내용: ${cover.promise}\n아래 [다시 쓸 장]만 지적 사항을 반영해 다시 쓴다. 장 id를 그대로 돌려준다. 다른 장은 쓰지 않는다.`,
    JSON.stringify({ material, 다시쓸장: targets, 지적: issues.filter((i) => ids.includes(clean(i.cardId))).map((i) => ({ cardId: i.cardId, message: i.message })) }))
  const got = new Map<string, any>((Array.isArray(j?.cards) ? j.cards : []).map((c: any) => [clean(c?.id), c]))
  const missing = ids.filter((id) => !clean(got.get(id)?.headline) && !clean(got.get(id)?.body))
  if (missing.length) throw new CardnewsError('FIX_INCOMPLETE', `요청한 장이 빠졌습니다: ${missing.join(', ')}`)
  const next = cards.map((c) => (ids.includes(c.id) ? fitCard({ ...c, headline: clean(got.get(c.id).headline), body: clean(got.get(c.id).body) }) : c))
  return { cards: next, changed: ids, order: ['gpt:compose', 'claude:review', 'gpt:fix'], estimate: cardnewsEstimate('fix') }
}

// ── 원고·승인 상태 저장/복구(워크스페이스별 1건, 낙관적 잠금). 이미지 데이터는 저장하지 않는다.
export const MAX_STATE_BYTES = 120_000
export type Saved = { schema: typeof CARDNEWS_SCHEMA; rev: number; savedAt: string; state: any }
const pathOf = (ws: string) => `cardnews/${ws}/state.json`
export function sanitizeState(s: any) {
  if (!s || typeof s !== 'object') throw new CardnewsError('BAD_REQUEST', 'state가 필요합니다.')
  const out: any = {
    material: String(s.material ?? '').slice(0, 6000), count: Math.min(CARD_LIMITS.max, Math.max(CARD_LIMITS.min, Math.round(Number(s.count) || 8))),
    form: { title: String(s.form?.title ?? '').slice(0, 120), coverLine: String(s.form?.coverLine ?? '').slice(0, 80), promise: String(s.form?.promise ?? '').slice(0, 400) },
    cover: s.cover ? normalizeCover(s.cover) : null, cards: Array.isArray(s.cards) ? s.cards.slice(0, CARD_LIMITS.max).map((c: any, i: number) => ({ id: clean(c?.id) || `c${i + 1}`, role: ['hook', 'body', 'ending'].includes(c?.role) ? c.role : 'body', headline: String(c?.headline ?? '').slice(0, 200), body: String(c?.body ?? '').slice(0, 800) })) : [],
    review: s.review && typeof s.review === 'object' ? s.review : null, theme: String(s.theme ?? 'night').slice(0, 20), pendingAiIds: Array.isArray(s.pendingAiIds) ? s.pendingAiIds.map((x: any) => String(x).slice(0, 20)).slice(0, CARD_LIMITS.max) : null
  }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_STATE_BYTES) throw new CardnewsError('STATE_TOO_LARGE', '저장할 카드뉴스가 너무 큽니다.')
  return out
}
export async function getSaved(blobs: JobBlobStore, ws: string): Promise<Saved | null> { return (await blobs.getJson<Saved>(pathOf(ws))) ?? null }
export async function putSaved(blobs: JobBlobStore, ws: string, input: any): Promise<Saved> {
  const state = sanitizeState(input?.state), cur = await getSaved(blobs, ws), base = Number(input?.baseRev ?? 0)
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
    const res = await f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 1500, system, messages: [{ role: 'user', content: input }] }) })
    const raw = await res.text().catch(() => ''); if (!res.ok) throw new CardnewsError('PROVIDER_DOWN', `Claude review HTTP ${res.status}${res.status === 429 ? ' (rate/usage limit)' : ''}`)
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
