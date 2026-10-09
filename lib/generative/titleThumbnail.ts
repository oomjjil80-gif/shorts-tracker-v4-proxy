// LONGFORM title thumbnail (every Longform profile): the words on the thumbnail ARE the video's final title, exactly —
// never shortened, summarised or reworded. The image model draws the background only (no text); the title is its own
// text layer composited here. Long titles wrap at word boundaries and the type shrinks until the block fits; the result
// is verified twice: (1) the lines put back together are the title, (2) the rendered text layer's ink stays inside the
// canvas safe area (measured on the pixels, not estimated). A title that cannot fit at the smallest size is an error,
// never a cut. Wisdom SHORTS keep their own LOCKed thumbnail (wisdomThumbnail.ts, punch lines) untouched.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FONT_FAMILY, FONTS_DIR, assTime, headAdvanceEm } from '../media/ass.js'
import { runOk } from '../media/ffmpeg.js'
import { THUMB_COLORS } from './wisdomThumbnail.js'

export const TITLE_THUMB = {
  w: 1280, h: 720, x: 56,
  safe: { left: 32, right: 32, top: 28, bottom: 28 }, // the title's ink must stay inside these margins
  widths: [700, 1168] as const, // the left 55% first (the picture keeps its right side), the full width for long titles
  maxLines: 4, maxPx: 132, minPx: 44, lineGap: 1.06
}
export class TitleThumbnailError extends Error { code = 'THUMB_TITLE_OVERFLOW' }
export const normTitle = (t: string) => String(t ?? '').replace(/\s+/g, ' ').trim()
const clean = (t: string) => t.replace(/[{}\\]/g, '') // ASS control characters only (never visible in a title)

// greedy word wrap at this size; a single word wider than the line is split between characters (text unchanged)
export function wrapTitle(title: string, fs: number, width: number): string[] {
  const em = fs / 1.448, space = headAdvanceEm(' ') * em, lines: string[] = []
  let cur = '', curW = 0
  for (const word of normTitle(title).split(' ')) {
    let w = headAdvanceEm(word) * em
    if (w > width) { // break the word itself
      for (const ch of [...word]) { const cw = headAdvanceEm(ch) * em; if (curW + cw > width && cur) { lines.push(cur); cur = ''; curW = 0 } cur += ch; curW += cw }
      continue
    }
    if (cur && curW + space + w > width) { lines.push(cur); cur = word; curW = w }
    else { cur = cur ? `${cur} ${word}` : word; curW += (curW ? space : 0) + w }
    void w
  }
  if (cur) lines.push(cur)
  return lines
}
// the lines put back together must be the title, character for character (a split word is re-joined without a space)
export function sameTitle(lines: string[], title: string): boolean {
  const t = normTitle(title).replace(/ /g, ''), j = lines.join('').replace(/ /g, '')
  return j === t && lines.every((l) => l.length > 0)
}
export type TitleLayout = { lines: string[]; fs: number; width: number; lineH: number; x: number; y0: number }
// every layout from the biggest to the smallest that passes the estimate (the pixel check picks the first that truly fits)
export function titleLayouts(title: string): TitleLayout[] {
  const T = TITLE_THUMB, out: TitleLayout[] = [], usableH = T.h - T.safe.top - T.safe.bottom
  for (const width of T.widths) {
    for (let fs = T.maxPx; fs >= T.minPx; fs -= 4) {
      const lines = wrapTitle(title, fs, width), lineH = Math.round(fs * T.lineGap)
      if (lines.length > T.maxLines || lines.length * lineH > usableH * 0.92 || !sameTitle(lines, title)) continue
      // the narrow (left) block only while the type stays big; otherwise the full width reads better
      if (width === T.widths[0] && fs < 76) continue
      out.push({ lines, fs, width, lineH, x: T.x, y0: Math.round((T.h - lines.length * lineH) / 2) })
    }
  }
  return out
}
// white title, the last line yellow; heavy black outline + shadow (the picture is not boxed)
export function titleAss(l: TitleLayout, opts: { inkOnly?: boolean } = {}): string {
  const T = TITLE_THUMB, hex = (h: string) => { const m = /^#?([0-9a-f]{6})$/i.exec(h)!; return `&H00${m[1].slice(4, 6)}${m[1].slice(2, 4)}${m[1].slice(0, 2)}&`.toUpperCase() }
  const out = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${T.w}`, `PlayResY: ${T.h}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: T,${FONT_FAMILY},${l.fs},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,10,6,7,0,0,0,1`, '', '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text']
  const bord = Math.max(5, Math.round(l.fs / 11)), shad = Math.max(3, Math.round(l.fs / 18))
  l.lines.forEach((line, i) => {
    const y = l.y0 + i * l.lineH, c = opts.inkOnly ? '&H00FFFFFF&' : hex(i === l.lines.length - 1 && l.lines.length > 1 ? THUMB_COLORS.yellow : THUMB_COLORS.white)
    // inkOnly: the whole glyph incl. outline + shadow in white on black, to measure where the ink really lands
    out.push(`Dialogue: 0,${assTime(0)},${assTime(5)},T,,0,0,0,,{\\an7\\pos(${l.x},${y})\\fs${l.fs}\\c${c}\\3c${opts.inkOnly ? '&H00FFFFFF&' : '&H00000000&'}\\bord${bord}\\shad${shad}\\4c${opts.inkOnly ? '&H00FFFFFF&' : '&H00000000&'}}${clean(line)}`)
    if (!opts.inkOnly) out.push(`Dialogue: 1,${assTime(0)},${assTime(5)},T,,0,0,0,,{\\an7\\pos(${l.x},${y})\\fs${l.fs}\\c${c}\\3c${c}\\bord2\\shad0}${clean(line)}`)
  })
  return [...out, ''].join('\n')
}
const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
async function fontEnv(work: string) {
  const conf = join(work, 'fonts.conf')
  await writeFile(conf, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${FONTS_DIR}</dir><cachedir>${work}/font-cache</cachedir></fontconfig>`, 'utf8')
  return { FONTCONFIG_FILE: conf, FONTCONFIG_PATH: work }
}
// where the text layer's ink actually is (pixels), at full canvas size
export async function inkBox(ass: string, work: string, env: Record<string, string>): Promise<{ x0: number; y0: number; x1: number; y1: number } | null> {
  const T = TITLE_THUMB, a = join(work, `ink-${Math.random().toString(36).slice(2)}.ass`)
  await writeFile(a, ass, 'utf8')
  const raw = (await runOk(['-f', 'lavfi', '-i', `color=c=black:s=${T.w}x${T.h}`, '-vf', `ass=filename='${esc(a)}':fontsdir='${esc(FONTS_DIR)}',format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], { env })).stdout as Buffer
  let x0 = T.w, y0 = T.h, x1 = -1, y1 = -1
  for (let y = 0; y < T.h; y++) for (let x = 0; x < T.w; x++) if (raw[y * T.w + x] > 48) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}
export const insideSafe = (b: { x0: number; y0: number; x1: number; y1: number }) => { const T = TITLE_THUMB; return b.x0 >= T.safe.left && b.y0 >= T.safe.top && b.x1 <= T.w - T.safe.right && b.y1 <= T.h - T.safe.bottom }

// picture: cover-crop, a touch more colour; a feathered shade ONLY behind the title block (no full-frame darkening)
function pictureFilter(b: { x0: number; y0: number; x1: number; y1: number }) {
  const T = TITLE_THUMB, cx = Math.round((b.x0 + b.x1) / 2), cy = Math.round((b.y0 + b.y1) / 2), rx = Math.round((b.x1 - b.x0) / 2 + 90), ry = Math.round((b.y1 - b.y0) / 2 + 80)
  return `scale=${T.w}:${T.h}:force_original_aspect_ratio=increase,crop=${T.w}:${T.h},eq=saturation=1.08,format=rgba[pic];` +
    `color=c=black:s=${T.w}x${T.h},format=rgba,geq=r=0:g=0:b=0:a='110*clip((1.15-hypot((X-${cx})/${rx},(Y-${cy})/${ry}))/0.45,0,1)'[shade];[pic][shade]overlay=0:0`
}
export type TitleThumbnail = { bytes: Buffer; title: string; lines: string[]; fs: number; ink: { x0: number; y0: number; x1: number; y1: number } }
// background picture + the exact title -> 1280x720 JPEG; verified (text identical, ink inside the safe area)
export async function composeTitleThumbnail(o: { background: Buffer; title: string }): Promise<TitleThumbnail> {
  const title = normTitle(o.title)
  if (!title) throw new TitleThumbnailError('the video has no title to put on the thumbnail')
  const work = await mkdtemp(join(tmpdir(), 'title-thumb-'))
  try {
    const env = await fontEnv(work)
    for (const l of titleLayouts(title)) {
      const ink = await inkBox(titleAss(l, { inkOnly: true }), work, env)
      if (!ink || !insideSafe(ink)) continue
      const bg = join(work, 'bg.img'), ass = join(work, 'title.ass'), out = join(work, 'thumb.jpg')
      await writeFile(bg, o.background); await writeFile(ass, titleAss(l), 'utf8')
      await runOk(['-y', '-i', bg, '-filter_complex', `[0:v]${pictureFilter(ink)},ass=filename='${esc(ass)}':fontsdir='${esc(FONTS_DIR)}',format=yuv420p[v]`, '-map', '[v]', '-frames:v', '1', '-q:v', '2', out], { env })
      return { bytes: await readFile(out), title, lines: l.lines, fs: l.fs, ink }
    }
    throw new TitleThumbnailError(`the title does not fit the thumbnail even at ${TITLE_THUMB.minPx}px on ${TITLE_THUMB.maxLines} lines (${[...title].length} characters); it is never shortened`)
  } finally { await rm(work, { recursive: true, force: true }) }
}

// STORY MATCH: the thumbnail background shows the scene the TITLE is about (most shared words between the title and the
// scene's own narration / description), never an arbitrary scene; the last 20% (the reveal / ending) is never used, so
// the picture does not give the answer away. No word in common -> the given fallback scene.
export function titleSceneIndex(title: string, scenes: Array<{ id: string; text: string }>, fallback: number): number {
  const words = (s: string) => new Set((String(s).match(/[가-힣]{2,}/g) ?? []).map((w) => w.slice(0, 2)))
  const t = words(title), limit = Math.max(1, Math.floor(scenes.length * 0.8))
  let best = -1, bestScore = 0
  scenes.slice(0, limit).forEach((sc, i) => { const w = words(sc.text); let n = 0; for (const x of t) if (w.has(x)) n++; if (n > bestScore) { bestScore = n; best = i } })
  return best >= 0 ? best : Math.min(fallback, limit - 1)
}
// the image model draws the BACKGROUND only: this story's moment for this title, bright and clear, no text at all
// styleNeutral: the content's own style contract decides the look (야담): no colour / light words here
export const thumbnailBackgroundPrompt = (title: string, scenePrompt: string, o: { styleNeutral?: boolean } = {}) => [
  `YouTube thumbnail BACKGROUND ARTWORK for a video about: ${normTitle(title)}. Show exactly this story moment (scene below), so the picture and the title tell the same story.`,
  o.styleNeutral ? 'The main person large and expressive on the RIGHT half; the LEFT half simpler and calmer (the title is added there later).' : 'Clean, bright, clearly lit picture with clear, lively (not muddy, not grey or brown haze, not dark) colours and well-lit attractive faces; the main person large and expressive on the RIGHT half; the LEFT half simpler and calmer (the title is added there later).',
  'ABSOLUTELY NO text, letters, words, numbers, calligraphy, captions, signs, logos or watermark anywhere in the picture.',
  '',
  scenePrompt
].join('\n')
