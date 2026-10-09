// Paid-call ledger: every OpenAI / Gemini call made while a job stage runs is counted (model, tokens incl. cached / reasoning,
// images, narration characters) with an estimated USD. One choke point: the worker meters `fetch` once at start
// (installUsageMeter), so every provider / planner call is covered without touching each call site. The run's totals
// go to the stage run's usage JSON (job_stage_runs.usage_json, no schema change) and one log line per call / stage.
// It never changes a request or a response, and never fails a call (metering errors are swallowed).
import { AsyncLocalStorage } from 'node:async_hooks'

export type UsageCall = { api: string; model: string; name?: string; imageSize?: string; inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; images: number; ttsChars: number; estUsd: number | null }
export type UsageSummary = { schema: 'usage/1'; paidCalls: number; byModel: Record<string, { calls: number; inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; images: number; ttsChars: number; estUsd: number | null }>; estUsd: number | null; unpricedModels: string[] }
type Ledger = { calls: UsageCall[]; label: string }

// USD per 1M tokens (text: in / cached in / out; image models: text in / image out). A model without a known price is
// still counted (tokens), its USD stays null. OPENAI_PRICES_JSON (same shape) adds or overrides prices, e.g. the plan model.
type Price = { in: number; cached?: number; out: number; imageOut?: number; ttsPerMinute?: number; perImage?: Record<string, number> }
const DEFAULT_PRICES: Record<string, Price> = {
  'gpt-5-mini': { in: 0.25, cached: 0.025, out: 2 },
  'gpt-image-1-mini': { in: 2, cached: 0.2, out: 8 },
  'gpt-image-1': { in: 5, cached: 1.25, out: 40 },
  'gpt-4o-mini-tts': { in: 0.6, out: 0, ttsPerMinute: 0.015 },
  // Gemini Nano Banana 2 (every Tracker picture): USD per output image by image_size (public list price, Oct 2026) +
  // text / reference-image input tokens
  'gemini-3.1-flash-image': { in: 0.5, out: 0, perImage: { '0.5K': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 } }
}
function prices(): Record<string, Price> {
  try { return { ...DEFAULT_PRICES, ...(process.env.OPENAI_PRICES_JSON ? JSON.parse(process.env.OPENAI_PRICES_JSON) : {}) } } catch { return DEFAULT_PRICES }
}
const TTS_CHARS_PER_SECOND = 6.2 // the measured Korean narration pace (LONGFORM.charsPerSecond)

export function estimateUsd(c: Omit<UsageCall, 'estUsd'>): number | null {
  const p = prices()[c.model] ?? prices()[c.model.replace(/-\d{4}-\d{2}-\d{2}$/, '')]
  if (!p) return null
  if (p.perImage) return Number((c.images * (p.perImage[c.imageSize ?? '1K'] ?? p.perImage['1K'] ?? 0) + (c.inputTokens * p.in) / 1e6).toFixed(5))
  if (c.ttsChars) return Number(((c.ttsChars / TTS_CHARS_PER_SECOND / 60) * (p.ttsPerMinute ?? 0) + (c.inputTokens * p.in) / 1e6).toFixed(5))
  const fresh = Math.max(0, c.inputTokens - c.cachedTokens)
  return Number(((fresh * p.in + c.cachedTokens * (p.cached ?? p.in) + c.outputTokens * p.out) / 1e6).toFixed(5))
}

const store = new AsyncLocalStorage<Ledger>()
export const withUsageLedger = <T>(label: string, fn: () => Promise<T>) => { const l: Ledger = { calls: [], label }; return { ledger: l, run: store.run(l, fn) } }
export function summarize(calls: UsageCall[]): UsageSummary {
  const byModel: UsageSummary['byModel'] = {}, unpriced = new Set<string>()
  let total = 0
  for (const c of calls) {
    const m = (byModel[c.model] ??= { calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, images: 0, ttsChars: 0, estUsd: 0 })
    m.calls++; m.inputTokens += c.inputTokens; m.cachedTokens += c.cachedTokens; m.outputTokens += c.outputTokens; m.reasoningTokens += c.reasoningTokens; m.images += c.images; m.ttsChars += c.ttsChars
    if (c.estUsd === null) { m.estUsd = null; unpriced.add(c.model) } else if (m.estUsd !== null) m.estUsd = Number((m.estUsd + c.estUsd).toFixed(5))
    total += c.estUsd ?? 0
  }
  return { schema: 'usage/1', paidCalls: calls.length, byModel, estUsd: calls.length ? Number(total.toFixed(4)) : 0, unpricedModels: [...unpriced] }
}

const n = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0)
// what one OpenAI request/response cost (no AI, no extra request): Responses / Images usage blocks; speech = characters
export function usageOf(url: string, reqBody: any, json: any): Omit<UsageCall, 'estUsd'> | null {
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    const fmt = Array.isArray(reqBody?.response_format) ? reqBody.response_format.find((x: any) => x?.type === 'image') : null
    if (!fmt) return null
    const u = json?.usage ?? json?.usage_metadata ?? {}
    const hasImage = !!json?.output_image?.data || (json?.steps ?? []).some((st: any) => (st?.content ?? []).some((b: any) => b?.type === 'image' && b?.data))
    return { api: 'image', model: String(reqBody?.model || 'unknown'), imageSize: String(fmt.image_size || '1K'), inputTokens: n(u.total_input_tokens ?? u.input_tokens ?? u.prompt_token_count), cachedTokens: 0, outputTokens: n(u.total_output_tokens ?? u.output_tokens ?? u.candidates_token_count), reasoningTokens: 0, images: hasImage ? 1 : 0, ttsChars: 0 }
  }
  const api = url.includes('/audio/speech') ? 'speech' : url.includes('/images/') ? 'image' : url.includes('/responses') ? 'responses' : url.includes('/chat/completions') ? 'chat' : ''
  if (!api) return null
  const model = String(json?.model || reqBody?.model || 'unknown'), u = json?.usage ?? {}
  if (api === 'speech') return { api, model, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, images: 0, ttsChars: [...String(reqBody?.input ?? '')].length }
  const name = reqBody?.text?.format?.name ?? reqBody?.response_format?.json_schema?.name
  return {
    api, model, ...(name ? { name: String(name) } : {}),
    inputTokens: n(u.input_tokens ?? u.prompt_tokens), cachedTokens: n(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens),
    outputTokens: n(u.output_tokens ?? u.completion_tokens), reasoningTokens: n(u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens),
    images: api === 'image' ? (Array.isArray(json?.data) ? json.data.length : 0) : 0, ttsChars: 0
  }
}

function bodyOf(init: any): any {
  const b = init?.body
  if (typeof b === 'string') { try { return JSON.parse(b) } catch { return null } }
  if (b && typeof (b as any).get === 'function') { const m = (b as FormData).get('model'); return { model: typeof m === 'string' ? m : undefined } }
  return null
}
// Every Tracker picture is drawn by Gemini (geminiImage.ts): an OpenAI image request is refused here, before it is sent
// (fail closed — no code path may draw with OpenAI again, and nothing is paid for it).
export const OPENAI_IMAGE_BLOCKED = 'OPENAI_IMAGE_BLOCKED'
export const isOpenAiImageUrl = (url: string) => /^https:\/\/api\.openai\.com\/v1\/images\//.test(url)
export function meteredFetch(base: typeof fetch, log: (line: string) => void = (l) => console.log(l)): typeof fetch {
  return (async (input: any, init?: any) => {
    const target = String(typeof input === 'string' ? input : input?.url ?? '')
    if (isOpenAiImageUrl(target)) { log(`[cost] refused ${target}: every picture is drawn by Gemini`); throw Object.assign(new Error(`${OPENAI_IMAGE_BLOCKED}: OpenAI image API calls are disabled (Gemini draws every picture)`), { code: OPENAI_IMAGE_BLOCKED, stop: true }) }
    const res = await base(input, init)
    try {
      const url = String(typeof input === 'string' ? input : input?.url ?? '')
      if (!(url.startsWith('https://api.openai.com/') || url.startsWith('https://generativelanguage.googleapis.com/')) || !res.ok) return res
      const req = bodyOf(init), isJson = (res.headers.get('content-type') || '').includes('json')
      const json = isJson ? await res.clone().json().catch(() => null) : null
      const u = usageOf(url, req, json)
      if (!u) return res
      const call: UsageCall = { ...u, estUsd: estimateUsd(u) }
      const l = store.getStore()
      if (l) l.calls.push(call)
      log(`[cost] ${l?.label ?? 'no-job'} ${call.api} model=${call.model}${call.name ? ` name=${call.name}` : ''} in=${call.inputTokens} cached=${call.cachedTokens} out=${call.outputTokens} reasoning=${call.reasoningTokens}${call.images ? ` images=${call.images}` : ''}${call.ttsChars ? ` ttsChars=${call.ttsChars}` : ''} est=${call.estUsd === null ? 'n/a' : '$' + call.estUsd}`)
    } catch { /* metering never breaks a call */ }
    return res
  }) as typeof fetch
}
let installed = false
export function installUsageMeter(log?: (line: string) => void) {
  if (installed) return
  installed = true
  globalThis.fetch = meteredFetch(globalThis.fetch.bind(globalThis), log)
}
