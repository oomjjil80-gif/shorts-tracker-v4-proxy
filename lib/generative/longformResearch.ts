// Wisdom Longform RESEARCH: one low-cost web-search pass (gpt-6-luna, Responses API web_search, low reasoning) that
// collects distinct, sourced story material for the whole talk BEFORE the outline is written. One request per topic:
// the bundle is stored under a deterministic key and reused by every retry of PLAN / later stages and by later jobs on
// the same topic. Billing/auth errors stop at once; only a transient network/5xx/rate error is retried, once.
import { createHash } from 'node:crypto'

export const RESEARCH_VERSION = 'longform-research/1'
// fixed: never read from env, never upgraded to a larger model, no fallback model
export const RESEARCH_MODEL = 'gpt-6-luna'

export type ResearchFragmentType = 'scripture' | 'traditional_story' | 'interpretation' | 'modern_example'
export type ResearchFragment = {
  id: string
  type: ResearchFragmentType
  claim: string
  story: string
  sourceTitle: string
  sourceUrl: string
  confidence: 'high' | 'medium' | 'low'
  usableAsDirectBuddhaQuote: boolean
  storyValue: number
}
export type ResearchBundle = {
  topic: string
  model: string
  researchedAt: string
  fragments: ResearchFragment[]
  sectionMap: { section: number; fragmentIds: string[]; purpose: string }[]
}
export type ResearchCall = { bundle: ResearchBundle; requests: number; webSearchCalls: number | null }
export type LongformResearcher = (i: { topic: string; sections: number }, apiKey: string) => Promise<ResearchCall>

const TYPES: ResearchFragmentType[] = ['scripture', 'traditional_story', 'interpretation', 'modern_example']
const CONFIDENCE = ['high', 'medium', 'low'] as const

// how much material a talk needs: ~20-30 fragments for 60 minutes (11 sections); capped so a long talk stays cheap
export function researchTarget(sections: number): { min: number; max: number } {
  const min = Math.min(36, Math.max(8, Math.round(sections * 1.8)))
  return { min, max: Math.min(40, Math.max(min, Math.round(sections * 2.7))) }
}
const normTopic = (t: string) => String(t || '').normalize('NFC').replace(/\s+/g, ' ').trim()
export const researchKey = (topic: string, sections: number) => createHash('sha256').update(`${RESEARCH_VERSION}|${sections}|${normTopic(topic)}`).digest('hex')
export const researchPath = (topic: string, sections: number) => `longform-research/${researchKey(topic, sections)}.json`

// ---------- provider errors: STOP (never retried) vs transient (retried once) ----------
export class ProviderError extends Error {
  constructor(message: string, public code: string, public stop: boolean, public status?: number) { super(message); this.name = 'ProviderError' }
}
const BILLING = /insufficient_quota|credit_balance|billing|quota_exceeded|exceeded your current quota|payment/i
export function classifyOpenAiError(status: number, body: string): ProviderError {
  const text = String(body || '').slice(0, 300)
  const code = /"code"\s*:\s*"([a-z_]+)"/i.exec(text)?.[1] || `http_${status}`
  if (BILLING.test(text)) return new ProviderError(`OpenAI billing stop (HTTP ${status}): ${text}`, /credit_balance/i.test(text) ? 'credit_balance_exhausted' : 'insufficient_quota', true, status)
  if (status === 401 || status === 403) return new ProviderError(`OpenAI auth stop (HTTP ${status})`, code, true, status)
  if (status >= 500 || status === 408 || status === 429) return new ProviderError(`OpenAI HTTP ${status}: ${text}`, code, false, status)
  return new ProviderError(`OpenAI HTTP ${status}: ${text}`, code, true, status) // other 4xx: the same request would fail again
}

// ---------- the one research request ----------
const s = { type: 'string' }
export function researchSchema(sections: number) {
  return { type: 'object', additionalProperties: false, required: ['fragments', 'sectionMap'], properties: {
    fragments: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'type', 'claim', 'story', 'sourceTitle', 'sourceUrl', 'confidence', 'usableAsDirectBuddhaQuote', 'storyValue'],
      properties: { id: s, type: { type: 'string', enum: TYPES }, claim: s, story: s, sourceTitle: s, sourceUrl: s, confidence: { type: 'string', enum: CONFIDENCE }, usableAsDirectBuddhaQuote: { type: 'boolean' }, storyValue: { type: 'integer' } } } },
    sectionMap: { type: 'array', minItems: sections, maxItems: sections, items: { type: 'object', additionalProperties: false, required: ['section', 'fragmentIds', 'purpose'], properties: { section: { type: 'integer' }, fragmentIds: { type: 'array', items: s }, purpose: s } } }
  } }
}
export function researchInstructions(sections: number): string {
  const { min, max } = researchTarget(sections)
  return [
    `You gather story material for ONE Korean wisdom LONGFORM YouTube talk of ${sections} sections. Search the web efficiently: a few focused searches, never the same fact twice.`,
    `Return ${min}-${max} fragments. Each fragment is a DIFFERENT event, parable, teaching or life lesson (no paraphrases of the same idea like "let go of attachment / greed / empty the mind").`,
    'type: scripture = a teaching clearly found in a canonical text (sutta/sutra; name it in sourceTitle, e.g. "Dhammapada 1-2", "Maha-parinibbana Sutta (DN 16)"); traditional_story = a later/handed-down anecdote or parable (e.g. Kisa Gotami); interpretation = a Buddhist reading/commentary; modern_example = an everyday modern situation the teaching applies to.',
    'claim: one sentence stating the point. story: 2-4 sentences of concrete, tellable content (who, what happened, what changed). Korean.',
    'sourceTitle + sourceUrl: the real page you found it on. Prefer the canonical text, universities/academic sites, established Buddhist institutions and reliable translations (e.g. SuttaCentral, Access to Insight). Wikipedia or a personal blog is never the only source for a scripture claim. modern_example may have empty source fields.',
    'usableAsDirectBuddhaQuote: true ONLY when the canonical text records the Buddha saying it and you found that text; if unsure, false. confidence: high/medium/low. storyValue: 1-5 (how vivid and tellable).',
    `sectionMap: exactly ${sections} entries, section 1..${sections} in talk order (opening, development, turn, ending). Each section gets 2-3 fragment ids mixing a teaching, a story/parable and a modern example; no fragment in more than one section where avoidable. purpose: one short line saying what that section does.`,
    'Keep the output compact: no extra commentary.'
  ].join('\n')
}
const urlOk = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' } catch { return false } }
const urlId = (u: string) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}` } catch { return '' } }
const WEAK_SOURCE = /(^|\.)(wikipedia\.org|namu\.wiki|blog\.naver\.com|tistory\.com|brunch\.co\.kr|medium\.com|blogspot\.com|wordpress\.com)$|^blog\./i

export const openAiLongformResearcher = (f: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): LongformResearcher =>
  async ({ topic, sections }, apiKey) => {
    if (!apiKey) throw new ProviderError('OPENAI_API_KEY missing', 'no_api_key', true)
    const body = JSON.stringify({
      model: RESEARCH_MODEL, reasoning: { effort: 'low' }, tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'],
      instructions: researchInstructions(sections), input: `Topic: ${normTopic(topic).slice(0, 1500)}`,
      text: { format: { type: 'json_schema', name: 'wisdom_longform_research', strict: true, schema: researchSchema(sections) } }
    })
    let requests = 0, last: ProviderError | null = null
    for (let attempt = 0; attempt < 2; attempt++) { // the first request + at most ONE retry, only for a transient error
      if (attempt) await sleep(3000)
      requests++
      let res: Response
      try { res = await f('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body }) }
      catch (e: any) { last = new ProviderError(`OpenAI network error: ${String(e?.message || e).slice(0, 200)}`, 'network', false); continue }
      if (!res.ok) { last = classifyOpenAiError(res.status, await res.text().catch(() => '')); if (last.stop) break; continue }
      const j: any = await res.json()
      const out = Array.isArray(j.output) ? j.output : []
      const raw = j.output_text ?? out.flatMap((x: any) => x.content ?? []).find((x: any) => x.type === 'output_text')?.text
      if (!raw) throw new ProviderError('OpenAI research returned no output_text', 'no_output', true)
      const calls = out.filter((x: any) => x?.type === 'web_search_call')
      const seen = calls.flatMap((x: any) => (Array.isArray(x?.action?.sources) ? x.action.sources : []).map((z: any) => urlId(String(z?.url || '')))).filter(Boolean)
      const cited = out.flatMap((x: any) => x.content ?? []).flatMap((c: any) => c.annotations ?? []).map((a: any) => urlId(String(a?.url || ''))).filter(Boolean)
      const bundle = normalizeResearch({ ...JSON.parse(raw), topic: normTopic(topic), model: String(j.model || RESEARCH_MODEL), researchedAt: new Date().toISOString() }, sections, new Set([...seen, ...cited]))
      return { bundle, requests, webSearchCalls: out.length ? calls.length : null }
    }
    if (last) { (last as any).requests = requests; throw last }
    throw new ProviderError('OpenAI research failed', 'unknown', true)
  }

// ---------- normalize + validate (free, deterministic; never another paid call) ----------
// - a scripture/story/interpretation without a real source URL + title is dropped (a modern example may be sourceless)
// - a direct Buddha quote is allowed only for a sourced, high-confidence scripture fragment whose source is not a
//   wiki/blog and (when the search returned its source list) a page the search actually saw
// - the section map keeps only known ids; an empty section gets the best unused fragment
export function normalizeResearch(raw: any, sections: number, seenSources: Set<string> = new Set()): ResearchBundle {
  const ids = new Set<string>()
  const fragments: ResearchFragment[] = []
  for (const [k, f] of (Array.isArray(raw?.fragments) ? raw.fragments : []).entries()) {
    const type = TYPES.includes(f?.type) ? f.type as ResearchFragmentType : null
    const claim = String(f?.claim || '').trim(), story = String(f?.story || '').trim()
    let sourceTitle = String(f?.sourceTitle || '').trim(), sourceUrl = String(f?.sourceUrl || '').trim()
    if (!type || !claim || !story) continue
    const sourced = !!sourceTitle && urlOk(sourceUrl)
    if (!sourced && type !== 'modern_example') continue
    if (!sourced) { sourceTitle = ''; sourceUrl = '' }
    let id = String(f?.id || '').trim() || `f${k + 1}`
    while (ids.has(id)) id = `${id}_${k + 1}`
    ids.add(id)
    let confidence = (CONFIDENCE as readonly string[]).includes(f?.confidence) ? f.confidence as ResearchFragment['confidence'] : 'low'
    const host = sourced ? new URL(sourceUrl).hostname : ''
    const unseen = sourced && seenSources.size > 0 && !seenSources.has(urlId(sourceUrl))
    if (unseen) confidence = 'low'
    else if (type === 'scripture' && WEAK_SOURCE.test(host) && confidence === 'high') confidence = 'medium'
    const usableAsDirectBuddhaQuote = f?.usableAsDirectBuddhaQuote === true && type === 'scripture' && sourced && confidence === 'high' && !WEAK_SOURCE.test(host)
    const storyValue = Math.max(1, Math.min(5, Math.round(Number(f?.storyValue) || 1)))
    fragments.push({ id, type, claim, story, sourceTitle, sourceUrl, confidence, usableAsDirectBuddhaQuote, storyValue })
  }
  const known = new Set(fragments.map((x) => x.id)), used = new Set<string>()
  const rawMap = Array.isArray(raw?.sectionMap) ? raw.sectionMap : []
  const sectionMap = Array.from({ length: sections }, (_, i) => {
    const m = rawMap.find((x: any) => Number(x?.section) === i + 1) ?? rawMap[i]
    const fragmentIds = [...new Set<string>((Array.isArray(m?.fragmentIds) ? m.fragmentIds : []).map(String))].filter((x) => known.has(x))
    fragmentIds.forEach((x) => used.add(x))
    return { section: i + 1, fragmentIds, purpose: String(m?.purpose || '').trim() }
  })
  const spare = fragments.filter((x) => !used.has(x.id)).sort((a, b) => b.storyValue - a.storyValue)
  for (const m of sectionMap) if (!m.fragmentIds.length && spare.length) m.fragmentIds.push(spare.shift()!.id)
  return { topic: String(raw?.topic || ''), model: String(raw?.model || RESEARCH_MODEL), researchedAt: String(raw?.researchedAt || ''), fragments, sectionMap }
}
export function researchErrors(b: ResearchBundle | null, sections: number): string[] {
  if (!b || !Array.isArray(b.fragments) || !Array.isArray(b.sectionMap)) return ['bundle']
  const e: string[] = []
  if (b.fragments.length < sections) e.push(`fragments.count ${b.fragments.length} < ${sections}`)
  if (b.sectionMap.length !== sections) e.push(`sectionMap.count ${b.sectionMap.length}/${sections}`)
  if (b.sectionMap.some((m) => !m.fragmentIds.length)) e.push('sectionMap.empty')
  return e
}

// only what one section needs: its own fragments (never the whole bundle)
export function sectionFragments(b: ResearchBundle | null | undefined, index: number): ResearchFragment[] {
  if (!b) return []
  const ids = b.sectionMap[index]?.fragmentIds ?? []
  return ids.map((id) => b.fragments.find((f) => f.id === id)).filter(Boolean) as ResearchFragment[]
}
const TYPE_KO: Record<ResearchFragmentType, string> = { scripture: '경전', traditional_story: '전승 일화', interpretation: '불교적 해석', modern_example: '현대 예시' }
export function fragmentLine(f: ResearchFragment, withStory: boolean): string {
  const quote = f.usableAsDirectBuddhaQuote ? 'DIRECT-QUOTE-OK' : 'NOT a direct Buddha quote'
  return `[${f.id}] (${f.type}/${TYPE_KO[f.type]}, ${f.confidence}, ${quote}${f.sourceTitle ? `, ${f.sourceTitle}` : ''}) ${f.claim}${withStory ? ` — ${f.story}` : ''}`
}
export const FACT_RULES = 'Facts: only fragments marked DIRECT-QUOTE-OK may be said as the Buddha\'s own words ("부처님께서 말씀하셨다"). Everything else is told as what it is: a handed-down story ("~라는 이야기가 전해집니다"), a Buddhist interpretation ("불교에서는 ~라고 봅니다") or a modern example. Never invent a quote, a sutra name or a source.'
