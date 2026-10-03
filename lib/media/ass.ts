// Overlay text (headline / subtitles / effect captions / callouts) as an ASS script for libass.
// libass does the Hangul shaping and line wrapping inside safe margins; the layout is measured again by QC.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { COMMON_SHORTS_SCREEN_DNA } from './screenDnaContract.js'

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

// Wisdom headline sizing from the bundled Noto Sans KR Bold metrics (units/em = 1000).
// libass maps \fs to the font's full ascent+descent box (usWinAscent 1160 + usWinDescent 288 = 1.448em), NOT to the em:
// \fs100 draws a ~69px em and ~62px-tall Hangul. That is why raising a fixed size 84→100 barely changed the screen.
const HEAD_FONT = { cell: 1.448, ascent: 1.16, inkTop: 0.84, inkBottom: 0.09 }
// Visible ink must stay inside the 360px top band (QC accepts y 16..352, x 43..1037).
export const WISDOM_HEAD_BAND = { centerY: COMMON_SHORTS_SCREEN_DNA.top.y + COMMON_SHORTS_SCREEN_DNA.top.h / 2, maxInkWidth: 984, maxInkHeight: 300 }
// Advance width in em: every Hangul syllable is 920 units in this font; punctuation/Latin from hmtx (wide Latin rounded up).
export const headAdvanceEm = (line: string) => [...line].reduce((s, ch) => s + (/[ㄱ-ㆎ가-힣一-鿿]/.test(ch) ? 0.92 : ch === ' ' ? 0.227 : /[,.'":;!]/.test(ch) ? 0.37 : /[MWmw]/.test(ch) ? 0.97 : 0.65), 0)

// Largest size whose widest line fills the band width without wrapping and whose ink fits the band height,
// positioned so the visible ink (not libass's line box) is centered in the band.
export function wisdomHeadlineLayout(lines: string[]): { fs: number; em: number; x: number; y: number } {
  const n = Math.max(1, lines.length)
  const widest = Math.max(1, ...lines.map(headAdvanceEm))
  const inkTop = HEAD_FONT.ascent - HEAD_FONT.inkTop // first line's ink starts this far below the box top
  const inkBottom = (n - 1) * HEAD_FONT.cell + HEAD_FONT.ascent + HEAD_FONT.inkBottom
  // height budget is always the two-line block, so a one-word headline is not blown up beyond the two-line look
  const twoLineInk = HEAD_FONT.cell + HEAD_FONT.inkTop + HEAD_FONT.inkBottom
  const em = Math.floor(Math.min(WISDOM_HEAD_BAND.maxInkWidth / widest, WISDOM_HEAD_BAND.maxInkHeight / Math.max(inkBottom - inkTop, twoLineInk)))
  const inkCenterBelowBoxCenter = (inkTop + inkBottom) / 2 - (n * HEAD_FONT.cell) / 2
  return { fs: Math.round(em * HEAD_FONT.cell), em, x: CANVAS.w / 2, y: Math.round(WISDOM_HEAD_BAND.centerY - inkCenterBelowBoxCenter * em) }
}

export type AssInput = {
  totalDuration: number
  wisdomLayout?: boolean
  // Common Shorts Screen DNA text layout: 2-line headline in the top band, max-2-line captions in the bottom band, and
  // nothing else (the visual window carries no text, so effect captions / callouts are not drawn).
  screenDna?: boolean
  headline?: string
  subtitles?: Array<{ start: number; end: number; text: string }>
  effects?: Array<Record<string, any>>
  callouts?: Array<Record<string, any>>
}

export function buildAss(input: AssInput): { ass: string; events: OverlayEvent[] } {
  const { w, h } = CANVAS
  const total = input.totalDuration
  const wisdom = input.wisdomLayout === true || input.screenDna === true
  const marginX = Math.round(w * 0.08)
  const textWidth = w - marginX * 2
  const events: OverlayEvent[] = []
  const lines: string[] = []
  const add = (layer: number, kind: OverlayKind, style: string, start: number, end: number, text: string, override = '', renderText = text) => {
    if (!text || !(end > start)) return
    const s = clamp(start, 0, total), e = clamp(end, 0, total)
    if (!(e > s)) return
    events.push({ kind, text: text.replace(/\\N/g, ' '), start: s, end: e })
    lines.push(`Dialogue: ${layer},${assTime(s)},${assTime(e)},${style},,0,0,0,,${override}${renderText}`)
  }

  const head = sanitizeText(input.headline)
  const callouts = wisdom ? [] : (input.callouts || []).filter((c) => c?.text)
  const suppress = callouts.filter((c) => c.suppressSubtitle).map((c) => ({ start: num(c.start, 0), end: num(c.end, 0) }))

  if (head) {
    if (wisdom) {
      const plain = head.replace(/\\N/g, ' ').trim()
      const words = plain.split(/\s+/).filter(Boolean)
      let cut = Math.max(1, Math.min(words.length - 1, Math.ceil(words.length / 2)))
      if (words.length > 1) {
        let best = Infinity
        for (let i = 1; i < words.length; i++) {
          // the wider line sets the font size, so minimize the wider line's rendered width
          const score = Math.max(headAdvanceEm(words.slice(0, i).join(' ')), headAdvanceEm(words.slice(i).join(' ')))
          if (score < best) { best = score; cut = i }
        }
      }
      const line1 = words.slice(0, cut).join(' ')
      const line2 = words.slice(cut).join(' ')
      const render = line2 ? `${line1}\\N{\\c&H0000D7FF&}${line2}` : line1
      // \q2 = never auto-wrap: exactly the two lines above, sized so neither overflows.
      const hl = wisdomHeadlineLayout(line2 ? [line1, line2] : [line1])
      add(1, 'headline', 'WisdomHead', 0, total, head, `{\\an5\\q2\\pos(${hl.x},${hl.y})\\fs${hl.fs}\\c&H00FFFFFF&}`, render)
    } else {
      add(1, 'headline', 'Head', 0, total, head, `{\\fs${fitFontSize(head, textWidth, 84, 2, 56)}}`)
    }
  }
  for (const sub of input.subtitles || []) {
    const text = sanitizeText(sub.text)
    if (!text) continue
    // hide subtitles underneath a callout that asks for it (split around the callout span)
    let pieces = [{ start: sub.start, end: sub.end }]
    for (const sp of suppress) pieces = pieces.flatMap((p) => (sp.end <= p.start || sp.start >= p.end ? [p] : [{ start: p.start, end: Math.max(p.start, sp.start) }, { start: Math.min(p.end, sp.end), end: p.end }].filter((q) => q.end - q.start > 0.05)))
    const fs = fitFontSize(text, textWidth - 40, 60, wisdom ? 2 : 3, 42)
    for (const p of pieces) add(2, 'subtitle', wisdom ? 'WisdomSub' : 'Sub', p.start, p.end, text, `{\\fs${fs}}`)
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
  for (const e of wisdom ? [] : input.effects || []) styled('effect', e, 50, 58, 8.2, 3)
  for (const c of callouts) styled('callout', c, 48, 34, 7.6, 4)

  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    // headline: top-center, outlined; subtitle: bottom-center on a translucent box (bottom of text ≈ 78% of height)
    `Style: Head,${FONT_FAMILY},84,&H00FFFFFF,&H000000FF,&H00000000,&H99000000,1,0,0,0,100,100,0,0,1,8,2,8,${marginX},${marginX},${Math.round(h * 0.085)},1`,
    `Style: WisdomHead,${FONT_FAMILY},78,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,8,${marginX},${marginX},${Math.round(h * 0.055)},1`,
    `Style: WisdomSub,${FONT_FAMILY},56,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,2,${marginX},${marginX},${Math.round(h * 0.055)},1`,
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
    wisdomLayout: payload.editorialPlan?.profile === 'wisdom-v1',
    screenDna: true, // every 1080x1920 Short uses the Common Shorts Screen DNA
    headline: payload.editorialPlan?.headline || '',
    subtitles: (payload.subtitleEvents || []).filter((e: any) => e?.text).map((e: any) => ({ start: Number(e.start), end: Number(e.end), text: e.text })),
    effects: payload.sourceEffectCaptions || [],
    callouts: payload.sourceCallouts || []
  })
}
