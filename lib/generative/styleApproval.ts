// THUMBNAIL FIRST + STYLE LOCK — one module for every profile that makes pictures (no profile-specific code here).
// After PLAN, before the bulk of the pictures: (1) the click copy is checked (and rewritten once if needed), (2) ONE
// background picture is drawn and the copy is composited on it as real text (exact Korean, 1280x720), (3) the job waits
// for the user: approve or draw again. (4) After approval the approved picture IS the style reference: every later picture
// is drawn from that image (image-to-image) plus the visual features measured from it (palette, light, contrast) — never
// just a style name. (5) One representative scene is drawn first and compared with the reference; only a match unlocks
// the rest (a mismatch redraws that one scene, never the whole set).
import { readFile } from 'node:fs/promises'
import { runOk } from '../media/ffmpeg.js'
import { thumbnailCopyErrors, type ThumbLine } from './wisdomThumbnail.js'
import { revealWords } from './yasaLongform.js'

// Which profiles go through it. Off = the profile behaves exactly as before (Wisdom Shorts: its LOCKed pipeline).
export const STYLE_APPROVAL: Readonly<Record<string, { enabled: boolean; note?: string }>> = {
  yasa_longform: { enabled: true },
  senior_longform: { enabled: true },
  wisdom_longform: { enabled: true },
  wisdom: { enabled: false, note: 'Wisdom Shorts LOCK: its own ANALYZE/PLAN/ASSET/DECISION pipeline stays unchanged' },
  source_shorts: { enabled: false, note: 'a source video is never redrawn' }
}
export const styleApprovalOn = (profile: string) => STYLE_APPROVAL[profile]?.enabled === true
// a brief asks for it explicitly (new jobs from the app); briefs from before (and remasters of them) are unchanged
export const styleApprovalWanted = (profile: string, brief: any) => styleApprovalOn(profile) && brief?.thumbnailFirst === true

// texture = how it is drawn (edges, fine detail, outlines, flat fills, colour variation); colour alone cannot tell two
// art styles apart (measured on the 5 real 그림체 previews: 9 of 10 different-style pairs were within STYLE_MATCH on colour)
export type StyleTexture = { edge: number; strong: number; detail: number; lines: number; flat: number; satSd: number }
export type StyleFeatures = { brightness: number; saturation: number; contrast: number; hue: number[]; palette: string[]; texture?: StyleTexture }
export type StyleApprovalRecord = {
  schema: 'style-approval/1'
  status: 'pending' | 'approved'
  attempts: Array<{ n: number; backgroundRef: string; thumbnailRef: string; lines: ThumbLine[]; copyIssues: string[]; imageIssues: string[]; at: string }>
  regenerate?: boolean
  redrawRepresentative?: boolean
  approved?: { n: number; backgroundRef: string; thumbnailRef: string; features: StyleFeatures; at: string }
  representative?: { sceneId: string | null; ref: string; distance: number; textureDistance?: number; judge?: StyleJudgement | null; status: 'match' | 'mismatch'; tries: number }
}
export type StyleJudgement = { same: boolean; score: number; differences: string[] }
// the final word on "same art style": one small vision call with both pictures (only after the free checks passed)
export type StyleJudge = (reference: Buffer, candidate: Buffer, apiKey: string) => Promise<StyleJudgement>
export const STYLE_JUDGE_MIN = 75
export const styleApprovalRef = (jobId: string) => `style-approval/${jobId}.json`

// ---- the copy: deterministic checks (format, the title, broken Hangul, spoilers of the answer) ----
const squash = (t: string) => String(t || '').replace(/[\s.,!?…'"“”‘’·:;~-]+/g, '')
export function thumbnailCopyIssues(script: any, profile: string): string[] {
  const lines: ThumbLine[] = Array.isArray(script?.thumbnail?.lines) ? script.thumbnail.lines : []
  const e = thumbnailCopyErrors(lines, String(script?.title || '')).map((x) => `copy.${x}`)
  const text = lines.map((l) => String(l?.text || '')).join(' ')
  if (/[ㄱ-ㅎㅏ-ㅣ]/.test(text)) e.push('copy.broken_hangul')
  if (/(.)\1\1/.test(squash(text))) e.push('copy.repeated_letters')
  if (/[A-Za-z]{3,}/.test(text)) e.push('copy.latin_words')
  // never the answer of the story (the click must make the viewer ask, not tell them)
  const dna = script?.yasaStoryDNA
  if (dna) { const leak = revealWords(dna).filter((w) => squash(text).includes(squash(w))); if (leak.length) e.push(`copy.spoiler: ${leak.slice(0, 3).join(', ')}`) }
  // the copy must belong to THIS story: at least one word of it appears in the title, the hook or the narration
  const story = squash([script?.title, script?.hook, ...(script?.sections ?? []).flatMap((s: any) => (s?.sentences ?? []).map((x: any) => x?.say))].join(' '))
  const words = (text.match(/[가-힣]{2,}/g) ?? []).map((w) => w.slice(0, 2))
  if (words.length && !words.some((w) => story.includes(w))) e.push('copy.not_about_this_story')
  void profile
  return e
}

// ---- the picture: measured features of an image (64x36, no AI) ----
export async function imageStyleFeatures(path: string): Promise<StyleFeatures> {
  const raw = (await runOk(['-i', path, '-vf', 'scale=64:36,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'])).stdout as Buffer
  const n = Math.floor(raw.length / 3), hue = new Array(12).fill(0), counts = new Map<string, number>()
  let sumL = 0, sumL2 = 0, sumS = 0, wHue = 0
  for (let i = 0; i < n; i++) {
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    const l = 0.299 * r + 0.587 * g + 0.114 * b, s = mx ? (mx - mn) / mx : 0
    sumL += l; sumL2 += l * l; sumS += s
    if (mx - mn > 8) {
      let h = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4
      h = (h * 60 + 360) % 360; hue[Math.floor(h / 30) % 12] += s; wHue += s
    }
    const key = [r, g, b].map((c) => Math.min(3, c >> 6)).join(''); counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const mean = sumL / Math.max(1, n)
  const palette = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => '#' + [...k].map((d) => (Number(d) * 64 + 32).toString(16).padStart(2, '0')).join(''))
  return { texture: await imageTextureFeatures(path), brightness: Math.round(mean), saturation: Number((sumS / Math.max(1, n)).toFixed(3)), contrast: Math.round(Math.sqrt(Math.max(0, sumL2 / Math.max(1, n) - mean * mean))), hue: hue.map((x) => Number((wHue ? x / wHue : 0).toFixed(3))), palette }
}
// the drawing itself at a fixed pixel scale (height 256): gradients, fine detail, thin dark outlines, flat fills
export async function imageTextureFeatures(path: string): Promise<StyleTexture> {
  const ppm = (await runOk(['-i', path, '-vf', 'scale=-2:256', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'ppm', '-'])).stdout as Buffer
  const m = ppm.toString('latin1', 0, 40).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/)
  if (!m) throw new Error('texture: unexpected ppm header')
  const W = Number(m[1]), H = Number(m[2]), off = m[0].length, L = new Float32Array(W * H), S = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) { const r = ppm[off + i * 3], g = ppm[off + i * 3 + 1], b = ppm[off + i * 3 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); L[i] = 0.299 * r + 0.587 * g + 0.114 * b; S[i] = mx ? (mx - mn) / mx : 0 }
  let edges = 0, strong = 0, detail = 0, lines = 0, flat = 0, n = 0
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, g = Math.hypot(L[i + 1] - L[i - 1], L[i + W] - L[i - W]), avg = (L[i - 1] + L[i + 1] + L[i - W] + L[i + W]) / 4
    n++; detail += Math.abs(L[i] - avg); if (g > 20) edges++; if (g > 60) strong++; if (L[i] < 70 && avg - L[i] > 18) lines++; if (g < 3) flat++
  }
  let sm = 0; for (const v of S) sm += v; sm /= Math.max(1, S.length); let sv = 0; for (const v of S) sv += (v - sm) ** 2
  const r4 = (x: number) => Number(x.toFixed(4)), N = Math.max(1, n)
  return { edge: r4(edges / N), strong: r4(strong / N), detail: r4(detail / N), lines: r4(lines / N), flat: r4(flat / N), satSd: r4(Math.sqrt(sv / Math.max(1, S.length))) }
}
// 0 = drawn the same way. Same picture, other composition: <= 0.23; different styles of the same scene: >= 0.23 (real previews).
// So it is a free PREFILTER only (above TEXTURE_MATCH = clearly another style, no AI call); a pass still needs the judge.
export const TEXTURE_MATCH = 0.3
const TEXTURE_KEYS: Array<keyof StyleTexture> = ['edge', 'strong', 'detail', 'lines', 'flat', 'satSd']
export function textureDistance(a?: StyleTexture, b?: StyleTexture): number {
  if (!a || !b) return Infinity
  return Number((TEXTURE_KEYS.reduce((s, k) => s + Math.abs(Math.log((a[k] + 0.004) / (b[k] + 0.004))), 0) / TEXTURE_KEYS.length).toFixed(3))
}
// 0 = the same look; the representative scene must stay under STYLE_MATCH of the approved picture
export const STYLE_MATCH = 0.35
export function styleDistance(a: StyleFeatures, b: StyleFeatures): number {
  const hue = a.hue.reduce((s, x, i) => s + Math.abs(x - (b.hue[i] ?? 0)), 0) / 2
  return Number((0.45 * hue + 0.2 * Math.abs(a.saturation - b.saturation) / 0.6 + 0.2 * Math.abs(a.brightness - b.brightness) / 120 + 0.15 * Math.abs(a.contrast - b.contrast) / 70).toFixed(3))
}
// the measured look as words for the prompt (alongside the reference image itself, never instead of it)
export function styleFeatureText(f: StyleFeatures): string {
  const tone = f.brightness > 150 ? 'bright' : f.brightness < 85 ? 'dark, low-key' : 'mid-tone'
  const sat = f.saturation > 0.45 ? 'rich saturated' : f.saturation < 0.2 ? 'soft muted' : 'moderately saturated'
  return `STYLE LOCK — draw in exactly the same rendering as the attached approved reference image: the same coloring method, line work and texture, color palette (${f.palette.join(', ')}), ${tone} lighting, ${sat} colors, contrast ${f.contrast > 60 ? 'strong' : f.contrast < 35 ? 'gentle' : 'moderate'}, the same way of drawing people (faces, proportions) and the same country / era setting. Only the people and the scene change; the art style never does.`
}
// mobile check of a composed thumbnail: not blank, not too dark, readable (no AI)
export async function thumbnailImageIssues(path: string): Promise<string[]> {
  const f = await imageStyleFeatures(path), e: string[] = []
  if (f.brightness < 35) e.push('image.too_dark')
  if (f.contrast < 12) e.push('image.flat_or_blank')
  return e
}
export const readBytes = (p: string) => readFile(p)
