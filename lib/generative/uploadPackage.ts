// YouTube upload text for Wisdom Shorts and Longform, written from the actual content and validated. Replaces the old
// phone-side defaults (narration prefix as description, title words as tags, fixed #지혜 #인생 #철학, one generic
// pinned comment), which this validation rejects.
export type UploadMetadata = { title: string; description: string; tags: string[]; hashtags: string[]; pinnedComment: string }

const GENERIC_TAGS = new Set(['지혜', '인생', '철학', '명언', '좋은글', '자기계발', '쇼츠', 'shorts', '인생조언', '동기부여'])
const OLD_HASHTAGS = ['#지혜', '#인생', '#철학']
const OLD_PINNED = '오늘 이야기에서 가장 마음에 남은 문장은 무엇인가요? 여러분의 생각도 댓글로 남겨주세요.'
const squash = (t: string) => String(t || '').replace(/\s+/g, '')
const words = (t: string) => new Set(String(t || '').replace(/[^가-힣a-zA-Z0-9\s]/g, ' ').split(/\s+/).map((w) => w.replace(/(은|는|이|가|을|를|의|에|에게|도|만|로|으로|과|와|하는|하지|해야|할)$/, '')).filter((w) => w.length >= 2))
const sentences = (t: string) => String(t || '').split(/(?<=[.!?。？！]|[다요죠까][.!?]?)\s+/).map((s) => s.trim()).filter((s) => s.length >= 6)
// any 24-character run of the text that also appears verbatim in the narration = copied script
function copiesNarration(text: string, narration: string, run = 24): boolean {
  const a = squash(text), b = squash(narration)
  if (a.length < run || b.length < run) return false
  for (let i = 0; i + run <= a.length; i += 4) if (b.includes(a.slice(i, i + run))) return true
  return false
}

export function normalizeUploadMetadata(m: UploadMetadata): UploadMetadata {
  const tags = [...new Set((m.tags || []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean))]
  const hashtags = [...new Set((m.hashtags || []).map((t) => '#' + String(t).replace(/^#+/, '').replace(/\s+/g, '').trim()).filter((t) => t.length > 1))]
  return { title: String(m.title || '').trim(), description: String(m.description || '').trim(), tags, hashtags, pinnedComment: String(m.pinnedComment || '').trim() }
}

export function uploadMetadataErrors(raw: UploadMetadata, ctx: { narration: string; format: 'shorts' | 'longform' }): string[] {
  const m = normalizeUploadMetadata(raw), e: string[] = []
  const tl = [...m.title].length
  if (tl < 8 || tl > 70) e.push('title.length')
  const firstLine = sentences(ctx.narration)[0] || ''
  if (firstLine && squash(m.title) === squash(firstLine)) e.push('title.is_first_line')
  const dl = [...m.description].length, minD = ctx.format === 'longform' ? 150 : 70
  if (dl < minD || dl > 1500) e.push('description.length')
  if (sentences(m.description).length < (ctx.format === 'longform' ? 3 : 2)) e.push('description.sentences')
  if (copiesNarration(m.description, ctx.narration)) e.push('description.copies_script')
  if (/#\S/.test(m.description)) e.push('description.has_hashtags') // hashtags are their own field
  if (m.tags.length < 6 || m.tags.length > 15) e.push('tags.count')
  if (m.tags.some((t) => [...t].length < 2 || [...t].length > 25)) e.push('tags.length')
  const titleWords = words(m.title)
  if (m.tags.filter((t) => titleWords.has(t) || squash(m.title).includes(squash(t))).length > m.tags.length / 2) e.push('tags.title_words')
  if (m.tags.filter((t) => GENERIC_TAGS.has(t.toLowerCase())).length > m.tags.length / 3) e.push('tags.generic')
  if (m.hashtags.length < 3 || m.hashtags.length > 5) e.push('hashtags.count')
  if (OLD_HASHTAGS.every((h) => m.hashtags.includes(h)) && m.hashtags.length === 3) e.push('hashtags.fixed_set')
  if (!m.hashtags.some((h) => !GENERIC_TAGS.has(h.slice(1).toLowerCase()))) e.push('hashtags.not_content_specific')
  const pl = [...m.pinnedComment].length
  if (pl < 25 || pl > 250) e.push('pinnedComment.length')
  if (squash(m.pinnedComment) === squash(OLD_PINNED)) e.push('pinnedComment.generic')
  if (!/\?|？/.test(m.pinnedComment)) e.push('pinnedComment.no_question')
  const content = words(ctx.narration)
  if (![...words(m.pinnedComment)].some((w) => content.has(w) && !GENERIC_TAGS.has(w))) e.push('pinnedComment.not_about_content')
  return e
}

// The package text: description body, then the hashtags on their own line.
export function uploadPackageText(raw: UploadMetadata): UploadMetadata & { descriptionWithHashtags: string } {
  const m = normalizeUploadMetadata(raw)
  return { ...m, descriptionWithHashtags: `${m.description}\n\n${m.hashtags.join(' ')}`.trim() }
}

export const UPLOAD_METADATA_RULES = [
  'title: 8-70 characters, a click title for THIS content (not the first narration line).',
  'description: 2+ sentences for Shorts (3+ for Longform) written for the YouTube description: what the viewer will learn and why it matters. Never paste or lightly edit the narration. No hashtags inside.',
  'tags: 6-15 search tags about the actual subject (people, concepts, situations, audience); most must NOT just repeat title words; at most a third generic (지혜/인생/철학/명언...).',
  'hashtags: 3-5, at least one specific to this content; not just #지혜 #인생 #철학.',
  'pinnedComment: 25-250 characters, a specific question or prompt about THIS video\'s point that invites viewers to answer.'
].join('\n')
export const UPLOAD_METADATA_SCHEMA = { type: 'object', additionalProperties: false, required: ['title', 'description', 'tags', 'hashtags', 'pinnedComment'], properties: { title: { type: 'string' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, hashtags: { type: 'array', items: { type: 'string' } }, pinnedComment: { type: 'string' } } }
