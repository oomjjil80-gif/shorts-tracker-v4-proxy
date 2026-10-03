// Test fixtures for Screen DNA QC: sources are built with the real ASSET segment argv, renders with the real renderPayload.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runOk, probe } from '../lib/media/ffmpeg.js'
import { screenDnaSegmentArgv, screenDnaSegmentFilter } from '../lib/media/screenDna.js'
import { compileJobPlan } from '../lib/tracker-core/jobCompile.js'
import { renderPayload, extractRenderPlan } from '../lib/media/render.js'
import { assFromPayload } from '../lib/media/ass.js'

export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
export const dir = () => mkdtempSync(join(tmpdir(), 'dna-fx-'))

// bright: textured test pattern; dark: same pattern crushed to near-black; marks: bright with black object + dark lines
export async function image(kind: 'bright' | 'dark' | 'marks' | 'darkBottom', d: string, seed = 0): Promise<string> {
  const vf = {
    bright: '', dark: ',eq=brightness=-0.62:contrast=0.35', marks: ',drawbox=x=300:y=600:w=420:h=300:color=black:t=fill,drawbox=x=0:y=1100:w=1024:h=6:color=black:t=fill,drawbox=x=0:y=200:w=1024:h=3:color=black:t=fill',
    darkBottom: ',drawbox=x=0:y=700:w=1024:h=836:color=0x050505:t=fill'
  }[kind]
  const p = join(d, `${kind}${seed}.jpg`)
  await runOk(['-y', '-f', 'lavfi', '-i', `testsrc2=s=1024x1536:r=1,hue=h=${seed * 40}`, '-frames:v', '1', '-vf', `format=yuv420p${vf}`, '-q:v', '3', p])
  return p
}

export async function audio(d: string, sec: number): Promise<string> {
  const p = join(d, `a${sec}.mp3`)
  await runOk(['-y', '-f', 'lavfi', '-i', `sine=f=330:d=${sec}`, '-c:a', 'libmp3lame', '-f', 'mp3', p])
  return p
}

// ASSET exactly: per-beat segment argv (optionally with a tampered filter) + concat copy
export async function source(d: string, images: string[], durationSec: number, vf = screenDnaSegmentFilter()): Promise<{ path: string; sha256: string; items: any[]; argv: string[] }> {
  const a = await audio(d, durationSec)
  const segs: string[] = []; let argv: string[] = []
  for (const [i, img] of images.entries()) {
    const op = join(d, `s${i}.mp4`)
    const args = screenDnaSegmentArgv(img, a, durationSec, op, vf); if (!i) argv = args
    await runOk(args, { timeoutMs: 120_000 }); segs.push(op)
  }
  const list = join(d, 'concat.txt'); writeFileSync(list, segs.map((p) => `file '${p}'`).join('\n'))
  const out = join(d, 'source.mp4')
  await runOk(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out])
  const items = images.map((img, i) => { const b = readFileSync(img); return { beatId: `b${i + 1}`, durationSec, image: { ref: img, sha256: sha(b) } } })
  return { path: out, sha256: sha(readFileSync(out)), items, argv }
}

export function payloadFor(src: { sha256: string }, total: number, subtitles: Array<{ start: number; end: number; text: string }>) {
  const plan: any = { schema: 'job-plan/1', profile: 'source_shorts', sourceAssetId: 'src_gen_fx', variantPlan: { profile: 'wisdom-v1', beats: [{ label: 'generated-wisdom', trimStart: 0, trimEnd: total }], headline: '쇼펜하우어가 말하는\\N관계를 줄이는 이유', events: subtitles, plansTimeDomain: 'output', useNarration: false, audioPolicy: { bgm: 'off', sfx: 'off', reason: 'x' } } }
  // the manifest blob COMPILE stores: the compiled manifest plus its source identity
  const c = compileJobPlan({ jobId: 'job_fx', plan, sourceAsset: { sourceAssetId: 'src_gen_fx', blobPath: `source-collector/generated/${src.sha256}.mp4`, sha256: src.sha256, duration: total, width: 1080, height: 1920 } as any })
  return { ...c.manifest, identity: c.identity }
}

// RENDER exactly (renderPayload), or a tampered render of the same source through a custom video filter
export async function render(d: string, src: { path: string }, manifest: any, tamperVf?: string): Promise<{ path: string; sha256: string; filterGraph: string; info: any }> {
  const out = join(d, 'final.mp4')
  const r = await renderPayload(manifest.payload, { sourceFile: src.path, sourceHasAudio: true, workDir: join(d, 'rw'), outPath: out })
  if (tamperVf) {
    const t = join(d, 'tampered.mp4')
    await runOk(['-y', '-i', out, '-vf', tamperVf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'copy', t])
    const b = readFileSync(t)
    return { path: t, sha256: sha(b), filterGraph: r.filterGraph, info: await probe(t) }
  }
  return { path: out, sha256: sha(readFileSync(out)), filterGraph: r.filterGraph, info: await probe(out) }
}

export function qcInput(o: { src: Awaited<ReturnType<typeof source>>; out: Awaited<ReturnType<typeof render>>; manifest: any; assetReceipt?: any; renderReceipt?: any; jobId?: string; overlays?: any }) {
  const total = extractRenderPlan(o.manifest.payload).total
  return {
    input: {
      job: { id: o.jobId ?? 'job_fx' }, sourceFile: o.src.path, sourceSha256: o.src.sha256,
      renderPath: o.out.path, renderBytesSha256: o.out.sha256, output: { width: o.out.info.width, height: o.out.info.height },
      variant: { manifestHash: o.manifest.manifestHash, renderHash: o.out.sha256, geometryReceipt: o.renderReceipt ?? null },
      manifest: o.manifest, renderRun: { attempt: 1 }, assetRun: { attempt: 1, result: { source: { sha256: o.src.sha256 }, ...(o.assetReceipt ? { geometryReceipt: o.assetReceipt } : {}) } },
      assetManifest: { items: o.src.items }, getBytes: async (ref: string) => { try { return readFileSync(ref) } catch { return null } },
      overlays: o.overlays ?? assFromPayload({ ...o.manifest.payload, totalDuration: total })
    } as any,
    cuts: extractRenderPlan(o.manifest.payload).cuts
  }
}

// ---- General / source-first fixtures: a raw (non-composed) source placed into the window by RENDER ----
export async function generalSource(d: string, kind: 'bright' | 'dark' = 'bright', size = '1280x720', sec = 2.4): Promise<{ path: string; sha256: string }> {
  const p = join(d, `raw-${kind}.mp4`)
  const vf = kind === 'dark' ? ',eq=brightness=-0.62:contrast=0.35' : ''
  await runOk(['-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=30:d=${sec}`, '-f', 'lavfi', '-i', `sine=f=440:d=${sec}`, '-vf', `format=yuv420p${vf}`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p], { timeoutMs: 120_000 })
  return { path: p, sha256: sha(readFileSync(p)) }
}
export function generalManifest(src: { sha256: string }, sec = 2.4, size = '1280x720') {
  const [width, height] = size.split('x').map(Number)
  const plan: any = { schema: 'job-plan/1', profile: 'source_shorts', sourceAssetId: 'src_raw_fx', variantPlan: { profile: 'v1', beats: [{ label: 'a', trimStart: 0, trimEnd: sec }], headline: '왜 이렇게 될까\\N끝까지 보면 안다', events: [{ start: 0, end: 1.2, text: '처음 장면입니다' }, { start: 1.2, end: sec, text: '결국 이렇게 됩니다' }], plansTimeDomain: 'source' } }
  const c = compileJobPlan({ jobId: 'job_gen', plan, sourceAsset: { sourceAssetId: 'src_raw_fx', blobPath: `source-collector/${src.sha256}.mp4`, sha256: src.sha256, duration: sec, width, height } as any })
  return { ...c.manifest, identity: c.identity }
}
// RENDER exactly (renderPayload, optionally executing a non-contract geometry), optional post-render tamper of the pixels
export async function generalRender(d: string, src: { path: string }, manifest: any, o: { dna?: any; tamperVf?: string } = {}) {
  const out = join(d, 'gen-final.mp4')
  const r = await renderPayload(manifest.payload, { sourceFile: src.path, sourceHasAudio: true, workDir: join(d, 'gw'), outPath: out, dna: o.dna })
  let path = out
  if (o.tamperVf) {
    path = join(d, 'gen-tampered.mp4')
    await runOk(['-y', '-i', out, '-vf', o.tamperVf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'copy', path])
  }
  return { path, sha256: sha(readFileSync(path)), filterGraph: r.filterGraph, info: await probe(path) }
}
