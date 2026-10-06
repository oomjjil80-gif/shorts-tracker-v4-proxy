// A research answer as the model would return it for a 60-minute talk (shared by the research tests).
import { sectionPlan } from '../lib/generative/longform.js'

const SECTIONS = sectionPlan(3600).sections
// 24 distinct fragments + an 11-entry section map
export function researchJson(sections = SECTIONS, n = 24) {
  const types = ['scripture', 'traditional_story', 'interpretation', 'modern_example'] as const
  const fragments = Array.from({ length: n }, (_, k) => ({
    id: `f${k + 1}`, type: types[k % 4], claim: `가르침 ${k + 1}`, story: `이야기 ${k + 1}: 구체적인 사건과 변화.`,
    sourceTitle: types[k % 4] === 'modern_example' ? '' : `Source ${k + 1}`, sourceUrl: types[k % 4] === 'modern_example' ? '' : `https://suttacentral.net/dn16/en/sujato?p=${k + 1}`,
    confidence: 'high', usableAsDirectBuddhaQuote: k % 4 === 0, storyValue: 1 + (k % 5)
  }))
  const sectionMap = Array.from({ length: sections }, (_, i) => ({ section: i + 1, fragmentIds: [`f${2 * i + 1}`, `f${2 * i + 2}`], purpose: `구간 ${i + 1}` }))
  return { fragments, sectionMap }
}
