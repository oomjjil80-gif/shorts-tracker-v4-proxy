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
import { resolveCreativeProfile, type CreativeProfile } from './creativeProfile.js'
import { composeImagePrompt, type VisualStyleProfile } from './visualStyle.js'
import { characterBibleErrors, seniorActErrors, SENIOR } from './seniorLongform.js'

export const LONGFORM_PROFILE_ID = 'wisdom_longform'
// One Longform engine, two image modes: Wisdom Longform holds ONE picture (figure right, cards left); Senior Longform
// tells a story over scene pictures (subtitle cards at the bottom). Research is the wisdom-source step (Wisdom only).
export const LONGFORM_MODES = {
  wisdom_longform: { images: 'single', script: 'wisdom-longform-script/1', research: true, cards: 'left' },
  senior_longform: { images: 'scenes', script: 'senior-longform-script/1', research: false, cards: 'bottom' }
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
export type LongformProfileId = 'wisdom_longform' | 'senior_longform'
export type LongformBrief = { schema: 'generative-brief/1'; profile: LongformProfileId; kind: 'topic' | 'text'; text: string; language: 'ko'; aspectRatio: '16:9'; targetSeconds: number; sample?: true; creative?: CreativeProfile; voice?: { choice: LongformVoiceChoice; key: LongformVoiceKey; profileId: string } }
// one narration sentence and the card shown while it is spoken
export type LongformSentence = { say: string; show: string[]; accent: string; color: AccentColor }
export type LongformScript = {
  schema: 'wisdom-longform-script/1'
  title: string; hook: string
  figure: { name: string; imagePrompt: string }
  thumbnail: { lines: Array<{ text: string; color: AccentColor }> }
  metadata: { description: string; tags: string[]; hashtags: string[]; pinnedComment: string }
  sections: Array<{ id: string; sentences: LongformSentence[] }>
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
  return { schema: 'generative-brief/1', profile, kind, text, language: 'ko', aspectRatio: '16:9', targetSeconds: Math.round(targetSeconds), ...(sample ? { sample: true as const } : {}), creative }
}
export const longformBriefHash = (b: LongformBrief) => createHash('sha256').update(canonicalize(b)).digest('hex')

export const sentencesOf = (s: LongformScript) => s.sections.flatMap((x) => x.sentences)
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
