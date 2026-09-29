// Optional model-assisted planning (headline / short captions / better beat choice) on top of the deterministic plan.
// One model, one call. Any failure, timeout or invalid answer => the caller falls back to the deterministic plan and
// records why. The model never sees or produces anything that is not validated by validateVariant().
import type { SourceAnalysis } from './analyze.js'
import { validateVariant, type VariantSpec } from './plan.js'

export const AI_PLANNER_PROMPT_VERSION = 'source-shorts-plan/1'

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['variants'],
  properties: { variants: { type: 'array', minItems: 1, maxItems: 3, items: {
    type: 'object', additionalProperties: false, required: ['label', 'rationale', 'beats', 'headline', 'events'],
    properties: {
      label: { type: 'string' }, rationale: { type: 'string' }, headline: { type: 'string' },
      beats: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['trimStart', 'trimEnd'], properties: { trimStart: { type: 'number' }, trimEnd: { type: 'number' } } } },
      events: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['start', 'end', 'text'], properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } } } }
    } } } }
}

export type AiPlannerDeps = { apiKey: string; model: string; fetchImpl?: typeof fetch; contactSheetJpeg?: Buffer | null; timeoutMs?: number }

export async function aiPlanVariants(a: SourceAnalysis, baseline: VariantSpec[], deps: AiPlannerDeps): Promise<{ variants: VariantSpec[]; model: string; usage: unknown }> {
  const f = deps.fetchImpl ?? fetch
  const summary = { duration: a.media.duration, scenes: a.scenes, highlights: a.highlights, usable: a.usable, silent: a.ranges.silent, hasAudio: a.media.hasAudio, baseline: baseline.map((v) => ({ id: v.id, beats: v.beats.map((b) => [b.trimStart, b.trimEnd]) })) }
  const content: any[] = [{ type: 'input_text', text: [
    'You edit vertical YouTube Shorts from ONE source video. The source video carries the story; text is minimal.',
    'Return 1-3 genuinely different edits (different hook / order / length). All times are SOURCE seconds. Beats must be inside usable ranges, >=0.8s, total <=58s.',
    'headline: <=24 chars, only if it adds curiosity (else empty string). events: short Korean captions (<=20 chars) in SOURCE time, only where they help (may be empty).',
    'Do not invent facts you cannot see. Analysis JSON:', JSON.stringify(summary)
  ].join('\n') }]
  if (deps.contactSheetJpeg) content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${deps.contactSheetJpeg.toString('base64')}` })
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 60_000)
  try {
    const res = await f('https://api.openai.com/v1/responses', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.apiKey}` },
      body: JSON.stringify({ model: deps.model, input: [{ role: 'user', content }], text: { format: { type: 'json_schema', name: 'shorts_plan', strict: true, schema: SCHEMA } } })
    })
    const data: any = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`provider ${res.status}: ${data?.error?.message || 'error'}`)
    const text = data?.output_text ?? data?.output?.flatMap((o: any) => o?.content || []).find((c: any) => typeof c?.text === 'string')?.text
    if (typeof text !== 'string') throw new Error('provider returned no text')
    let parsed: any
    try { parsed = JSON.parse(text) } catch { throw new Error('provider returned invalid JSON') }
    const out: VariantSpec[] = (parsed.variants || []).map((v: any, i: number) => ({
      id: `v${i + 1}`, label: String(v.label || `안 ${i + 1}`).slice(0, 30), rationale: String(v.rationale || '').slice(0, 200),
      beats: (v.beats || []).map((b: any, j: number) => ({ label: `beat ${j + 1}`, trimStart: Number(b.trimStart), trimEnd: Number(b.trimEnd) })),
      ...(v.headline ? { headline: String(v.headline) } : {}), events: (v.events || []).map((e: any) => ({ start: Number(e.start), end: Number(e.end), text: String(e.text) }))
    }))
    const valid = out.filter((v) => validateVariant(v, a).length === 0)
    if (!valid.length) throw new Error(`no valid variant in model output (${out.map((v) => validateVariant(v, a).join('; ')).join(' | ') || 'empty'})`)
    return { variants: valid, model: data?.model || deps.model, usage: data?.usage ?? null }
  } finally { clearTimeout(timer) }
}
