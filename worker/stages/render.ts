import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256 } from '../../lib/jobs/blobs.js'
import { probe } from '../../lib/media/ffmpeg.js'
import { applyCleanEdgeCrop, detectSourceFraming } from '../../lib/media/framing.js'
import { renderPayload, UnsupportedManifestError } from '../../lib/media/render.js'
import { StageError, type StageExecutor } from '../types.js'
import { COMMON_SHORTS_SCREEN_DNA, filterGraphSha256, renderVideoFilters, type RenderGeometryReceipt } from '../../lib/media/screenDna.js'

type CompiledForRender = { variantId: string; label: string; manifestHash: string; manifestRef: string; gate: { decision: string }; identity: any[] }

// P0 production jobs that were already parked at RENDER before P1 was deployed have the old single-manifest
// COMPILE result shape (outputRef/outputHash + result.gate), while P1 COMPILE stores result.variants[]. Keep those
// durable jobs renderable instead of forcing a recompile or silently abandoning them.
export function compiledVariantsFromRun(compile: any): CompiledForRender[] {
  const variants = compile?.result?.variants
  if (Array.isArray(variants) && variants.length) return variants as CompiledForRender[]
  if (compile?.outputRef && compile?.outputHash && compile?.result?.gate) {
    return [{
      variantId: 'v1', label: '추천', manifestHash: String(compile.outputHash), manifestRef: String(compile.outputRef),
      gate: compile.result.gate, identity: Array.isArray(compile.result.identity) ? compile.result.identity : []
    }]
  }
  return []
}

// RENDER: each compile-PASS variant is rendered ONCE at final quality (1080x1920 H.264/AAC MP4, faststart) straight
// from its immutable RenderManifest + the Registry-verified source file. Choosing a variant later promotes that same file.
export const renderExecutor: StageExecutor = {
  stage: 'RENDER',
  estimateUsd: () => 0,
  inputHash: (job) => sha256(`render|v2|${job.id}|${job.planRev}`),
  async run({ job, attempt, blobs, previous, resolveSourceAsset, resolveSourceFile, signal }) {
    const compile = await previous('COMPILE')
    const assetRun = await previous('ASSET')
    const voiceoverRef = (assetRun?.result as any)?.voiceover === true ? String((assetRun?.result as any)?.voiceoverRef || '') : ''
    const sourceMixVolume = Number((assetRun?.result as any)?.sourceVolume)
    const voiceMixVolume = Number((assetRun?.result as any)?.voiceVolume)
    const compiled = compiledVariantsFromRun(compile)
    if (!compiled.length) throw new StageError('COMPILE_MISSING', 'RENDER requires a completed COMPILE stage')
    const todo = compiled.filter((v) => v.gate?.decision === 'PASS')
    if (!todo.length) throw new StageError('NO_RENDERABLE_VARIANT', 'no variant passed the compile gate')

    const asset = await resolveSourceAsset(job.sourceAssetId)
    const file = await resolveSourceFile(asset)
    const work = await mkdtemp(join(tmpdir(), 'tracker-render-'))
    try {
      let voiceoverFile: string | null = null
      if (voiceoverRef) {
        if (!voiceoverRef.startsWith('source-shorts-assets/audio/')) throw new StageError('VOICEOVER_REF_INVALID', 'source Shorts voiceover ref is invalid')
        const voiceBytes = await blobs.getBytes(voiceoverRef)
        if (!voiceBytes) throw new StageError('VOICEOVER_MISSING', 'source Shorts voiceover bytes are missing')
        voiceoverFile = join(work, 'voiceover.mp3')
        await writeFile(voiceoverFile, voiceBytes)
      }
      const info = await probe(file.path)
      if (!(Number(info.width) > 0 && Number(info.height) > 0)) throw new StageError('SOURCE_UNDECODABLE', 'source dimensions are missing')
      const sourceSize = { width: Number(info.width), height: Number(info.height) }
      // Deterministic source normalization: if a nominally vertical upload contains the real picture inside persistent
      // black title/padding bands, remove those bands and use a blurred 9:16 fill. It is derived only from verified bytes.
      const baseFraming = await detectSourceFraming(file.path)
      const out: any[] = []
      for (const v of todo) {
        if (signal.aborted) throw new Error('aborted')
        const manifest: any = await blobs.getJson(v.manifestRef)
        if (!manifest || manifest.manifestHash !== v.manifestHash) throw new StageError('MANIFEST_MISSING', `manifest blob not found or altered: ${v.manifestRef}`)
        const sourceFraming = applyCleanEdgeCrop(baseFraming, sourceSize, manifest.payload?.sourceCleanEdgeCrop)
        for (const id of manifest.identity || []) if (id.sha256 && asset.sha256 && id.sha256 !== asset.sha256) throw new StageError('SOURCE_IDENTITY_MISMATCH', 'manifest source sha256 differs from the registry')
        const dir = join(work, v.variantId)
        const outPath = join(dir, 'final.mp4')
        let r
        try { r = await renderPayload(manifest.payload, { sourceFile: file.path, sourceHasAudio: info.hasAudio, workDir: dir, outPath, signal, sourceFraming, voiceoverFile, sourceMixVolume, voiceMixVolume }) }
        catch (e: any) { throw e instanceof UnsupportedManifestError ? new StageError('MANIFEST_UNSUPPORTED', e.message) : e }
        const bytes = await readFile(outPath)
        const renderHash = sha256(bytes)
        const stored = await blobs.putBytes(`renders/${renderHash}.mp4`, bytes, 'video/mp4')
        const rInfo = await probe(outPath)
        // Screen DNA execution receipt: the exact graph this attempt ran, bound to its manifest, source and output bytes.
        // composer: who executed the Common Screen DNA geometry — ASSET (pre-composed source) or this RENDER (raw source).
        const geometryReceipt: RenderGeometryReceipt = { schema: 'screen-dna-receipt/1', stage: 'RENDER', jobId: job.id, attempt, contract: COMMON_SHORTS_SCREEN_DNA, composer: manifest.payload?.editorialPlan?.profile === 'wisdom-v1' ? 'asset' : 'render', manifestHash: v.manifestHash, sourceSha256: String(asset.sha256 ?? ''), sourceWidth: info.width, sourceHeight: info.height, filterGraphSha256: filterGraphSha256(r.filterGraph), videoFilters: renderVideoFilters(r.filterGraph), renderHash }
        out.push({ variantId: v.variantId, label: v.label, manifestHash: v.manifestHash, manifestRef: v.manifestRef, renderRef: stored.path, renderHash, bytes: bytes.length, duration: rInfo.duration, overlayEvents: r.overlayEvents, assSha256: r.assPath ? sha256(r.ass) : null, sourceFraming, geometryReceipt, voiceover: voiceoverFile ? { ref: voiceoverRef, sourceVolume: Number.isFinite(sourceMixVolume) ? sourceMixVolume : 0.24, voiceVolume: Number.isFinite(voiceMixVolume) ? voiceMixVolume : 1 } : null })
      }
      return { outputRef: out[0].renderRef, outputHash: out[0].renderHash, result: { variants: out, sourceFraming: out[0]?.sourceFraming ?? baseFraming }, provider: 'ffmpeg', model: 'libx264+libass' }
    } finally { await rm(work, { recursive: true, force: true }); await file.cleanup() }
  }
}
