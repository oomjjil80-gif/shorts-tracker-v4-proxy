// Final-quality render of a RenderManifest with ffmpeg (+ libass overlays). Reads ONLY the manifest payload and the
// source file resolved from the Source Registry — never Episode/UI state and never a signed URL.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assFromPayload, FONTS_DIR, type OverlayEvent } from './ass.js'
import { runOk } from './ffmpeg.js'
import type { SourceFraming } from './framing.js'

export const OUTPUT = { width: 1080, height: 1920, fps: 30 } as const
// Container hosts can expose dozens of CPUs while the Railway service has a much smaller memory/process budget.
// Letting libx264 auto-detect the host produced 60 encoder threads in Production. Bound it explicitly so a 1080x1920
// Shorts render has predictable memory/thread usage. This is an encoder setting only; output quality stays CRF-driven.
export const VIDEO_ENCODER_THREADS = 4

export class UnsupportedManifestError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedManifestError' }
}

export type RenderPlanCut = { start: number; duration: number; trimStart: number; trimEnd: number; volume: number; mute: boolean }

// The P1 renderer supports exactly what source-first Shorts need. Anything else is refused loudly (never approximated).
export function extractRenderPlan(payload: any): { cuts: RenderPlanCut[]; total: number } {
  const rs = payload?.renderSettings
  if (!rs || rs.width !== OUTPUT.width || rs.height !== OUTPUT.height) throw new UnsupportedManifestError(`only ${OUTPUT.width}x${OUTPUT.height} is supported (got ${rs?.width}x${rs?.height})`)
  if (payload.bgm) throw new UnsupportedManifestError('BGM is not supported by the P1 renderer')
  if (payload.audioMode && payload.audioMode !== 'none') throw new UnsupportedManifestError(`audioMode ${payload.audioMode} is not supported`)
  const cuts = (payload.cuts || []) as any[]
  if (!cuts.length) throw new UnsupportedManifestError('manifest has no cuts')
  let clock = 0
  const plan = cuts.map((c, i) => {
    if (c.mediaType !== 'source_video' || !c.sourceVideo) throw new UnsupportedManifestError(`cut ${i + 1}: mediaType ${c.mediaType} is not supported`)
    const s = Number(c.sourceVideo.trimStart), e = Number(c.sourceVideo.trimEnd)
    if (!(e > s)) throw new UnsupportedManifestError(`cut ${i + 1}: invalid trim`)
    if (c.transitionOut && c.transitionOut.type && c.transitionOut.type !== 'HARD_CUT' && Number(c.transitionOut.duration) > 0) throw new UnsupportedManifestError(`cut ${i + 1}: transition ${c.transitionOut.type} is not supported`)
    if (c.sourceVideo.speed && Number(c.sourceVideo.speed) !== 1) throw new UnsupportedManifestError(`cut ${i + 1}: speed change is not supported`)
    const duration = e - s
    if (Math.abs(Number(c.start) - clock) > 0.02 || Math.abs(Number(c.duration) - duration) > 0.02) throw new UnsupportedManifestError(`cut ${i + 1}: manifest timing is not contiguous with its trim`)
    const cut = { start: clock, duration, trimStart: s, trimEnd: e, volume: c.sourceVideo.volume ?? 1, mute: c.sourceVideo.mute === true }
    clock += duration
    return cut
  })
  return { cuts: plan, total: clock }
}

const escFilterPath = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")

export function buildFilterGraph(cuts: RenderPlanCut[], o: { sourceHasAudio: boolean; assPath: string; fontsDir: string; hasOverlays: boolean; sourceFraming?: SourceFraming; wisdomLayout?: boolean }): string {
  const parts: string[] = []
  const embedded = o.sourceFraming?.mode === 'embedded' ? o.sourceFraming.crop : null
  cuts.forEach((c, i) => {
    if (o.wisdomLayout) {
      // Wisdom Screen DNA: immutable black 360px headline band + 1200px visual window + black 360px subtitle band.
      // The generated source already carries this geometry; preserve it exactly. Never run the generic embedded-framing blur/scale path.
      parts.push(`[${i}:v]setpts=PTS-STARTPTS,scale=${OUTPUT.width}:${OUTPUT.height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${OUTPUT.width}:${OUTPUT.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${OUTPUT.fps},format=yuv420p[v${i}]`)
    } else if (embedded) {
      // Many reposted vertical files are actually a landscape/4:3 picture embedded between black title/padding bands.
      // Crop to the real picture, preserve the full foreground, and fill 9:16 with a darkened blurred duplicate.
      // This removes baked-in title bands without stretching or amputating the CCTV/story frame.
      parts.push(`[${i}:v]setpts=PTS-STARTPTS,crop=${embedded.width}:${embedded.height}:${embedded.x}:${embedded.y},split=2[bgsrc${i}][fgsrc${i}]`)
      parts.push(`[bgsrc${i}]scale=${OUTPUT.width}:${OUTPUT.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OUTPUT.width}:${OUTPUT.height},gblur=sigma=30:steps=2,eq=brightness=-0.10:saturation=0.75[bg${i}]`)
      parts.push(`[fgsrc${i}]scale=${OUTPUT.width}:${OUTPUT.height}:force_original_aspect_ratio=decrease:flags=lanczos[fg${i}]`)
      parts.push(`[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${OUTPUT.fps},format=yuv420p[v${i}]`)
    } else {
      parts.push(`[${i}:v]setpts=PTS-STARTPTS,scale=${OUTPUT.width}:${OUTPUT.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OUTPUT.width}:${OUTPUT.height},setsar=1,fps=${OUTPUT.fps},format=yuv420p[v${i}]`)
    }
    const fade = `afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, c.duration - 0.02).toFixed(3)}:d=0.02`
    if (o.sourceHasAudio && !c.mute) parts.push(`[${i}:a]asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${c.volume},${fade}[a${i}]`)
    else parts.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${c.duration.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`)
  })
  parts.push(`${cuts.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${cuts.length}:v=1:a=1[vc][aout]`)
  parts.push(o.hasOverlays ? `[vc]ass=filename='${escFilterPath(o.assPath)}':fontsdir='${escFilterPath(o.fontsDir)}'[vout]` : `[vc]null[vout]`)
  return parts.join(';\n')
}

export type RenderResult = { outPath: string; overlayEvents: OverlayEvent[]; assPath: string | null; ass: string; total: number; cuts: RenderPlanCut[]; sourceHasAudio: boolean; sourceFraming: SourceFraming | null }

export async function renderPayload(payload: any, o: { sourceFile: string; sourceHasAudio: boolean; workDir: string; outPath: string; signal?: AbortSignal; fontsDir?: string; sourceFraming?: SourceFraming }): Promise<RenderResult> {
  const { cuts, total } = extractRenderPlan(payload)
  await mkdir(o.workDir, { recursive: true })
  const built = assFromPayload({ ...payload, totalDuration: total })
  const hasOverlays = built.events.length > 0
  const assPath = join(o.workDir, 'overlay.ass')
  if (hasOverlays) await writeFile(assPath, built.ass, 'utf8')
  const graphPath = join(o.workDir, 'graph.txt')
  await writeFile(graphPath, buildFilterGraph(cuts, { sourceHasAudio: o.sourceHasAudio, assPath, fontsDir: o.fontsDir ?? FONTS_DIR, hasOverlays, sourceFraming: o.sourceFraming, wisdomLayout: payload?.editorialPlan?.profile === 'wisdom-v1' }), 'utf8')

  const args = ['-y']
  for (const c of cuts) args.push('-ss', c.trimStart.toFixed(3), '-t', c.duration.toFixed(3), '-i', o.sourceFile)
  args.push('-filter_complex_script', graphPath, '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-threads:v', String(VIDEO_ENCODER_THREADS), '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '19', '-maxrate', '14M', '-bufsize', '28M', '-r', String(OUTPUT.fps), '-g', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-t', total.toFixed(3), '-movflags', '+faststart', '-map_metadata', '-1', o.outPath)
  await runOk(args, { signal: o.signal, timeoutMs: 15 * 60_000 })
  return { outPath: o.outPath, overlayEvents: built.events, assPath: hasOverlays ? assPath : null, ass: built.ass, total, cuts, sourceHasAudio: o.sourceHasAudio, sourceFraming: o.sourceFraming ?? null }
}
