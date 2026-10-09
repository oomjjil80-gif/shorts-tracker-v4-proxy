// Wisdom Longform (profile wisdom_longform): ONE static 16:9 image (figure RIGHT, dark negative space LEFT), the whole
// narration as one voice track, and large bold "key phrase" cards on the left that change with the narration.
// Deliberately separate from Wisdom Shorts (lib/generative/wisdom.ts, Screen DNA): nothing here is shared state.
import { createHash } from 'node:crypto'
import { canonicalize } from '../tracker-core/renderManifest.js'
import { FONT_FAMILY, assTime, headAdvanceEm } from '../media/ass.js'
import { VIDEO_ENCODER_THREADS } from '../media/render.js'
import { thumbnailCopyErrors } from './wisdomThumbnail.js'
import { uploadMetadataErrors, uploadPackageText } from './uploadPackage.js'
import { thinkerFor } from './wisdom.js'
import { type LongformVoiceChoice, type LongformVoiceKey } from './voiceProfile.js'
import { creativeStylesFor, resolveCreativeProfile, type CreativeProfile } from './creativeProfile.js'
import { composeImagePrompt, type VisualStyleProfile } from './visualStyle.js'
import { characterBibleErrors, seniorActErrors, SENIOR } from './seniorLongform.js'
import { yasaScriptErrors } from './yasaLongform.js'
import { styleApprovalOn } from './styleApproval.js'
import { validateYasaStoryDna } from '../story/yasaStoryDna.js'

export const LONGFORM_PROFILE_ID = 'wisdom_longform'
// One Longform engine, two image modes: Wisdom Longform holds ONE picture (figure right, cards left); Senior Longform
// tells a story over scene pictures (subtitle cards at the bottom). Research is the wisdom-source step (Wisdom only).
export const LONGFORM_MODES = {
  wisdom_longform: { images: 'single', script: 'wisdom-longform-script/1', research: true, cards: 'left' },
  senior_longform: { images: 'scenes', script: 'senior-longform-script/1', research: false, cards: 'bottom' },
  // 숨은야담: the scenes mode with the YASA STORY DNA as the first PLAN step (lib/generative/yasaLongform.ts)
  yasa_longform: { images: 'scenes', script: 'yasa-longform-script/1', research: false, cards: 'bottom' }
} as const
export const isLongformProfile = (p: unknown): p is keyof typeof LONGFORM_MODES => typeof p === 'string' && Object.prototype.hasOwnProperty.call(LONGFORM_MODES, p)
export const longformMode = (p: unknown) => (isLongformProfile(p) ? LONGFORM_MODES[p] : LONGFORM_MODES.wisdom_longform)
export const LONGFORM = {
  canvas: { w: 1920, h: 1080 }, thumb: { w: 1280, h: 720 }, fps: 30,
  // targetSeconds only sizes the script the planner writes; it is never a pass/fail condition on the result.
  targetSeconds: { default: 1500 },
  // long scripts are written section by section (each section a checkpoint), ~5-6 minutes of narration each
  plan: { sectionChars: 2200, minSections: 3 },
  // the text column: left 60% of the frame (figure lives in the right 40%); every card is 2-3 lines with a coloured accent
  text: { x: 100, maxWidth: 1050, basePx: 150, minPx: 84, minLines: 2, maxLines: 3, maxLineChars: 14 },
  ttsChunkChars: 1200,
  charsPerSecond: 6.2 // measured Korean narration pace of the OpenAI voice, used only to size the script
} as const
export const ACCENTS = { red: '#FF3B30', purple: '#B36BFF', green: '#4CFF7A', yellow: '#FFD60A', white: '#FFFFFF' } as const
// card accents must be a real colour (white is the card's base colour, not an emphasis)
export const CARD_ACCENTS = ['red', 'purple', 'green', 'yellow'] as const
export type AccentColor = keyof typeof ACCENTS

// Longform briefs: Wisdom Longform (one image) and Senior Longform (story scenes) share the engine. `creative` holds the
// requested + resolved voice/style; `voice` only exists on briefs made before Creative Settings (kept as they were).
export type LongformProfileId = 'wisdom_longform' | 'senior_longform' | 'yasa_longform'
export type LongformRemasterChanges = {
  visualStyleProfile?: string
  voiceProfile?: string
  voiceTone?: string
  voiceSpeed?: number
  // Profile-specific content repair. Today only 숨은야담 owns a cold open; the generic remaster envelope itself stays shared.
  refreshColdOpen?: boolean
}
export type LongformRemaster = {
  schema: 'longform-remaster/1'
  sourceJobId: string
  parentJobId: string
  sourceScriptRef: string
  changes: LongformRemasterChanges
}
export type LongformBrief = { schema: 'generative-brief/1'; profile: LongformProfileId; kind: 'topic' | 'text'; text: string; language: 'ko'; aspectRatio: '16:9'; targetSeconds: number; sample?: true; creative?: CreativeProfile; yasaStoryDNA?: any; deriveShorts?: false; remaster?: LongformRemaster; voice?: { choice: LongformVoiceChoice; key: LongformVoiceKey; profileId: string } }
// one narration sentence and the card shown while it is spoken
export type LongformSentence = { say: string; show: string[]; accent: string; color: AccentColor }
export type LongformScript = {
  schema: 'wisdom-longform-script/1'
  title: string; hook: string
  figure: { name: string; imagePrompt: string }
  thumbnail: { lines: Array<{ text: string; color: AccentColor }> }
  metadata: { description: string; tags: string[]; hashtags: string[]; pinnedComment: string }
  sections: Array<{ id: string; sentences: LongformSentence[] }>
  // 숨은야담: a cold open told before the first section (its sentences come first in the narration and the cards)
  coldOpen?: { sentences: LongformSentence[] }
}

export function normalizeLongformBrief(input: any, profile: LongformProfileId = 'wisdom_longform'): LongformBrief {
  const kind = String(input?.kind || '')
  if (kind !== 'topic' && kind !== 'text') throw new Error('input.kind must be topic or text')
  const text = String(input?.text || '').replace(/\s+/g, ' ').trim()
  if (text.length < 4 || text.length > 30000) throw new Error('input.text must be 4..30000 characters')
  const sample = input?.sample === true
  // any running time the user picks (no min/max); only a non-number, zero or negative value is refused
  const targetSeconds = Number(input?.targetSeconds ?? LONGFORM.targetSeconds.default)
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) throw new Error('targetSeconds must be a positive number of seconds')
  const creative = resolveCreativeProfile(profile, input, text)
  // 숨은야담: a STORY DNA the browser already made may come along (checked here); otherwise the PLAN makes it
  let yasaStoryDNA: any
  if (profile === 'yasa_longform' && input?.yasaStoryDNA !== undefined) {
    const v = validateYasaStoryDna(input.yasaStoryDNA, 'longform', { layers: true })
    if (!v.ok) throw new Error(`yasaStoryDNA is invalid: ${v.errors.join(', ')}`)
    yasaStoryDNA = input.yasaStoryDNA
  }
  // Wisdom Longform recommends derived Shorts by default; only an explicit "off" is stored (other briefs stay byte-identical)
  const noDerive = profile === 'wisdom_longform' && input?.deriveShorts === false
  return { schema: 'generative-brief/1', profile, kind, text, language: 'ko', aspectRatio: '16:9', targetSeconds: Math.round(targetSeconds), ...(sample ? { sample: true as const } : {}), creative, ...(yasaStoryDNA ? { yasaStoryDNA } : {}), ...(noDerive ? { deriveShorts: false as const } : {}), ...(input?.thumbnailFirst === true && styleApprovalOn(profile) ? { thumbnailFirst: true as const } : {}) }
}
// Generic Longform REMASTER envelope. A remaster is a new child job on the SAME profile: it reuses the stored
// script and lets cache identity decide the minimum paid work. Same voice/text => TTS HIT; same picture prompt => image
// HIT; a renderer/caption-only change can therefore reuse both. The source job is immutable.
// New change kinds belong in this one contract instead of adding another job_remaster_<profile> endpoint.
export function longformRemasterBrief(source: LongformBrief | null | undefined, o: { sourceJobId: string; sourceScriptRef: string; changes?: unknown }): LongformBrief {
  if (!source || source.schema !== 'generative-brief/1' || !LONGFORM_MODES[source.profile]) throw new Error('the source job has no Longform brief')
  const raw = o.changes && typeof o.changes === 'object' && !Array.isArray(o.changes) ? o.changes as Record<string, unknown> : {}
  const allowed = new Set(['visualStyleProfile', 'voiceProfile', 'voiceTone', 'voiceSpeed', 'refreshColdOpen'])
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k))
  if (unknown.length) throw new Error(`unknown remaster changes: ${unknown.join(', ')}`)
  const changes: LongformRemasterChanges = {
    ...(raw.visualStyleProfile !== undefined ? { visualStyleProfile: String(raw.visualStyleProfile) } : {}),
    ...(raw.voiceProfile !== undefined ? { voiceProfile: String(raw.voiceProfile) } : {}),
    ...(raw.voiceTone !== undefined ? { voiceTone: String(raw.voiceTone) } : {}),
    ...(raw.voiceSpeed !== undefined ? { voiceSpeed: Number(raw.voiceSpeed) } : {}),
    ...(raw.refreshColdOpen !== undefined ? { refreshColdOpen: raw.refreshColdOpen === true } : {})
  }
  if (changes.refreshColdOpen && source.profile !== 'yasa_longform') throw new Error('refreshColdOpen is only available for 숨은야담 Longform')
  if (changes.visualStyleProfile && changes.visualStyleProfile !== 'auto') {
    const styles = creativeStylesFor(source.profile)
    if (!(styles as readonly string[]).includes(changes.visualStyleProfile)) throw new Error(`visualStyleProfile must be auto or one of ${styles.join(', ')}`)
  }
  const creativeChange = changes.visualStyleProfile !== undefined || changes.voiceProfile !== undefined || changes.voiceTone !== undefined || changes.voiceSpeed !== undefined
  let creative = source.creative
  if (creativeChange) {
    if (!source.creative?.requested || !source.creative?.resolved) throw new Error('this source predates Creative Settings; rerender is supported, creative changes are not')
    const requested: any = { ...source.creative.requested }
    if (changes.visualStyleProfile !== undefined) requested.visualStyleProfile = changes.visualStyleProfile
    if (changes.voiceProfile !== undefined) requested.voiceProfile = changes.voiceProfile
    if (changes.voiceTone !== undefined) requested.voiceTone = changes.voiceTone
    if (changes.voiceSpeed !== undefined) requested.voiceSpeed = changes.voiceSpeed
    // a content with ONE 그림체 (야담): an old style choice of the source is not offered any more -> AUTO (= that one style)
    const offered = creativeStylesFor(source.profile)
    if (requested.visualStyleProfile && requested.visualStyleProfile !== 'auto' && !(offered as readonly string[]).includes(requested.visualStyleProfile)) requested.visualStyleProfile = 'auto'
    creative = resolveCreativeProfile(source.profile, requested, source.text)
  }
  // a 야담 child always names its one 그림체 (its pictures are drawn by yadamStyle.ts whatever the brief says)
  const single = creativeStylesFor(source.profile)
  if (creative?.resolved && single.length === 1 && creative.resolved.visualStyleProfile !== single[0]) creative = { ...creative, requested: { ...creative.requested, visualStyleProfile: 'auto' }, resolved: { ...creative.resolved, visualStyleProfile: single[0] } }
  return {
    ...source,
    ...(creative ? { creative } : {}),
    remaster: { schema: 'longform-remaster/1', sourceJobId: o.sourceJobId, parentJobId: o.sourceJobId, sourceScriptRef: o.sourceScriptRef, changes }
  }
}

export const longformBriefHash = (b: LongformBrief) => createHash('sha256').update(canonicalize(b)).digest('hex')

export const sentencesOf = (s: LongformScript) => [...(s.coldOpen?.sentences ?? []), ...s.sections.flatMap((x) => x.sentences)]
export const narrationOf = (s: LongformScript) => sentencesOf(s).map((x) => x.say.trim()).join(' ')
export const estimatedSeconds = (s: LongformScript) => [...narrationOf(s)].length / LONGFORM.charsPerSecond
// The running time only sizes the script: how many sections the planner writes and how long each one is.
// The finished video may come out shorter or longer than the target; that is never a failure.
export function sectionPlan(targetSeconds: number): { sections: number; charsPerSection: number; totalChars: number } {
  const totalChars = Math.max(1, Math.round(targetSeconds * LONGFORM.charsPerSecond))
  const sections = Math.max(LONGFORM.plan.minSections, Math.ceil(totalChars / LONGFORM.plan.sectionChars))
  return { sections, charsPerSection: Math.round(totalChars / sections), totalChars }
}
// The one representative person. A figure the topic names (the Buddha, or a named thinker) is kept as that person;
// it is never swapped for a generic philosopher or a Western sage.
const BUDDHA = /부처|붓다|석가모니|석가|세존|buddha|gautama|shakyamuni/i
export const BUDDHA_FIGURE = 'Gautama Buddha (Shakyamuni) as in classical Buddhist art: serene compassionate face with half-closed eyes, short tight curls with the ushnisha, elongated earlobes, simple saffron monastic robe draped over one shoulder, seated in calm meditation'
export function longformFigure(topic: string, fallback: string): string {
  if (BUDDHA.test(String(topic || ''))) return BUDDHA_FIGURE
  const t = thinkerFor(topic)
  return t ? `${t.name}, ${t.likeness}` : fallback
}
// The card contract for one sentence (also re-checked at RENDER on what is actually drawn).
export function cardErrors(x: any): string[] {
  const e: string[] = []
  const show = Array.isArray(x?.show) ? x.show.map((l: any) => String(l || '').trim()).filter(Boolean) : []
  if (show.length < LONGFORM.text.minLines || show.length > LONGFORM.text.maxLines) e.push('show.lines')
  if (show.some((l: string) => [...l].length > LONGFORM.text.maxLineChars)) e.push('show.too_wide')
  const accent = String(x?.accent || '').trim()
  if (!accent) e.push('accent.missing')
  else if (!show.some((l: string) => l.includes(accent))) e.push('accent.not_in_show')
  if (!(CARD_ACCENTS as readonly string[]).includes(x?.color)) e.push('color.not_accent')
  return e
}

export function validateLongformScript(s: any, brief: LongformBrief): string[] {
  const e: string[] = [], mode = longformMode(brief.profile)
  if (s?.schema !== mode.script) e.push('schema')
  for (const k of ['title', 'hook']) if (!String(s?.[k] || '').trim()) e.push(k)
  if (!String(s?.figure?.imagePrompt || '').trim()) e.push('figure.imagePrompt')
  const tl = s?.thumbnail?.lines
  // the thumbnail is its own click copy (2-3 meaning units, coloured by meaning, never the title)
  e.push(...thumbnailCopyErrors(Array.isArray(tl) ? tl : [], String(s?.title || '')).map((x) => `thumbnail.${x}`))
  const sections = Array.isArray(s?.sections) ? s.sections : []
  if (!sections.length) e.push('sections')
  let n = 0
  for (const [i, sec] of sections.entries()) {
    const sents = Array.isArray(sec?.sentences) ? sec.sentences : []
    if (!sents.length) e.push(`sections[${i}].sentences`)
    for (const [j, x] of sents.entries()) {
      n++
      const at = `sections[${i}].sentences[${j}]`
      if (!String(x?.say || '').trim()) e.push(`${at}.say`)
      if ([...String(x?.say || '')].length > LONGFORM.ttsChunkChars) e.push(`${at}.say.too_long`)
      e.push(...cardErrors(x).map((c) => `${at}.${c}`))
    }
  }
  for (const [j, x] of (Array.isArray(s?.coldOpen?.sentences) ? s.coldOpen.sentences : []).entries()) {
    n++
    if (!String(x?.say || '').trim()) e.push(`coldOpen.sentences[${j}].say`)
    e.push(...cardErrors(x).map((c) => `coldOpen.sentences[${j}].${c}`))
  }
  if (!n) e.push('sentences')
  // upload text written for THIS video (never script copy / title words / fixed hashtags / generic comment)
  if (n && s?.metadata) e.push(...uploadMetadataErrors({ title: String(s.title || ''), ...s.metadata }, { narration: narrationOf(s as LongformScript), format: 'longform' }).map((x) => `upload.${x}`))
  else if (!s?.metadata) e.push('upload.missing')
  if (!isLongformProfile(brief.profile)) e.push('profile')
  if (mode.images === 'scenes') {
    e.push(...characterBibleErrors(s?.characters))
    const ids = new Set<string>((Array.isArray(s?.characters) ? s.characters : []).map((c: any) => String(c?.id)))
    for (const [i, sec] of sections.entries()) e.push(...seniorActErrors(sec, ids).map((x) => `sections[${i}].${x}`))
  }
  if (brief.profile === 'yasa_longform') e.push(...yasaScriptErrors(s, { speed: Number(brief.creative?.resolved?.voiceSpeed) || 1, charsPerSecond: LONGFORM.charsPerSecond }))
  return e
}

// ---------------- image: ONE representative image, composition forced at prompt time ----------------
// A picture style the user picked (other than the native painterly one) replaces only the style line; the 16:9
// figure-right / dark-left composition stays mandatory.
export function longformImagePrompt(s: LongformScript, style?: VisualStyleProfile | null): string {
  if (style) return composeImagePrompt({
    content: `Wide 16:9 still for a Korean wisdom video. Subject: ${s.figure.imagePrompt}`, style,
    composition: 'MANDATORY: the person in the RIGHT third of the frame (right 35-40%), turned slightly toward the left, never in the center; the LEFT 60% is broad, very dark, simple negative space with no objects, kept clean for large text added later.'
  })
  return [
    `Wide 16:9 cinematic still for a Korean wisdom video. Subject: ${s.figure.imagePrompt}.`,
    'COMPOSITION (mandatory): the person stands or sits in the RIGHT third of the frame (right 35-40%), turned slightly toward the left;',
    'the person NEVER occupies the center. The LEFT 60% of the frame is broad, very dark, simple negative space (deep shadow, plain dark wall or night sky, softly out of focus) with no objects and no detail, kept clean for large text added later.',
    'Painterly realistic portrait, dramatic low-key side lighting from the right, muted deep colors.',
    'Absolutely no text, letters, numbers, captions, calligraphy, signatures, logos or watermark anywhere in the image.'
  ].join(' ')
}

// ---------------- narration: one TTS call per sentence, card timing from the measured audio ----------------
// Each sentence is synthesized on its own (order and text exactly as planned), so the start of every card is the real
// start of that sentence in the narration track (cumulative measured audio), not a character-ratio estimate.
export function ttsChunks(s: LongformScript): Array<{ text: string; sentences: number[] }> {
  return sentencesOf(s).map((x, k) => ({ text: x.say.trim(), sentences: [k] }))
}
export function cardTimeline(s: LongformScript, chunks: Array<{ sentences: number[] }>, chunkSeconds: number[]): Array<{ start: number; end: number; k: number }> {
  const n = sentencesOf(s).length
  if (chunks.length !== n || chunks.some((c, i) => c.sentences.length !== 1 || c.sentences[0] !== i)) throw new Error('narration chunks must be one per sentence, in order, without gaps or repeats')
  let clock = 0
  return chunks.map((c, i) => { const start = clock; clock += chunkSeconds[i]; return { start: Number(start.toFixed(3)), end: Number(clock.toFixed(3)), k: c.sentences[0] } })
}

// ---------------- ASS: large left text cards (video) and the thumbnail ----------------
const assHex = (hex: string) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex)!; return `&H00${m[1].slice(4, 6)}${m[1].slice(2, 4)}${m[1].slice(0, 2)}&`.toUpperCase() }
const esc = (t: string) => t.replace(/[{}]/g, '').replace(/\\/g, '')
// One line with the accent phrase (if it is on this line) coloured; everything else white.
function colourLine(line: string, accent: string, color: AccentColor): string {
  const white = assHex(ACCENTS.white), c = assHex(ACCENTS[color])
  const i = accent ? line.indexOf(accent) : -1
  if (i < 0 || color === 'white') return esc(line)
  return `${esc(line.slice(0, i))}{\\c${c}}${esc(accent)}{\\c${white}}${esc(line.slice(i + accent.length))}`
}
// Largest size (<= basePx) at which the widest line fits the text column (Noto Sans KR Bold: \fs = 1.448em).
export function cardFontSize(lines: string[], maxWidth: number = LONGFORM.text.maxWidth, basePx: number = LONGFORM.text.basePx, minPx: number = LONGFORM.text.minPx): number {
  const widest = Math.max(1, ...lines.map(headAdvanceEm))
  return Math.max(minPx, Math.min(basePx, Math.floor((maxWidth / widest) * 1.448)))
}
const header = (w: number, h: number, outline: number, shadow: number) => [
  '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
  '[V4+ Styles]',
  'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
  `Style: Card,${FONT_FAMILY},${LONGFORM.text.basePx},&H00FFFFFF,&H000000FF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,${outline},${shadow},4,0,0,0,1`,
  '', '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
]
// cards 'left' (Wisdom Longform): the block in the dark left column; 'bottom' (Senior Longform): centred subtitle lines
// at the bottom over the full-frame scene picture. Same card contract and the same hard cuts either way.
export function longformCardsAss(s: LongformScript, timeline: Array<{ start: number; end: number; k: number }>, placement: 'left' | 'bottom' = 'left'): { ass: string; cards: Array<{ start: number; end: number; lines: string[]; fs: number }> } {
  const sents = sentencesOf(s), lines = header(LONGFORM.canvas.w, LONGFORM.canvas.h, 7, 4), cards: Array<{ start: number; end: number; lines: string[]; fs: number }> = []
  const B = SENIOR.text
  for (const t of timeline) {
    const x = sents[t.k], show = x.show.map((l) => l.trim()).filter(Boolean)
    if (!show.length || !(t.end > t.start)) continue
    const fs = placement === 'bottom' ? cardFontSize(show, B.maxWidth, B.basePx, B.minPx) : cardFontSize(show)
    // \an4 = left edge, vertically centred on the frame: the block sits in the dark left column (hard cut, no fade);
    // \an2 = bottom centre for the story subtitles
    const pos = placement === 'bottom' ? `\\an2\\pos(${B.x},${LONGFORM.canvas.h - B.bottom})` : `\\an4\\pos(${LONGFORM.text.x},${LONGFORM.canvas.h / 2})`
    lines.push(`Dialogue: 1,${assTime(t.start)},${assTime(t.end)},Card,,0,0,0,,{${pos}\\fs${fs}\\fsp2}${show.map((l) => colourLine(l, x.accent, x.color)).join('\\N')}`)
    cards.push({ start: t.start, end: t.end, lines: show, fs })
  }
  return { ass: [...lines, ''].join('\n'), cards }
}
// ---------------- 숨은야담: the bottom caption IS the narration (never the planner's short "show" lines) ----------------
// A sentence's spoken text, whitespace normalised, cut at spaces (never inside a word) into 1~2 line chunks that fit the
// subtitle column; a line prefers to end after punctuation. The chunks joined with one space ARE the sentence, letter for
// letter. Each chunk is shown inside the sentence's own measured audio span, in proportion to its length (+ a pause
// after punctuation): the first starts at the sentence start, the last ends at its end, no gap and no overlap.
export const YADAM_CAPTION = { lineEm: 22, lines: 2 } as const
const capNorm = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim()
const endsPause = (w: string) => /[,.?!…。、"”'’)\]]$/.test(w)
export function yasaCaptionChunks(say: unknown, o: { lineEm?: number; lines?: number } = {}): Array<{ text: string; lines: string[] }> {
  const maxEm = o.lineEm ?? YADAM_CAPTION.lineEm, maxLines = o.lines ?? YADAM_CAPTION.lines
  const words = capNorm(say).split(' ').filter(Boolean)
  const lines: string[] = []
  let cur: string[] = []
  for (const w of words) {
    const next = [...cur, w].join(' ')
    if (cur.length && headAdvanceEm(next) > maxEm) { lines.push(cur.join(' ')); cur = [w] } else cur.push(w)
    // a comfortable break after punctuation once the line is more than half full
    if (endsPause(w) && headAdvanceEm(cur.join(' ')) >= maxEm * 0.55) { lines.push(cur.join(' ')); cur = [] }
  }
  if (cur.length) lines.push(cur.join(' '))
  const chunks: Array<{ text: string; lines: string[] }> = []
  for (let i = 0; i < lines.length; i += maxLines) { const ls = lines.slice(i, i + maxLines); chunks.push({ text: ls.join(' '), lines: ls }) }
  return chunks
}
// the chunks of one sentence over [start, end] (centisecond steps, as ASS shows them)
export function yasaCaptionTimes(chunks: Array<{ text: string }>, start: number, end: number): Array<{ start: number; end: number }> {
  const w = chunks.map((c) => Math.max(1, headAdvanceEm(c.text)) + (endsPause(c.text) ? 1.5 : 0)), total = w.reduce((a, b) => a + b, 0)
  const cs = (x: number) => Math.round(x * 100) / 100
  const edges = [start]
  let acc = 0
  for (let i = 0; i < chunks.length - 1; i++) { acc += w[i]; edges.push(Math.min(end, Math.max(edges[i] + 0.01, cs(start + ((end - start) * acc) / total)))) }
  edges.push(end)
  return chunks.map((_, i) => ({ start: edges[i], end: edges[i + 1] }))
}
export function yasaCaptionsAss(s: LongformScript, timeline: Array<{ start: number; end: number; k: number }>): { ass: string; cards: Array<{ start: number; end: number; lines: string[]; fs: number; k: number }>; sentences: number } {
  const sents = sentencesOf(s), out = header(LONGFORM.canvas.w, LONGFORM.canvas.h, 7, 4), cards: Array<{ start: number; end: number; lines: string[]; fs: number; k: number }> = []
  const B = SENIOR.text, done = new Set<number>()
  for (const t of timeline) {
    if (!(t.end > t.start)) continue
    const chunks = yasaCaptionChunks(sents[t.k]?.say)
    if (!chunks.length) continue
    const times = yasaCaptionTimes(chunks, t.start, t.end)
    for (const [i, c] of chunks.entries()) {
      const fs = cardFontSize(c.lines, B.maxWidth, B.basePx, B.minPx)
      out.push(`Dialogue: 1,${assTime(times[i].start)},${assTime(times[i].end)},Card,,0,0,0,,{\\an2\\pos(${B.x},${LONGFORM.canvas.h - B.bottom})\\fs${fs}\\fsp2}${c.lines.map(esc).join('\\N')}`)
      cards.push({ ...times[i], lines: c.lines, fs, k: t.k })
    }
    done.add(t.k)
  }
  return { ass: [...out, ''].join('\n'), cards, sentences: done.size }
}
// ---------------- ffmpeg: static picture + left darkening + text (no zoom, pan, motion or transition) ----------------
// The left column is darkened with a fixed horizontal gradient so the text always reads, whatever the image.
const leftShade = (w: number, h: number) => `[sh];color=c=black:s=${w}x${h},format=rgba,geq=r=0:g=0:b=0:a='clip(200*(1-X/(${w}*0.62)),0,200)'[g];[sh][g]overlay=0:0`
export const longformPictureFilter = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},format=rgba${leftShade(w, h)},format=yuv420p`
// The picture is composed ONCE into a still (scale/crop + left shade) and then held for the whole narration by -loop:
// per-frame work is only libass + the encoder, so a 25-minute video renders in minutes.
export function longformBackgroundArgv(o: { image: string; out: string }): string[] {
  const { w, h } = LONGFORM.canvas
  return ['-y', '-i', o.image, '-filter_complex', `[0:v]${longformPictureFilter(w, h)}[v]`, '-map', '[v]', '-frames:v', '1', o.out]
}
export function longformVideoArgv(o: { background: string; audio: string; ass: string; fontsDir: string; out: string; seconds: number }): string[] {
  const e = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  return ['-y', '-loop', '1', '-framerate', String(LONGFORM.fps), '-i', o.background, '-i', o.audio,
    '-vf', `ass=filename='${e(o.ass)}':fontsdir='${e(o.fontsDir)}',format=yuv420p`,
    '-map', '0:v', '-map', '1:a', '-t', o.seconds.toFixed(3),
    // bounded like the Shorts renderer: libx264 auto-threads scale with the HOST cpu count (60 on Railway), ~4x the
    // memory of a 1080p encode, and the worker's ffmpeg was killed at frame 0 (reported as exit 1)
    '-c:v', 'libx264', '-threads:v', String(VIDEO_ENCODER_THREADS), '-tune', 'stillimage', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(LONGFORM.fps), '-g', String(LONGFORM.fps * 4),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', o.out]
}
// ---------------- upload package text ----------------
export function longformPackageMetadata(s: LongformScript) {
  // null when the text does not pass the upload rules (e.g. the no-model text path): nothing made-up is shown
  const m = { title: s.title, ...s.metadata }
  if (uploadMetadataErrors(m, { narration: narrationOf(s), format: 'longform' }).length) return null
  const t = uploadPackageText(m)
  return { title: t.title, description: t.descriptionWithHashtags, tags: t.tags, hashtags: t.hashtags, pinnedComment: t.pinnedComment }
}
