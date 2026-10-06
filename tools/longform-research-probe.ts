// One-off check of the Longform RESEARCH -> OUTLINE path on the real providers + job storage (R2 when configured).
// Stops after the outline: no sections, no TTS, no image, no render. Paid only on a cache MISS; run it again and both
// steps come from storage (0 requests). Usage (with the production env, e.g. `railway run`):
//   npm run longform:research-probe -- --minutes 60 --confirm-paid "<topic>"
import { sha256, createVercelJobBlobStore } from '../lib/jobs/blobs.js'
import { storageBackend } from '../lib/objectStorage.js'
import { normalizeLongformBrief, sectionPlan } from '../lib/generative/longform.js'
import { openAiLongformResearcher, RESEARCH_VERSION } from '../lib/generative/longformResearch.js'
import { openAiLongformPlanner, type LongformOutline } from '../lib/generative/longformPlanner.js'
import { longformResearchFor } from '../worker/stages/longform.js'

async function main() {
  const args = process.argv.slice(2)
  const minutes = Number(args[args.indexOf('--minutes') + 1] || 60)
  const topic = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--minutes').join(' ').trim()
  if (!topic) throw new Error('topic missing')
  if (!args.includes('--confirm-paid')) throw new Error('add --confirm-paid (a cache MISS makes one paid research request + one outline request)')
  const apiKey = String(process.env.OPENAI_API_KEY || '')
  if (!apiKey) throw new Error('OPENAI_API_KEY missing')
  const brief = normalizeLongformBrief({ kind: 'topic', text: topic, targetSeconds: Math.round(minutes * 60) }) as any
  const size = sectionPlan(brief.targetSeconds), blobs = createVercelJobBlobStore()
  console.log(`[probe] storage=${storageBackend()} minutes=${minutes} sections=${size.sections}`)
  const { research, ref, log } = await longformResearchFor({ blobs, topic: brief.text, sections: size.sections, apiKey, researcher: openAiLongformResearcher(), log: (l) => console.log(l) })
  // the outline is stored too, so re-running the probe costs nothing
  const oRef = `longform-research-probe/${sha256(`${ref}|${RESEARCH_VERSION}|outline`)}.json`
  let outline = await blobs.getJson<LongformOutline>(oRef).catch(() => null), outlineRequests = 0
  if (!outline) { outlineRequests = 1; outline = await openAiLongformPlanner().outline(brief, size.sections, apiKey, undefined, research); await blobs.putJson(oRef, outline, { overwrite: true }) }
  const byId = new Map(research.fragments.map((f) => [f.id, f]))
  const types = research.fragments.reduce((m: Record<string, number>, f) => ({ ...m, [f.type]: (m[f.type] || 0) + 1 }), {})
  const ids = research.sectionMap.flatMap((m) => m.fragmentIds)
  console.log(JSON.stringify({
    research: { ...log, ref, fragments: research.fragments.length, types, directQuotes: research.fragments.filter((f) => f.usableAsDirectBuddhaQuote).length, sourced: research.fragments.filter((f) => f.sourceUrl).length, sectionReuse: ids.length - new Set(ids).size },
    outline: { ref: oRef, cache: outlineRequests ? 'MISS' : 'HIT', requests: outlineRequests, title: outline.title, sections: outline.sections.length }
  }, null, 2))
  outline.sections.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s.heading}  <- ${(research.sectionMap[i]?.fragmentIds ?? []).map((id) => `${id}:${byId.get(id)?.type}`).join(', ')}`))
  for (const f of research.fragments) console.log(`  [${f.id}] ${f.type} ${f.confidence}${f.usableAsDirectBuddhaQuote ? ' QUOTE' : ''} v${f.storyValue} | ${f.claim} | ${f.sourceTitle} ${f.sourceUrl}`)
}
main().catch((e) => { console.error(`[probe] FAIL ${e?.code ?? ''} ${String(e?.message || e).slice(0, 300)}`); process.exit(1) })
