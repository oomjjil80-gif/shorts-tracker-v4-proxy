// Wisdom Longform RESEARCH: request shape (gpt-6-luna + web_search, low effort, no budget/deep-research knobs), cost
// guards (billing/auth stop with 0 retries, transient errors retried once), bundle normalization (sources, direct-quote
// guard, section map) and the per-section prompt (only that section's fragments). A fake Responses API; no paid calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openAiLongformResearcher, normalizeResearch, researchErrors, researchTarget, researchKey, researchPath, researchSchema, sectionFragments,
  classifyOpenAiError, RESEARCH_MODEL, type ResearchBundle
} from '../lib/generative/longformResearch.js'
import { openAiLongformPlanner } from '../lib/generative/longformPlanner.js'
import { sectionPlan } from '../lib/generative/longform.js'
import { researchJson } from './researchFixture.js'

const TOPIC = '부처님이 말한 인생의 마지막 공부｜죽기 전에 반드시 깨달아야 할 7가지'
const SECTIONS = sectionPlan(3600).sections
const SEEN = (k: number) => `https://suttacentral.net/dn16/en/sujato#${k}`

function responsesApi(script: Array<{ status: number; body?: any } | 'network'>) {
  const calls: any[] = []
  const f = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) })
    const step = script[Math.min(calls.length - 1, script.length - 1)]
    if (step === 'network') throw new TypeError('fetch failed')
    if (step.status !== 200) return new Response(typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {}), { status: step.status })
    const data = step.body ?? researchJson()
    const seen = (data.fragments as any[]).filter((x) => x.sourceUrl).map((x) => ({ type: 'url', url: x.sourceUrl }))
    return new Response(JSON.stringify({ model: 'gpt-6-luna', output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'q1', sources: seen.slice(0, 12) } },
      { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'q2', sources: seen.slice(12) } },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data), annotations: [] }] }
    ] }), { status: 200 })
  }) as any
  return { f, calls }
}
const noSleep = async () => {}

test('request: gpt-6-luna + web_search (not the legacy preview), low reasoning, default search budget, no Deep Research', async () => {
  const prev = process.env.OPENAI_PLAN_MODEL; process.env.OPENAI_PLAN_MODEL = 'gpt-6-sol' // never follows the plan-model env
  try {
    const api = responsesApi([{ status: 200 }])
    const r = await openAiLongformResearcher(api.f, noSleep)({ topic: TOPIC, sections: SECTIONS }, 'k')
    assert.equal(api.calls.length, 1); assert.equal(r.requests, 1); assert.equal(r.webSearchCalls, 2)
    const b = api.calls[0].body
    assert.equal(api.calls[0].url, 'https://api.openai.com/v1/responses')
    assert.equal(b.model, 'gpt-6-luna'); assert.equal(RESEARCH_MODEL, 'gpt-6-luna')
    assert.deepEqual(b.tools, [{ type: 'web_search' }])
    assert.deepEqual(b.reasoning, { effort: 'low' })
    const raw = JSON.stringify(b)
    assert.doesNotMatch(raw, /web_search_preview|return_token_budget|unlimited|deep-research|o3-deep|gpt-6-sol|gpt-6-astra|background/)
    assert.equal(b.text.format.type, 'json_schema'); assert.equal(b.text.format.strict, true)
    assert.equal(r.bundle.model, 'gpt-6-luna'); assert.equal(r.bundle.topic, TOPIC)
  } finally { if (prev === undefined) delete process.env.OPENAI_PLAN_MODEL; else process.env.OPENAI_PLAN_MODEL = prev }
})

for (const [name, status, body] of [
  ['credit_balance_exhausted (429)', 429, { error: { code: 'credit_balance_exhausted', message: 'Your credit balance is too low' } }],
  ['insufficient_quota (429)', 429, { error: { code: 'insufficient_quota', type: 'insufficient_quota', message: 'You exceeded your current quota' } }],
  ['billing_hard_limit (400)', 400, { error: { code: 'billing_hard_limit_reached', message: 'Billing hard limit has been reached' } }],
  ['401', 401, { error: { code: 'invalid_api_key', message: 'Incorrect API key' } }],
  ['403', 403, { error: { code: 'unsupported_country_region_territory' } }]
] as const) test(`STOP: ${name} -> fails at once, 0 retries`, async () => {
  const api = responsesApi([{ status, body }, { status: 200 }])
  await assert.rejects(() => openAiLongformResearcher(api.f, noSleep)({ topic: TOPIC, sections: SECTIONS }, 'k'), (e: any) => e.stop === true && e.requests === 1 && !/Bearer/.test(e.message))
  assert.equal(api.calls.length, 1)
})

test('transient: a 5xx / network error / plain rate limit is retried ONCE; a second failure stops', async () => {
  for (const first of [{ status: 500, body: { error: { message: 'server_error' } } }, { status: 503 }, 'network' as const, { status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests' } } }]) {
    const ok = responsesApi([first as any, { status: 200 }])
    const r = await openAiLongformResearcher(ok.f, noSleep)({ topic: TOPIC, sections: SECTIONS }, 'k')
    assert.equal(ok.calls.length, 2); assert.equal(r.requests, 2)
    const bad = responsesApi([first as any, first as any, { status: 200 }])
    await assert.rejects(() => openAiLongformResearcher(bad.f, noSleep)({ topic: TOPIC, sections: SECTIONS }, 'k'), (e: any) => e.stop === false && e.requests === 2)
    assert.equal(bad.calls.length, 2, 'never a third request')
  }
  assert.equal(classifyOpenAiError(429, '{"error":{"code":"credit_balance_exhausted"}}').stop, true)
  assert.equal(classifyOpenAiError(429, '{"error":{"code":"rate_limit_exceeded"}}').stop, false)
})

test('schema: a 60-minute talk asks for 20-30 fragments over 11 sections; a 24-fragment answer validates', async () => {
  assert.equal(SECTIONS, 11)
  assert.deepEqual(researchTarget(SECTIONS), { min: 20, max: 30 })
  const s: any = researchSchema(SECTIONS)
  assert.deepEqual([s.properties.sectionMap.minItems, s.properties.sectionMap.maxItems], [11, 11])
  assert.deepEqual(s.properties.fragments.items.required, ['id', 'type', 'claim', 'story', 'sourceTitle', 'sourceUrl', 'confidence', 'usableAsDirectBuddhaQuote', 'storyValue'])
  const r = await openAiLongformResearcher(responsesApi([{ status: 200 }]).f, noSleep)({ topic: TOPIC, sections: SECTIONS }, 'k')
  assert.equal(r.bundle.fragments.length, 24); assert.deepEqual(researchErrors(r.bundle, SECTIONS), [])
  assert.deepEqual(Object.keys(r.bundle).sort(), ['fragments', 'model', 'researchedAt', 'sectionMap', 'topic'])
  assert.deepEqual(Object.keys(r.bundle.fragments[0]).sort(), ['claim', 'confidence', 'id', 'sourceTitle', 'sourceUrl', 'story', 'storyValue', 'type', 'usableAsDirectBuddhaQuote'])
  // each section has its own fragments (no fragment reused across sections)
  const ids = r.bundle.sectionMap.flatMap((m) => m.fragmentIds)
  assert.equal(new Set(ids).size, ids.length)
  // the key is deterministic per (version, sections, topic); whitespace does not change it
  assert.equal(researchKey(TOPIC, 11), researchKey(`  ${TOPIC.replace('｜', '｜ ')}`.replace('｜ ', '｜'), 11))
  assert.notEqual(researchKey(TOPIC, 11), researchKey(TOPIC, 21))
  assert.match(researchPath(TOPIC, 11), /^longform-research\/[0-9a-f]{64}\.json$/)
  // too few usable fragments fails validation (never silently passes)
  assert.ok(researchErrors(normalizeResearch(researchJson(SECTIONS, 6), SECTIONS), SECTIONS).some((e) => e.startsWith('fragments.count')))
})

test('sources: a teaching/story/interpretation without sourceTitle + a real URL is dropped; a modern example may be sourceless; the section map is repaired', () => {
  const raw = researchJson(3, 8)
  raw.fragments[0] = { ...raw.fragments[0], sourceUrl: '' }                       // scripture, no URL -> dropped
  raw.fragments[1] = { ...raw.fragments[1], sourceTitle: '' }                     // story, no title -> dropped
  raw.fragments[2] = { ...raw.fragments[2], sourceUrl: 'not a url' }              // interpretation, bad URL -> dropped
  raw.fragments[3] = { ...raw.fragments[3], sourceTitle: '', sourceUrl: '' }      // modern example -> kept
  const b = normalizeResearch(raw, 3)
  assert.deepEqual(b.fragments.map((x) => x.id), ['f4', 'f5', 'f6', 'f7', 'f8'])
  assert.deepEqual([b.fragments[0].sourceTitle, b.fragments[0].sourceUrl], ['', ''])
  // section 1 had f1+f2 (both dropped): it gets the best unused fragment, never stays empty
  assert.equal(b.sectionMap[0].fragmentIds.length, 1); assert.ok(!['f1', 'f2'].includes(b.sectionMap[0].fragmentIds[0]))
  assert.deepEqual(b.sectionMap[1].fragmentIds, ['f4']); assert.deepEqual(researchErrors(b, 3), [])
})

test('direct Buddha quote: only a sourced, high-confidence scripture (not a wiki/blog, and a page the search saw) may be quoted', () => {
  const f = (o: any) => ({ id: 'x', type: 'scripture', claim: 'c', story: 's', sourceTitle: 'Dhammapada 1', sourceUrl: SEEN(1), confidence: 'high', usableAsDirectBuddhaQuote: true, storyValue: 4, ...o })
  const seen = new Set([`suttacentral.net/dn16/en/sujato`])
  const one = (o: any, s = seen) => normalizeResearch({ fragments: [f(o)], sectionMap: [{ section: 1, fragmentIds: ['x'], purpose: '' }] }, 1, s).fragments[0]
  assert.equal(one({}).usableAsDirectBuddhaQuote, true)
  assert.equal(one({ type: 'traditional_story' }).usableAsDirectBuddhaQuote, false)
  assert.equal(one({ type: 'interpretation' }).usableAsDirectBuddhaQuote, false)
  assert.equal(one({ type: 'modern_example' }).usableAsDirectBuddhaQuote, false)
  assert.equal(one({ confidence: 'medium' }).usableAsDirectBuddhaQuote, false)
  const wiki = one({ sourceUrl: 'https://en.wikipedia.org/wiki/Dhammapada' }, new Set())
  assert.deepEqual([wiki.usableAsDirectBuddhaQuote, wiki.confidence], [false, 'medium'])
  assert.equal(one({ sourceUrl: 'https://someone.tistory.com/12' }, new Set()).usableAsDirectBuddhaQuote, false)
  // a URL the web search never returned (likely invented) -> low confidence, never a quote
  const unseen = one({ sourceUrl: 'https://www.accesstoinsight.org/tipitaka/kn/dhp/dhp.01.budd.html' })
  assert.deepEqual([unseen.usableAsDirectBuddhaQuote, unseen.confidence], [false, 'low'])
})

test('prompts: the outline gets every fragment as one short line + the section map; a section gets ONLY its own fragments', async () => {
  const bundle: ResearchBundle = { ...normalizeResearch(researchJson(), SECTIONS), topic: TOPIC, model: 'gpt-6-luna', researchedAt: 'now' }
  const sent: any[] = []
  const f = (async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ output_text: JSON.stringify({ sentences: [] }) }), { status: 200 }) }) as any
  const p = openAiLongformPlanner(f)
  const brief: any = { text: TOPIC, kind: 'topic', targetSeconds: 3600 }
  await p.outline(brief, SECTIONS, 'k', undefined, bundle)
  const o = sent[0]
  for (const x of bundle.fragments) assert.ok(o.input.includes(`[${x.id}]`))
  assert.ok(!o.input.includes('이야기 1:'), 'the outline does not carry the full stories')
  assert.match(o.input, /Section map:\n1\. f1, f2 — 구간 1/)
  assert.match(o.instructions, /only fragments marked DIRECT-QUOTE-OK may be said as the Buddha's own words/)
  const outline: any = { title: 't', hook: 'h', sections: bundle.sectionMap.map((m) => ({ id: `s${m.section}`, heading: `h${m.section}`, points: ['a', 'b'] })) }
  await p.section({ brief, outline, index: 3, previousTail: [], targetChars: 2000, fragments: sectionFragments(bundle, 3) }, 'k')
  const s = sent[1], mine = bundle.sectionMap[3].fragmentIds
  assert.deepEqual(mine, ['f7', 'f8'])
  const mentioned = [...s.input.matchAll(/\[(f\d+)\]/g)].map((m: any) => m[1])
  assert.deepEqual(mentioned, mine, 'only this section\'s fragments are sent')
  assert.ok(s.input.includes('이야기 7:'), 'the section gets its fragments\' stories')
  assert.ok(s.input.length < o.input.length)
  // without research the prompts are unchanged (no research text)
  await p.section({ brief, outline, index: 0, previousTail: [], targetChars: 2000 }, 'k')
  assert.doesNotMatch(sent[2].input + sent[2].instructions, /fragment/i)
})
