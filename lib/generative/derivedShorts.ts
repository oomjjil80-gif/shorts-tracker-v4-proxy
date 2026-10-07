// Wisdom Longform -> derived Shorts. After the Longform script is final (inside its PLAN, before any image / voice is
// paid), ONE low-cost text call reads the finished script (+ the research the Longform already did; nothing is researched
// again) and proposes Shorts ideas with honest scores and the sentences they come from. Tracker then keeps only the
// strong, independent, non-overlapping ones (at most 5, possibly none) — deterministic, no second AI call.
// A chosen idea becomes an ordinary Wisdom Shorts job (same PLAN / IMAGE / TTS / caption / render / Screen DNA / FINAL)
// whose brief is the parent's own material: the parent script and research are the source of truth, no new facts.
import { createHash } from 'node:crypto'
import { respond, str } from './longformPlanner.js'
import type { LongformScript } from './longform.js'
import type { ResearchBundle } from './longformResearch.js'

export const DERIVED = { max: 5, ideas: 8, minScore: 4, hookMaxChars: 45, overlap: 0.5 } as const
export const DERIVE_MODEL = () => process.env.OPENAI_DERIVE_MODEL || 'gpt-5-mini'
export type DerivedScores = { hook: number; standalone: number; clarity: number; payoff: number; distinct: number }
export type DerivedIdea = { shortTitle: string; hook: string; corePoint: string; payoff: string; sourceClaim: string; thinker: string; sourceRefs: Array<{ section: number; sentence: number }>; scores: DerivedScores }
export type DerivedCandidate = Omit<DerivedIdea, 'scores'> & { id: string; score: number; source: string[] }
export type DerivedShortsDoc = { schema: 'derived-shorts/1'; parentLongformJobId: string; parentLongformTitle: string; model: string; candidates: DerivedCandidate[]; excluded: Array<{ shortTitle: string; reason: string }> }

const int = { type: 'integer', minimum: 1, maximum: 5 }
export const DERIVE_SCHEMA = { type: 'object', additionalProperties: false, required: ['ideas'], properties: { ideas: { type: 'array', maxItems: DERIVED.ideas, items: { type: 'object', additionalProperties: false,
  required: ['shortTitle', 'hook', 'corePoint', 'payoff', 'sourceClaim', 'thinker', 'sourceRefs', 'scores'],
  properties: { shortTitle: str, hook: str, corePoint: str, payoff: str, sourceClaim: str, thinker: str,
    sourceRefs: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['section', 'sentence'], properties: { section: { type: 'integer' }, sentence: { type: 'integer' } } } },
    scores: { type: 'object', additionalProperties: false, required: ['hook', 'standalone', 'clarity', 'payoff', 'distinct'], properties: { hook: int, standalone: int, clarity: int, payoff: int, distinct: int } } } } } } }

// the finished script as numbered lines the model can cite: [section.sentence]
export const numberedScript = (s: LongformScript) => s.sections.map((sec, i) => sec.sentences.map((x, j) => `[${i}.${j}] ${x.say.trim()}`).join('\n')).join('\n')

export async function openAiDeriveShorts(i: { script: LongformScript; research: ResearchBundle | null; repair?: string[] }, apiKey: string, f: typeof fetch = fetch): Promise<{ ideas: DerivedIdea[] }> {
  const instructions = [
    'You pick Korean YouTube SHORTS ideas (30-60 s each) out of a FINISHED Korean wisdom longform script. Use ONLY what the script (and its research notes) already say: no new facts, quotes or numbers.',
    `List at most ${DERIVED.ideas} ideas and score each honestly 1-5: hook (a 1-2 second opening line that stops the scroll), standalone (makes full sense without the longform), clarity (ONE clear message understood in 30-60 s), payoff (a small realisation at the end), distinct (not the same point as another idea). Weak ideas get low scores — do not inflate.`,
    'Good: a strong question, a surprising claim, a memorable example, a thinker\'s key insight, one scene from relationships/life the viewer can use today, a reversed perspective. Bad: a cut-out sentence, background explanation, a part that needs the rest of the video, the same point twice, CTA bait.',
    `Each idea: shortTitle, hook (the first spoken line, <= ${DERIVED.hookMaxChars} Korean characters), corePoint, payoff (the short is satisfying on its own; never "the answer is in the longform"), sourceClaim (the script's claim it rests on), thinker (the named thinker it is about, or ""), sourceRefs (the [section.sentence] lines it comes from).`
  ].join('\n')
  const notes = i.research?.fragments?.length ? `\n\nResearch notes the longform used:\n${i.research.fragments.map((x) => `${x.id}: ${x.claim}`).join('\n')}` : ''
  const input = `Longform title: ${i.script.title}\n\nScript (cite as [section.sentence]):\n${numberedScript(i.script)}${notes}${i.repair?.length ? `\n\n[REPAIR] ${i.repair.join(', ')}` : ''}`
  return respond(apiKey, 'derived_shorts', DERIVE_SCHEMA, instructions, input, f, DERIVE_MODEL())
}

const squash = (t: unknown) => String(t ?? '').replace(/[\s"'“”‘’.,!?…·\-]/g, '')
const grams = (t: unknown) => { const s = squash(t), g = new Set<string>(); for (let k = 0; k + 1 < s.length; k++) g.add(s.slice(k, k + 2)); return g }
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n) }
export const derivedId = (x: { shortTitle: string; corePoint: string }) => createHash('sha256').update(`${squash(x.shortTitle)}|${squash(x.corePoint)}`).digest('hex').slice(0, 16)

// keep only strong, grounded, independent ideas; best first; at most 5; zero is a valid answer
export function selectDerivedShorts(raw: any, script: LongformScript): { candidates: DerivedCandidate[]; excluded: Array<{ shortTitle: string; reason: string }> } {
  const ideas: any[] = Array.isArray(raw?.ideas) ? raw.ideas : [], excluded: Array<{ shortTitle: string; reason: string }> = [], ok: DerivedCandidate[] = []
  for (const x of ideas) {
    const title = String(x?.shortTitle || '').trim(), why = (reason: string) => excluded.push({ shortTitle: title, reason })
    if (['shortTitle', 'hook', 'corePoint', 'payoff', 'sourceClaim'].some((k) => !String(x?.[k] || '').trim())) { why('missing fields'); continue }
    if ([...String(x.hook).trim()].length > DERIVED.hookMaxChars) { why('hook too long'); continue }
    const refs = (Array.isArray(x.sourceRefs) ? x.sourceRefs : []).filter((r: any) => script.sections[r?.section]?.sentences?.[r?.sentence])
    if (!refs.length || refs.length !== (x.sourceRefs ?? []).length) { why('source reference not in the script'); continue }
    const sc = x.scores ?? {}, vals = ['hook', 'standalone', 'clarity', 'payoff', 'distinct'].map((k) => Number(sc[k]) || 0)
    if (vals.some((v) => v < DERIVED.minScore)) { why(`weak (${vals.join('/')})`); continue }
    const c: DerivedCandidate = { id: derivedId(x), shortTitle: title, hook: String(x.hook).trim(), corePoint: String(x.corePoint).trim(), payoff: String(x.payoff).trim(), sourceClaim: String(x.sourceClaim).trim(), thinker: String(x.thinker || '').trim(), sourceRefs: refs.map((r: any) => ({ section: Number(r.section), sentence: Number(r.sentence) })), score: vals.reduce((a, b) => a + b, 0), source: refs.map((r: any) => script.sections[r.section].sentences[r.sentence].say.trim()) }
    ok.push(c)
  }
  ok.sort((a, b) => b.score - a.score)
  const kept: DerivedCandidate[] = []
  for (const c of ok) {
    const g = grams(`${c.shortTitle} ${c.corePoint}`), refKeys = new Set(c.sourceRefs.map((r) => `${r.section}.${r.sentence}`))
    const dup = kept.find((k) => jaccard(g, grams(`${k.shortTitle} ${k.corePoint}`)) >= DERIVED.overlap || k.sourceRefs.filter((r) => refKeys.has(`${r.section}.${r.sentence}`)).length * 2 > Math.min(k.sourceRefs.length, refKeys.size))
    if (dup) { excluded.push({ shortTitle: c.shortTitle, reason: `overlaps "${dup.shortTitle}"` }); continue }
    if (kept.length >= DERIVED.max) { excluded.push({ shortTitle: c.shortTitle, reason: 'beyond the 5 best' }); continue }
    kept.push(c)
  }
  return { candidates: kept, excluded }
}
export const deriveErrors = (raw: any): string[] => (Array.isArray(raw?.ideas) ? [] : ['ideas'])

// the child Wisdom Shorts brief text: the parent's own material and the rules that keep it there
export function derivedSourceText(c: DerivedCandidate, parentTitle: string): string {
  return [
    `[파생 쇼츠 — 원본 롱폼 「${parentTitle}」에서 가져온 소재]`,
    c.thinker ? `인물: ${c.thinker}` : '',
    `쇼츠 제목: ${c.shortTitle}`,
    `첫 문장(훅): ${c.hook}`,
    `핵심 메시지: ${c.corePoint}`,
    `작은 깨달음(payoff): ${c.payoff}`,
    `근거가 되는 주장: ${c.sourceClaim}`,
    `원본 롱폼의 해당 부분: ${c.source.join(' ')}`,
    '[규칙] 위 원본 내용 안에서만 만든다. 새로운 사실·인용·숫자를 더하지 않는다. 첫 문장은 위 훅으로 시작한다. 이 쇼츠 하나만 봐도 이해되고 끝에 작은 깨달음이 있어야 한다("결론은 롱폼에서" 식으로 일부러 비워 두지 않는다).'
  ].filter(Boolean).join('\n')
}
