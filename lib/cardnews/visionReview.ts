// Image visual review: only called after the existing one-use cost approval.
// Never log the image, prompt or provider response.
import { CardnewsError } from './cardnews.js'

export async function reviewCardImage(input: any, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch) {
  const key = env.OPENAI_API_KEY
  if (!key) throw new CardnewsError('PROVIDER_DOWN', 'OPENAI_API_KEY is not configured')
  const image = String(input?.dataUrl || '')
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 8_500_000)
    throw new CardnewsError('BAD_REQUEST', '지원되지 않거나 너무 큰 이미지입니다.')
  const cardId = String(input?.card?.id || '').slice(0, 60)
  if (!cardId) throw new CardnewsError('BAD_REQUEST', 'card.id is required')
  const rules = input?.rules || {}
  const text = JSON.stringify({
    cardId, cover: String(input?.cover?.title || '').slice(0, 200),
    card: { headline: String(input?.card?.headline || '').slice(0, 300), body: String(input?.card?.body || '').slice(0, 500), visualPlan: input?.card?.visualPlan || {} },
    rules: { secrecyEye: rules.secrecyEye === true, forbid: String(rules.forbid || '').slice(0, 700), hide: rules.hide === true, hideRule: String(rules.hideRule || '').slice(0, 700) }
  })
  const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.CARDNEWS_VISION_MODEL || 'gpt-4.1-mini', temperature: 0, max_tokens: 350,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'You are an independent image quality inspector. Return JSON only: {"pass":boolean,"violations":[{"code":string,"reason":string}]}. Check the visual image against card visualPlan and explicit rules. If secrecyEye=true, any visible single eye on the giant is forbidden even on the ending card. If unsure, return pass=false. Never infer secrecyEye when false. Do not approve violations.' },
        { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: image, detail: 'low' } }] }] })
  })
  if (!response.ok) throw new CardnewsError('PROVIDER_DOWN', `Vision review provider HTTP ${response.status}`)
  const raw: any = await response.json()
  let parsed: any
  try { parsed = JSON.parse(raw?.choices?.[0]?.message?.content || '') } catch { throw new CardnewsError('REVIEW_INVALID', '이미지 검수 응답을 해석할 수 없습니다.') }
  if (typeof parsed?.pass !== 'boolean' || !Array.isArray(parsed.violations) || parsed.violations.length > 20 ||
      !parsed.violations.every((v: any) => typeof v?.code === 'string' && typeof v?.reason === 'string'))
    throw new CardnewsError('REVIEW_INVALID', '이미지 검수 형식이 올바르지 않습니다.')
  return { pass: parsed.pass && parsed.violations.length === 0, violations: parsed.violations.map((v: any) => ({ code: v.code.slice(0, 60), reason: v.reason.slice(0, 250), cardId })) }
}
