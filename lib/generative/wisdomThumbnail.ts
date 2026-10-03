// Wisdom click thumbnail (16:9, Shorts and Longform): the figure on the RIGHT, 2-3 short re-written punch lines on the
// LEFT in very heavy type with a strong black outline/shadow, and a colour per meaning unit. The picture is NOT covered
// by a box: only a soft feathered shade sits behind the text block, so the image mood and the person stay visible.
import { FONT_FAMILY, assTime, headAdvanceEm } from '../media/ass.js'
import { thinkerFor } from './wisdom.js'

export const THUMB = { w: 1280, h: 720, textX: 56, textMaxWidth: 640, basePx: 200, minPx: 110 } as const
export const THUMB_COLORS = { red: '#FF2D2D', purple: '#B45CFF', green: '#3DFF6E', yellow: '#FFD60A', white: '#FFFFFF' } as const
export type ThumbColor = keyof typeof THUMB_COLORS
export type ThumbLine = { text: string; color: ThumbColor }

const squash = (t: string) => String(t || '').replace(/[\s\\N.,!?…'"“”‘’·:;~-]+/g, '')
// The copy is its own click line: 2-3 short meaning units, not the title, and not a white/yellow-only stack.
export function thumbnailCopyErrors(lines: ThumbLine[], title: string): string[] {
  const e: string[] = []
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 3) e.push('lines.count')
  const ls = Array.isArray(lines) ? lines : []
  if (ls.some((l) => !squash(l?.text) || [...squash(l.text)].length > 8)) e.push('lines.length')
  if (ls.some((l) => !(l?.color in THUMB_COLORS))) e.push('lines.color')
  const joined = squash(ls.map((l) => l?.text).join('')), t = squash(title)
  if (joined && t && (joined === t || (t.includes(joined) && joined.length >= t.length * 0.6))) e.push('copies_title')
  const colors = new Set(ls.map((l) => l?.color))
  if (colors.size < 2 || ![...colors].some((c) => c === 'red' || c === 'purple' || c === 'green')) e.push('colors.monotone')
  return e
}

// A named thinker in the topic is the thumbnail's hero (recognizable likeness), never a generic elderly man.
export function thumbnailFigure(topic: string, fallback: string): string {
  const t = thinkerFor(topic)
  return t ? `${t.name}, ${t.likeness}` : fallback
}
export function figureRightPrompt(subject: string): string {
  return [
    `Wide 16:9 YouTube thumbnail artwork. Hero: ${subject}.`,
    'The person is LARGE and clearly visible, chest-up, in the RIGHT 40% of the frame, face well lit and expressive, looking toward the viewer or slightly left; the person never touches the left half.',
    'The LEFT 55% is calm, darker, simple background with the same mood (soft shadow, plain wall, sky or mist), no objects, reserved for big text added later.',
    'Rich cinematic colour, dramatic side light, strong contrast on the face. Absolutely no text, letters, numbers, calligraphy, logos or watermark.'
  ].join(' ')
}

const hex = (h: string) => { const m = /^#?([0-9a-f]{6})$/i.exec(h)!; return `&H00${m[1].slice(4, 6)}${m[1].slice(2, 4)}${m[1].slice(0, 2)}&`.toUpperCase() }
const clean = (t: string) => String(t || '').replace(/[{}\\]/g, '').trim()
export function thumbnailFontSize(lines: ThumbLine[]): number {
  const widest = Math.max(1, ...lines.map((l) => headAdvanceEm(clean(l.text))))
  return Math.max(THUMB.minPx, Math.min(THUMB.basePx, Math.floor((THUMB.textMaxWidth / widest) * 1.448)))
}
// Two layers per card: (1) black outline 12 + offset shadow, (2) the colour with a thin same-colour outline that makes
// the only bundled weight (Bold) read as Black.
export function thumbnailAss(lines: ThumbLine[]): { ass: string; fs: number; block: { x0: number; x1: number; y0: number; y1: number } } {
  const { w, h } = THUMB, fs = thumbnailFontSize(lines)
  const em = fs / 1.448, lineH = Math.round(fs * 0.86), total = lineH * lines.length
  const y0 = Math.round((h - total) / 2)
  const out = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: T,${FONT_FAMILY},${fs},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,12,7,7,0,0,0,1`,
    '', '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
  ]
  let x1 = 0
  lines.forEach((l, i) => {
    const y = y0 + i * lineH, c = hex(THUMB_COLORS[l.color]), text = clean(l.text)
    x1 = Math.max(x1, THUMB.textX + headAdvanceEm(text) * em)
    out.push(`Dialogue: 0,${assTime(0)},${assTime(5)},T,,0,0,0,,{\\an7\\pos(${THUMB.textX},${y})\\fs${fs}\\c${c}\\bord12\\shad7\\4c&H00000000&}${text}`)
    out.push(`Dialogue: 1,${assTime(0)},${assTime(5)},T,,0,0,0,,{\\an7\\pos(${THUMB.textX},${y})\\fs${fs}\\c${c}\\3c${c}\\bord2.5\\shad0}${text}`)
  })
  return { ass: [...out, ''].join('\n'), fs, block: { x0: THUMB.textX, x1: Math.round(x1), y0, y1: y0 + total } }
}
// Picture: cover-crop, a touch more colour; a feathered shade ONLY behind the text block (max ~55%, fades out before
// the figure). No full-frame box, no global darkening.
export function thumbnailPictureFilter(block: { x0: number; x1: number; y0: number; y1: number }): string {
  const { w, h } = THUMB
  const cx = Math.round((block.x0 + block.x1) / 2), cy = Math.round((block.y0 + block.y1) / 2)
  const rx = Math.round((block.x1 - block.x0) / 2 + 110), ry = Math.round((block.y1 - block.y0) / 2 + 110)
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},eq=saturation=1.12,format=rgba[pic];` +
    `color=c=black:s=${w}x${h},format=rgba,geq=r=0:g=0:b=0:a='140*clip((1.15-hypot((X-${cx})/${rx},(Y-${cy})/${ry}))/0.45,0,1)'[shade];[pic][shade]overlay=0:0`
}
export function thumbnailArgv(o: { image: string; lines: ThumbLine[]; assPath: string; fontsDir: string; out: string }): { argv: string[]; ass: string } {
  const t = thumbnailAss(o.lines)
  const e = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  return { ass: t.ass, argv: ['-y', '-i', o.image, '-filter_complex', `[0:v]${thumbnailPictureFilter(t.block)},ass=filename='${e(o.assPath)}':fontsdir='${e(o.fontsDir)}',format=yuv420p[v]`, '-map', '[v]', '-frames:v', '1', '-q:v', '2', o.out] }
}

// Click copy for a Wisdom SHORTS video (Longform gets it from its planner): 2-3 re-written meaning units + colours.
export async function openAiWisdomThumbnailCopy(input: { topic: string; title: string; hook: string; narration: string }, apiKey: string, model = process.env.OPENAI_PLAN_MODEL || 'gpt-6-luna', f: typeof fetch = fetch): Promise<{ lines: ThumbLine[]; figure: string }> {
  const schema = { type: 'object', additionalProperties: false, required: ['lines', 'figure'], properties: {
    lines: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['text', 'color'], properties: { text: { type: 'string' }, color: { type: 'string', enum: Object.keys(THUMB_COLORS) } } } },
    figure: { type: 'string' } } }
  const instructions = [
    'Write the click copy for a Korean YouTube wisdom video thumbnail. 2-3 lines, each a separate meaning unit of at most 8 Korean characters (spaces not counted).',
    'Do NOT copy or merely trim the title. Rewrite it so the reason to click (curiosity, warning, benefit, contrast) is obvious in one glance on a phone, e.g. ["절대","만만하게","보이지 마라"].',
    'Colour by meaning: the single most important word/phrase red or purple or green; never only white/yellow; do not give every line the same colour.',
    'figure: the one person who should be the hero of the thumbnail (if the topic names a philosopher or historical figure, that person with recognizable traits; otherwise a fitting sage). Describe appearance only.'
  ].join('\n')
  const res = await f('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, instructions, input: `Topic: ${input.topic}\nTitle: ${input.title}\nHook: ${input.hook}\nNarration: ${input.narration.slice(0, 1500)}`, text: { format: { type: 'json_schema', name: 'wisdom_thumbnail', strict: true, schema } } }) })
  if (!res.ok) throw new Error(`OpenAI thumbnail copy HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j: any = await res.json(); const raw = j.output_text ?? j.output?.flatMap((x: any) => x.content ?? []).find((x: any) => x.type === 'output_text')?.text
  if (!raw) throw new Error('OpenAI thumbnail copy returned no output_text')
  return JSON.parse(raw)
}
