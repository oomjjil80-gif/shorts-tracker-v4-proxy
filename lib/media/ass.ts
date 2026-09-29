// Overlay text (headline / subtitles / effect captions / callouts) as an ASS script for libass.
// libass does the Hangul shaping and line wrapping inside safe margins; the layout is measured again by QC.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const FONT_FAMILY = 'Noto Sans KR'
export const FONTS_DIR = process.env.TRACKER_FONTS_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts')
export const CANVAS = { w: 1080, h: 1920 }
// Fractions of the canvas that text pixels must stay inside (Shorts UI covers the bottom/right edges).
export const SAFE = { left: 0.04, right: 0.04, top: 0.05, bottom: 0.86 }

export type OverlayKind = 'headline' | 'subtitle' | 'effect' | 'callout'
export type OverlayEvent = { kind: OverlayKind; text: string; start: number; end: number }

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d)

// Emoji / symbols the bundled font has no glyph for would render as empty boxes.
export const sanitizeText = (t: unknown) => String(t ?? '').replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, '').replace(/[{}]/g, (c) => (c === '{' ? '(' : ')')).replace(/\r?\n/g, '\\N').replace(/\s+/g, ' ').trim()

export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100))
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

export function assColor(hex: unknown, fallback = '#FFFFFF'): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '')) || /^#?([0-9a-f]{6})$/i.exec(fallback)!
  const [r, g, b] = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)]
  return `&H00${b}${g}${r}`.toUpperCase()
}

// Shrinks the font until the text needs at most `maxLines` lines in `widthPx` (Hangul ≈ 0.72em, Latin ≈ 0.5em, bold).
export function fitFontSize(text: string, widthPx: number, basePx: number, maxLines: number, minPx = 40): number {
  const plain = text.replace(/\\N/g, '\n')
  const linesAt = (px: number) => plain.split('\n').reduce((n, ln) => {
    const w = [...ln].reduce((s, ch) => s + (/[\u3131-\u318e\uac00-\ud7a3\u4e00-\u9fff]/.test(ch) ? 0.72 : /\s/.test(ch) ? 0.3 : 0.55) * px, 0)
    return n + Math.max(1, Math.ceil(w / widthPx))
  }, 0)
  let px = basePx
  while (px > minPx && linesAt(px) > maxLines) px -= 2
  return px
}

export type AssInput = {
  totalDuration: number
  headline?: string
  subtitles?: Array<{ start: number; end: number; text: string }>
  effects?: Array<Record<string, any>>
  callouts?: Array<Record<string, any>>
}

export function buildAss(input: AssInput): { ass: string; events: OverlayEvent[] } {
  const { w, h } = CANVAS
  const total = input.totalDuration
  const marginX = Math.round(w * 0.08)
  const textWidth = w - marginX * 2
  const events: OverlayEvent[] = []
  const lines: string[] = []
  const add = (layer: number, kind: OverlayKind, style: string, start: number, end: number, text: string, override = '') => {
    if (!text || !(end > start)) return
    const s = clamp(start, 0, total), e = clamp(end, 0, total)
    if (!(e > s)) return
    events.push({ kind, text: text.replace(/\\N/g, ' '), start: s, end: e })
    lines.push(`Dialogue: ${layer},${assTime(s)},${assTime(e)},${style},,0,0,0,,${override}${text}`)
  }

  const head = sanitizeText(input.headline)
  const callouts = (input.callouts || []).filter((c) => c?.text)
  const suppress = callouts.filter((c) => c.suppressSubtitle).map((c) => ({ start: num(c.start, 0), end: num(c.end, 0) }))

  if (head) {
    const fs = fitFontSize(head, textWidth, 84, 2, 56)
    add(1, 'headline', 'Head', 0, total, head, `{\\fs${fs}}`)
  }
  for (const sub of input.subtitles || []) {
    const text = sanitizeText(sub.text)
    if (!text) continue
    // hide subtitles underneath a callout that asks for it (split around the callout span)
    let pieces = [{ start: sub.start, end: sub.end }]
    for (const sp of suppress) pieces = pieces.flatMap((p) => (sp.end <= p.start || sp.start >= p.end ? [p] : [{ start: p.start, end: Math.max(p.start, sp.start) }, { start: Math.min(p.end, sp.end), end: p.end }].filter((q) => q.end - q.start > 0.05)))
    const fs = fitFontSize(text, textWidth - 40, 60, 3, 42)
    for (const p of pieces) add(2, 'subtitle', 'Sub', p.start, p.end, text, `{\\fs${fs}}`)
  }
  const styled = (kind: 'effect' | 'callout', e: Record<string, any>, defX: number, defY: number, defPct: number, layer: number) => {
    const text = sanitizeText(e.text)
    if (!text) return
    const x = Math.round((clamp(num(e.xPct, defX), 8, 92) / 100) * w), y = Math.round((clamp(num(e.yPct, defY), 8, 78) / 100) * h)
    const fs = fitFontSize(text, Math.min(textWidth, 2 * Math.min(x, w - x) - 24), Math.round((num(e.fontSizePct, defPct) / 100) * w), 1, 36)
    const rot = num(e.rotateDeg, 0)
    const pop = e.animation === 'none' ? '' : `\\fscx72\\fscy72\\t(0,140,\\fscx100\\fscy100)`
    const tags = `{\\an5\\pos(${x},${y})\\frz${-rot}\\fs${fs}\\c${assColor(e.color)}\\3c${assColor(e.strokeColor, '#111111')}\\bord${Math.max(4, Math.round(fs * 0.09))}\\shad0${pop}}`
    add(layer, kind, 'Fx', num(e.start, 0), num(e.end, 0), text, tags)
  }
  for (const e of input.effects || []) styled('effect', e, 50, 58, 8.2, 3)
  for (const c of callouts) styled('callout', c, 48, 34, 7.6, 4)

  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    // headline: top-center, outlined; subtitle: bottom-center on a translucent box (bottom of text ≈ 78% of height)
    `Style: Head,${FONT_FAMILY},84,&H00FFFFFF,&H000000FF,&H00000000,&H99000000,1,0,0,0,100,100,0,0,1,8,2,8,${marginX},${marginX},${Math.round(h * 0.085)},1`,
    `Style: Sub,${FONT_FAMILY},60,&H00FFFFFF,&H000000FF,&H00000000,&H99000000,1,0,0,0,100,100,0,0,3,10,0,2,${marginX},${marginX},${Math.round(h * 0.22)},1`,
    `Style: Fx,${FONT_FAMILY},76,&H00FFFFFF,&H000000FF,&H00111111,&H00000000,1,0,0,0,100,100,0,0,1,6,0,5,${marginX},${marginX},0,1`,
    '', '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text', ...lines, ''
  ].join('\n')
  return { ass, events }
}

// Payload (RenderManifest.payload) -> overlay script. Source-first editorial contract: see renderManifest.js.
export function assFromPayload(payload: any) {
  return buildAss({
    totalDuration: Number(payload.totalDuration),
    headline: payload.editorialPlan?.headline || '',
    subtitles: (payload.subtitleEvents || []).filter((e: any) => e?.text).map((e: any) => ({ start: Number(e.start), end: Number(e.end), text: e.text })),
    effects: payload.sourceEffectCaptions || [],
    callouts: payload.sourceCallouts || []
  })
}
