// 카드별 VISUAL PLAN(피사체·구도·차별점)의 무료 규칙 검사. 소재 종류에 상관없이 같은 규칙을 쓴다(특정 소재 하드코딩 없음).
// 이미지(유료)를 만들기 전에 실행하고, 문제가 있는 장의 계획만 고친다. 의미적 판단(이야기에 가장 맞는 장면인가)은 AI 설계 단계가 맡는다.
export type VisualPlan = { subject: string; composition: string; distinction: string }
export type PlanCard = { id: string; role?: string; headline: string; body: string; visualPlan?: VisualPlan | null }
export type PlanIssue = { cardId: string; code: 'MISSING_PLAN' | 'DUPLICATE_SUBJECT' | 'DUPLICATE_COMPOSITION' | 'CONTENT_MISMATCH' | 'EARLY_REVEAL'; message: string }

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
export function cleanPlan(v: any): VisualPlan | null {
  const subject = clean(v?.subject).slice(0, 240), composition = clean(v?.composition).slice(0, 240), distinction = clean(v?.distinction).slice(0, 240)
  return subject.length >= 2 && composition.length >= 2 && distinction.length >= 2 ? { subject, composition, distinction } : null
}
const words = (s: string) => new Set(clean(s).toLowerCase().split(/[^0-9a-z가-힣]+/).filter((w) => w.length >= 2))
const bigrams = (s: string) => { const t = clean(s).toLowerCase().replace(/[^0-9a-z가-힣]/g, ''), out = new Set<string>(); for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2)); return out }
// 조사·어미처럼 거의 모든 글에 나오는 음절은 내용 비교에서 뺀다
const FUNCTION_SYLLABLES = new Set([...'의이가은는을를에와과도로으다한하고서지인기있없며면게나라니요그저것수들'])
const syllables = (s: string) => new Set([...clean(s).toLowerCase().replace(/[^0-9a-z가-힣]/g, '')].filter((ch) => !FUNCTION_SYLLABLES.has(ch)))
export const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n) }

export const SIMILAR = { subject: 0.62, composition: 0.7 } as const

export function planIssues(cards: readonly PlanCard[], cover: { title?: string; promise?: string; coverLine?: string } = {}): PlanIssue[] {
  const issues: PlanIssue[] = [], add = (cardId: string, code: PlanIssue['code'], message: string) => { if (!issues.some((i) => i.cardId === cardId && i.code === code)) issues.push({ cardId, code, message }) }
  const plans = cards.map((c) => cleanPlan(c.visualPlan))
  cards.forEach((c, i) => {
    const p = plans[i]
    if (!p) return add(c.id, 'MISSING_PLAN', '장면 계획(피사체·구도·차별점)이 없습니다.')
    for (let j = 0; j < i; j++) {
      const q = plans[j]; if (!q) continue
      if (jaccard(bigrams(p.subject), bigrams(q.subject)) >= SIMILAR.subject) add(c.id, 'DUPLICATE_SUBJECT', `${j + 1}장과 피사체가 같거나 매우 비슷합니다.`)
      if (jaccard(words(p.composition), words(q.composition)) >= SIMILAR.composition || clean(p.composition) === clean(q.composition)) add(c.id, 'DUPLICATE_COMPOSITION', `${j + 1}장과 구도가 같거나 매우 비슷합니다.`)
    }
    // 시각화 대상은 이 장의 글(또는 전체 제목)과 이어져야 한다: 내용 음절이 하나도 겹치지 않으면 엉뚱한 장면이다(미묘한 의미 차이는 AI 설계 단계가 본다)
    const own = syllables(`${c.headline} ${c.body} ${cover.title ?? ''} ${cover.promise ?? ''} ${cover.coverLine ?? ''}`), subj = syllables(p.subject)
    if (subj.size && ![...subj].some((g) => own.has(g))) add(c.id, 'CONTENT_MISMATCH', '시각화 대상이 이 장의 내용과 이어지지 않습니다.')
  })
  // 결말에서 처음 공개되는 말(마지막 장 제목에만 있고 앞 장 글에는 없는 낱말)은 앞 장의 장면 계획에 나오면 안 된다
  if (cards.length >= 3) {
    const last = cards[cards.length - 1], earlierText = cards.slice(0, -1).map((c) => `${c.headline} ${c.body}`).join(' ') + ` ${cover.title ?? ''}`
    const reveal = [...words(last.headline)].filter((w) => w.length >= 2 && !earlierText.toLowerCase().includes(w))
    if (reveal.length) cards.slice(0, -1).forEach((c, i) => { const p = plans[i]; if (!p) return; const hay = `${p.subject} ${p.composition} ${p.distinction}`.toLowerCase(); const hit = reveal.find((w) => hay.includes(w)); if (hit) add(c.id, 'EARLY_REVEAL', `마지막 장에서 공개할 "${hit}"을(를) 앞 장 장면 계획에서 미리 드러냅니다.`) })
  }
  return issues
}
