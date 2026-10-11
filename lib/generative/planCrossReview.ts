// PLAN cross-review (opt-in, default OFF): GPT outline -> Claude independent review -> GPT accept/reject + at most ONE
// revision. Reuses the existing calls only: GPT via longformPlanner.respond() + planner.outline(repair), Claude via the
// same Anthropic Messages call api/claude-story.ts already makes (ANTHROPIC_API_KEY / ANTHROPIC_STORY_MODEL).
// Any failure (Claude error, usage limit, invalid revision) keeps the original GPT outline and records why; a failed
// review is never recorded as a pass.
import { respond, type LongformOutline } from './longformPlanner.js'

export const PLAN_CROSS_REVIEW_VERSION = 'plan-cross-review/1'
export const REVIEW_AREAS = ['title', 'thumbnail', 'hook30s', 'midReward', 'catharsis'] as const
export type ReviewArea = typeof REVIEW_AREAS[number]
export type ReviewFinding = { area: ReviewArea; problem: string; reason: string; direction: string }
export type ReviewDecision = { index: number; action: 'accept' | 'reject'; reason: string }
export type CrossReviewRecord = {
  schema: typeof PLAN_CROSS_REVIEW_VERSION
  status: 'revised' | 'no_findings' | 'all_rejected' | 'fallback'
  order: string[]
  reviewerModel: string | null
  findings: ReviewFinding[]
  decisions: ReviewDecision[]
  fallbackReason: string | null
}
export type CrossReviewDeps = {
  reviewer: (outline: LongformOutline, topic: string) => Promise<{ findings: ReviewFinding[]; model: string }>
  decider: (outline: LongformOutline, findings: ReviewFinding[], topic: string) => Promise<ReviewDecision[]>
}

export const planCrossReviewOn = (env: Record<string, string | undefined> = process.env) => env.PLAN_CROSS_REVIEW === 'on'

const REVIEW_PROMPT = `너는 유튜브 롱폼 기획의 독립 검증자다. 아래 기획(제목, 썸네일 문구, 첫 훅, 섹션 구성)을 직접 읽고
title(제목), thumbnail(썸네일 콘셉트), hook30s(첫 30초 훅), midReward(중간 보상), catharsis(최종 카타르시스) 다섯 영역을 검증한다.
형식적인 통과 판정은 하지 않는다. 실제 문제가 있는 영역만 지적하고, 각 지적은 문제 구간(problem)·이유(reason)·수정 방향(direction)을 한두 문장으로 간결하게 쓴다.
문제가 정말 없을 때만 빈 배열을 반환한다. 반드시 JSON만 출력: {"findings":[{"area":"title|thumbnail|hook30s|midReward|catharsis","problem":"","reason":"","direction":""}]}`

const outlineText = (o: LongformOutline, topic: string) => JSON.stringify({ topic, title: o.title, hook: o.hook, thumbnail: o.thumbnail?.lines?.map((l) => l.text), sections: o.sections?.map((s) => ({ heading: s.heading, points: s.points })) })

export function parseFindings(text: string): ReviewFinding[] {
  const m = /\{[\s\S]*\}/.exec(String(text || ''))
  if (!m) throw new Error('Claude review returned no JSON')
  const j = JSON.parse(m[0])
  if (!Array.isArray(j?.findings)) throw new Error('Claude review JSON has no findings array')
  if (j.findings.some((f: any) => !REVIEW_AREAS.includes(f?.area) || !String(f?.problem || '').trim() || !String(f?.reason || '').trim() || !String(f?.direction || '').trim())) {
    throw new Error('Claude review contains invalid or incomplete findings')
  }
  return j.findings.slice(0, 10)
    .map((f: any) => ({ area: f.area, problem: String(f.problem).slice(0, 300), reason: String(f.reason || '').slice(0, 300), direction: String(f.direction || '').slice(0, 300) }))
}

// Claude: the same Messages request shape as api/claude-story.ts callClaudeStory (no new provider integration).
export function claudeReviewer(o: { apiKey: string; model?: string; fetchImpl?: typeof fetch }): CrossReviewDeps['reviewer'] {
  const f = o.fetchImpl ?? fetch, model = o.model || 'claude-sonnet-5'
  return async (outline, topic) => {
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1500, system: REVIEW_PROMPT, messages: [{ role: 'user', content: outlineText(outline, topic) }] })
    })
    const raw = await res.text().catch(() => '')
    if (!res.ok) throw new Error(`Claude review HTTP ${res.status}${res.status === 429 ? ' (rate/usage limit)' : ''}`)
    let data: any = {}
    try { data = raw ? JSON.parse(raw) : {} } catch { throw new Error('Claude review returned invalid JSON') }
    const text = (data?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
    return { findings: parseFindings(text), model: String(data?.model || model) }
  }
}

const DECISION_SCHEMA = { type: 'object', additionalProperties: false, required: ['decisions'], properties: { decisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['index', 'action', 'reason'], properties: { index: { type: 'integer' }, action: { type: 'string', enum: ['accept', 'reject'] }, reason: { type: 'string' } } } } } }

// GPT: accept or reject each finding with a reason (the existing Responses call).
export function gptDecider(o: { apiKey: string; fetchImpl?: typeof fetch }): CrossReviewDeps['decider'] {
  return async (outline, findings, topic) => {
    const j = await respond(o.apiKey, 'plan_cross_review_decision', DECISION_SCHEMA,
      'You wrote this YouTube longform plan. An independent reviewer raised the numbered findings. For EACH finding decide accept (it is a real problem worth fixing) or reject (it is wrong or would hurt the plan) and give a one-sentence reason. Answer in Korean.',
      `${outlineText(outline, topic)}\n\nFindings:\n${findings.map((x, i) => `${i}. [${x.area}] ${x.problem} / 이유: ${x.reason} / 방향: ${x.direction}`).join('\n')}`, o.fetchImpl)
    const list: any[] = Array.isArray(j?.decisions) ? j.decisions : []
    if (list.length !== findings.length || new Set(list.map((x) => x?.index)).size !== findings.length) throw new Error('GPT review decisions missing or duplicated')
    return findings.map((_, i) => {
      const d = list.find((x) => x?.index === i)
      if (!d || !['accept', 'reject'].includes(d.action) || !String(d.reason || '').trim()) throw new Error('GPT review decision invalid or missing reason')
      return { index: i, action: d.action as 'accept' | 'reject', reason: String(d.reason).slice(0, 300) }
    })
  }
}

export function crossReviewFromEnv(env: Record<string, string | undefined> = process.env, openAiKey = ''): CrossReviewDeps | null {
  if (!planCrossReviewOn(env)) return null
  const key = env.ANTHROPIC_API_KEY || ''
  return {
    reviewer: key ? claudeReviewer({ apiKey: key, model: env.ANTHROPIC_STORY_MODEL }) : async () => { throw new Error('ANTHROPIC_API_KEY is not configured') },
    decider: gptDecider({ apiKey: openAiKey })
  }
}

// One pass: review -> decide -> (accepted findings only) ONE revision through the planner's own repair path.
// `revise` returns the revised outline; `errorsOf` is the planner's normal outline check. Never throws.
export async function runCrossReview(o: { outline: LongformOutline; topic: string; deps: CrossReviewDeps; revise: (repair: string[]) => Promise<LongformOutline>; errorsOf: (o: LongformOutline) => string[] }): Promise<{ outline: LongformOutline; record: CrossReviewRecord }> {
  const record: CrossReviewRecord = { schema: PLAN_CROSS_REVIEW_VERSION, status: 'fallback', order: ['gpt:plan'], reviewerModel: null, findings: [], decisions: [], fallbackReason: null }
  const fallback = (why: string) => { record.status = 'fallback'; record.fallbackReason = why.slice(0, 300); return { outline: o.outline, record } }
  try {
    record.order.push('claude:review')
    const r = await o.deps.reviewer(o.outline, o.topic)
    record.reviewerModel = r.model; record.findings = r.findings
  } catch (e: any) { return fallback(`claude review failed: ${String(e?.message || e)}`) }
  if (!record.findings.length) { record.status = 'no_findings'; return { outline: o.outline, record } }
  try {
    record.order.push('gpt:decide')
    const decisions = await o.deps.decider(o.outline, record.findings, o.topic)
    if (!Array.isArray(decisions) || decisions.length !== record.findings.length ||
        new Set(decisions.map((d) => d?.index)).size !== record.findings.length ||
        decisions.some((d) => !Number.isInteger(d?.index) || d.index < 0 || d.index >= record.findings.length ||
          !['accept', 'reject'].includes(d.action) || !String(d.reason || '').trim())) throw new Error('GPT returned incomplete review decisions')
    record.decisions = decisions
  } catch (e: any) { return fallback(`gpt decision failed: ${String(e?.message || e)}`) }
  const accepted = record.decisions.filter((d) => d.action === 'accept').map((d) => record.findings[d.index]).filter(Boolean)
  if (!accepted.length) { record.status = 'all_rejected'; return { outline: o.outline, record } }
  try {
    record.order.push('gpt:revise')
    const originalJson = JSON.stringify(o.outline)
    if (originalJson.length > 30000) return fallback('original outline too large for a safe one-pass revision')
    const revised = await o.revise([
      `Revise ONLY the accepted review findings. Preserve all unaffected people, scenes, story beats, and values. Original outline JSON: ${originalJson}`,
      ...accepted.map((x) => `[review:${x.area}] ${x.problem} -> ${x.direction}`)
    ])
    const errs = o.errorsOf(revised)
    if (errs.length) return fallback(`revised outline invalid: ${errs.slice(0, 5).join(', ')}`)
    record.status = 'revised'; record.fallbackReason = null
    return { outline: revised, record }
  } catch (e: any) { return fallback(`gpt revision failed: ${String(e?.message || e)}`) }
}
