// COMMON SHORTS SCREEN DNA — the single geometry contract of every 9:16 Short (General / Wisdom / future profiles).
// 1080x1920: TOP black 0..359 (headline only) / CENTER visual 360..1559 / BOTTOM black 1560..1919 (captions only).
// Every producer (ASSET for pre-composed sources, RENDER for raw sources), the overlay layout and AUTO_QC read these
// numbers from here; no other file may define the bands. Dependency-free on purpose (ass.ts, render.ts, qc import it).

export type Rect = { x: number; y: number; w: number; h: number }
export type ScreenDna = { schema: 'shorts-screen-dna/1'; canvas: { w: number; h: number }; top: Rect; center: Rect; bottom: Rect; tolerancePx: 0 }
export const COMMON_SHORTS_SCREEN_DNA: ScreenDna = Object.freeze({
  schema: 'shorts-screen-dna/1', canvas: Object.freeze({ w: 1080, h: 1920 }),
  top: Object.freeze({ x: 0, y: 0, w: 1080, h: 360 }), center: Object.freeze({ x: 0, y: 360, w: 1080, h: 1200 }), bottom: Object.freeze({ x: 0, y: 1560, w: 1080, h: 360 }),
  tolerancePx: 0
}) as ScreenDna
/** @deprecated name kept for PR #102 callers; identical object */
export const SHORTS_SCREEN_DNA = COMMON_SHORTS_SCREEN_DNA

// Which overlay kinds a zone may carry. Effect captions / callouts have no zone (CENTER is visual only) and are not drawn.
export const SCREEN_DNA_TEXT_ZONES = Object.freeze({ headline: 'top', subtitle: 'bottom' } as const)
export const bandOf = (dna: ScreenDna, kind: string): Rect | null => (kind === 'headline' ? dna.top : kind === 'subtitle' ? dna.bottom : null)

// Producer A — ASSET builds a pre-composed source per beat image (Wisdom). Byte-identical to the v1 filter.
export function screenDnaSegmentFilter(dna: ScreenDna = COMMON_SHORTS_SCREEN_DNA, fps = 30): string {
  const c = dna.center
  return `scale=${c.w}:${c.h}:force_original_aspect_ratio=increase,crop=${c.w}:${c.h},zoompan=z='min(zoom+0.00035,1.035)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${c.w}x${c.h}:fps=${fps},pad=${dna.canvas.w}:${dna.canvas.h}:${c.x}:${c.y}:black,format=yuv420p`
}
export function screenDnaSegmentArgv(imagePath: string, audioPath: string, durationSec: number, outPath: string, vf = screenDnaSegmentFilter()): string[] {
  return ['-y', '-loop', '1', '-i', imagePath, '-i', audioPath, '-t', String(durationSec), '-vf', vf, '-af', 'apad', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '4', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', outPath]
}

// Producer B — RENDER places a raw source picture (General / source-first) into the visual window: cover-scale, centre
// crop to the window, black bands. Same window, same bands, same numbers as producer A.
export function screenDnaWindowFilter(dna: ScreenDna = COMMON_SHORTS_SCREEN_DNA): string {
  const c = dna.center
  return `scale=${c.w}:${c.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${c.w}:${c.h},pad=${dna.canvas.w}:${dna.canvas.h}:${c.x}:${c.y}:black`
}

// RENDER pass-through for a source producer A already composed (keeps a canvas-sized source pixel-for-pixel).
export function screenDnaComposedFilter(dna: ScreenDna = COMMON_SHORTS_SCREEN_DNA): string {
  return `scale=${dna.canvas.w}:${dna.canvas.h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${dna.canvas.w}:${dna.canvas.h}:(ow-iw)/2:(oh-ih)/2:black`
}

// The part of a raw source frame that producer B shows in the visual window (cover-scale + centre crop), optionally after
// the embedded-picture crop. Used to compare the same picture region between the source and the output.
export function windowSourceRect(srcW: number, srcH: number, crop: { x: number; y: number; width: number; height: number } | null, dna: ScreenDna = COMMON_SHORTS_SCREEN_DNA): { x: number; y: number; width: number; height: number } {
  const b = crop ?? { x: 0, y: 0, width: srcW, height: srcH }
  const target = dna.center.w / dna.center.h
  if (b.width / b.height > target) { const w = Math.round(b.height * target); return { x: b.x + Math.floor((b.width - w) / 2), y: b.y, width: w, height: b.height } }
  const h = Math.round(b.width / target); return { x: b.x, y: b.y + Math.floor((b.height - h) / 2), width: b.width, height: h }
}
