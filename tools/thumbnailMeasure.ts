// Thumbnail measurement helpers shared by the Wisdom thumbnail and Longform tests (pixels of the produced JPEG).
import assert from 'node:assert/strict'
import { runOk } from '../lib/media/ffmpeg.js'
import { THUMB_COLORS, type ThumbLine } from '../lib/generative/wisdomThumbnail.js'

const W = 1280, H = 720 // Longform canvas (default); the Shorts portrait canvas is passed explicitly
// stand-in "portrait": a lit bust (head, beard, shoulders) on a dark painterly background
export async function standInPortrait(path: string, o: { side: 'left' | 'right'; tint: [number, number, number]; bg: [number, number, number] }) {
  const cx = o.side === 'right' ? 1130 : 406, [tr, tg, tb] = o.tint, [br, bgc, bb] = o.bg
  const body = `(exp(-((X-${cx})*(X-${cx})/14000+(Y-360)*(Y-360)/24000))+0.8*exp(-((X-${cx})*(X-${cx})/9000+(Y-560)*(Y-560)/9000))+0.9*exp(-((X-${cx})*(X-${cx})/90000+(Y-1000)*(Y-1000)/60000)))`
  const tex = '(1+0.06*sin(X/5)*sin(Y/7))'
  await runOk(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1536x1024:d=1', '-vf',
    `geq=r='clip(${br}+${tr}*${body}*${tex},0,255)':g='clip(${bgc}+${tg}*${body}*${tex},0,255)':b='clip(${bb}+${tb}*${body}*${tex},0,255)'`, '-frames:v', '1', '-q:v', '2', path])
}
export const rgb = async (p: string, w = W, h = H) => (await runOk(['-i', p, '-frames:v', '1', '-vf', `scale=${w}:${h},format=rgb24`, '-f', 'rawvideo', '-'])).stdout
export const cover = async (p: string, w = W, h = H) => (await runOk(['-i', p, '-frames:v', '1', '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},format=rgb24`, '-f', 'rawvideo', '-'])).stdout
// portrait stand-in (1024x1536, like the Shorts thumbnail provider): a lit bust centred in the LOWER part
export async function standInPortraitTall(path: string, o: { tint: [number, number, number]; bg: [number, number, number] }) {
  const [tr, tg, tb] = o.tint, [br, bgc, bb] = o.bg
  const body = '(exp(-((X-512)*(X-512)/16000+(Y-930)*(Y-930)/26000))+0.9*exp(-((X-512)*(X-512)/90000+(Y-1420)*(Y-1420)/60000)))'
  await runOk(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1024x1536:d=1', '-vf',
    `geq=r='clip(${br}+${tr}*${body},0,255)':g='clip(${bgc}+${tg}*${body},0,255)':b='clip(${bb}+${tb}*${body},0,255)'`, '-frames:v', '1', '-q:v', '2', path])
}
// Shorts (9:16) thumbnail: text bbox (accent-colour pixels) vs the figure (bright source region), measured at full size
export function measureTallThumbnail(t: Buffer, src: Buffer, lines: ThumbLine[], w = 1080, h = 1920) {
  let x0 = w, x1 = -1, y0 = h, y1 = -1; const accent: Record<string, number> = {}, rows = new Array(h).fill(0)
  const ref = Object.entries(THUMB_COLORS).map(([k, c]) => [k, parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)] as const)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3
    for (const [k, r, g, b] of ref) if (Math.abs(t[o] - r) + Math.abs(t[o + 1] - g) + Math.abs(t[o + 2] - b) < 70) { accent[k] = (accent[k] || 0) + 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; rows[y]++; break }
  }
  let fy0 = h
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { const o = (y * w + x) * 3; if (lum(src, o) > 110 && y < fy0) fy0 = y }
  const textLines: Array<[number, number]> = []
  rows.forEach((c, k) => { if (c > 8) { const l = textLines[textLines.length - 1]; if (l && k - l[1] <= 8) l[1] = k; else textLines.push([k, k]) } })
  return { text: { x0, x1, y0, y1 }, figure: { y0: fy0 }, accent, lines: textLines.length, linesIn: lines.length, w, h }
}
export function assertTallThumbnail(m: ReturnType<typeof measureTallThumbnail>, label: string) {
  assert.ok(m.text.x0 >= 20 && m.text.x1 <= m.w - 20 && m.text.y0 >= 40, `${label}: text not clipped ${JSON.stringify(m.text)}`)
  assert.ok(m.text.y1 <= m.h * 0.45, `${label}: text in the upper band ${JSON.stringify(m.text)}`)
  assert.ok(m.figure.y0 > m.text.y1, `${label}: text and figure do not overlap (text y1 ${m.text.y1}, figure y0 ${m.figure.y0})`)
  const colours = Object.entries(m.accent).filter(([, v]) => v > 3000).map(([k]) => k)
  assert.ok(colours.length >= 2 && colours.some((c) => ['red', 'purple', 'green'].includes(c)), `${label}: meaning colours ${JSON.stringify(m.accent)}`)
  assert.equal(m.lines, m.linesIn, `${label}: ${m.lines} text lines`)
}
const lum = (f: Buffer, o: number) => 0.299 * f[o] + 0.587 * f[o + 1] + 0.114 * f[o + 2] // luma (saturation-neutral)

// Everything a thumbnail must satisfy, measured against the plain (cover-cropped) source picture.
export function measureThumbnail(t: Buffer, src: Buffer, lines: ThumbLine[]) {
  // text = strongly saturated accent pixels or pure white glyph pixels or black outline that the source does not have
  let x0 = W, x1 = -1, y0 = H, y1 = -1, darkened = 0, accent: Record<string, number> = {}
  const ref = Object.entries(THUMB_COLORS).map(([k, h]) => [k, parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as const)
  const rows = new Array(H).fill(0)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3
    for (const [k, r, g, b] of ref) if (Math.abs(t[o] - r) + Math.abs(t[o + 1] - g) + Math.abs(t[o + 2] - b) < 70) { accent[k] = (accent[k] || 0) + 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; rows[y]++; break }
    if (lum(t, o) < lum(src, o) * 0.6 && lum(src, o) > 25) darkened++
  }
  // figure = the bright region of the SOURCE picture
  let fx0 = W, fx1 = -1
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { const o = (y * W + x) * 3; if (lum(src, o) > 110) { if (x < fx0) fx0 = x; if (x > fx1) fx1 = x } }
  let rs = 0, rt = 0
  for (let y = 0; y < H; y += 2) for (let x = Math.round(W * 0.72); x < W; x += 2) { const o = (y * W + x) * 3; rs += lum(src, o); rt += lum(t, o) }
  const textLines: Array<[number, number]> = []
  rows.forEach((c, k) => { if (c > 8) { const l = textLines[textLines.length - 1]; if (l && k - l[1] <= 6) l[1] = k; else textLines.push([k, k]) } })
  return { text: { x0, x1, y0, y1 }, figure: { x0: fx0, x1: fx1 }, accent, lines: textLines.length, lineHeights: textLines.map(([a, b]) => b - a + 1),
    darkenedFraction: Number((darkened / (W * H)).toFixed(3)), figureBrightnessKept: Number((rt / Math.max(1, rs)).toFixed(3)), copyErrors: [] as string[], linesIn: lines.length }
}
export function assertThumbnail(m: ReturnType<typeof measureThumbnail>, label: string) {
  assert.ok(m.text.x0 >= 20 && m.text.x1 <= W * 0.62 && m.text.y0 >= 12 && m.text.y1 <= H - 12, `${label}: text LEFT and not clipped ${JSON.stringify(m.text)}`)
  assert.ok(m.figure.x0 > m.text.x1, `${label}: text and figure do not overlap (text x1 ${m.text.x1}, figure x0 ${m.figure.x0})`)
  assert.ok(m.figure.x0 >= W * 0.5, `${label}: figure RIGHT ${JSON.stringify(m.figure)}`)
  assert.ok(m.darkenedFraction <= 0.3, `${label}: no full-frame dark box (darkened ${m.darkenedFraction})`)
  assert.ok(m.figureBrightnessKept >= 0.97, `${label}: figure side not darkened (${m.figureBrightnessKept})`)
  const colours = Object.entries(m.accent).filter(([k, v]) => v > 3000).map(([k]) => k)
  assert.ok(colours.length >= 2 && colours.some((c) => ['red', 'purple', 'green'].includes(c)), `${label}: meaning colours ${JSON.stringify(m.accent)}`)
  assert.ok(m.lines === m.linesIn && m.lineHeights.every((h) => h * 320 / W >= 26), `${label}: ${m.lines} lines, heights ${m.lineHeights} (>=26px at 320px phone list width)`)
}

