import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSourceFile } from '../../lib/media/analyze.js'
import { putAddressed, sha256 } from '../../lib/jobs/blobs.js'
import { canonicalize } from '../../lib/tracker-core/renderManifest.js'
import { StageError, type StageExecutor } from '../types.js'

// ANALYZE: measure the registered source (scenes, per-second activity/audio, dead ranges, highlight windows).
// Output is a machine-readable source-analysis/1 blob, content-addressed; nothing is "described" in prose.
export const analyzeExecutor: StageExecutor = {
  stage: 'ANALYZE',
  estimateUsd: () => 0,
  inputHash: (job) => sha256(`analyze|${job.sourceAssetId}`),
  async run({ job, blobs, resolveSourceAsset, resolveSourceFile, signal }) {
    let asset
    try { asset = await resolveSourceAsset(job.sourceAssetId) }
    catch (e: any) { throw new StageError(e?.code === 'SOURCE_ASSET_NOT_FOUND' ? 'SOURCE_ASSET_NOT_FOUND' : 'SOURCE_LOOKUP_FAILED', String(e?.message || e), e?.code !== 'SOURCE_ASSET_NOT_FOUND') }
    const file = await resolveSourceFile(asset)
    const work = await mkdtemp(join(tmpdir(), 'tracker-analyze-'))
    try {
      if (signal.aborted) throw new Error('aborted')
      const sheetPath = join(work, 'contact.jpg')
      let analysis
      try { analysis = await analyzeSourceFile(file.path, { sourceAssetId: asset.sourceAssetId, sha256: asset.sha256 ?? null, contactSheetOut: sheetPath }, { contactSheet: true }) }
      catch (e: any) { throw new StageError('SOURCE_UNDECODABLE', String(e?.message || e)) }
      if (!analysis.usable.length) throw new StageError('SOURCE_NOT_USABLE', 'no usable (non-black) range in the source')
      let contactSheetRef: string | null = null
      try { const bytes = await readFile(sheetPath); contactSheetRef = (await blobs.putBytes(`analysis/contact/${sha256(bytes)}.jpg`, bytes, 'image/jpeg')).path } catch { /* optional artifact */ }
      const stored = await putAddressed(blobs, 'analysis', analysis)
      return {
        outputRef: stored.path, outputHash: sha256(canonicalize(analysis)),
        result: { analysisRef: stored.path, contactSheetRef, summary: { duration: analysis.media.duration, scenes: analysis.scenes.length, highlights: analysis.highlights.length, usableSeconds: analysis.usable.reduce((s, r) => s + r.end - r.start, 0), hasAudio: analysis.media.hasAudio } },
        provider: 'ffmpeg', model: `${analysis.analyzer.name}@${analysis.analyzer.version}`
      }
    } finally { await rm(work, { recursive: true, force: true }); await file.cleanup() }
  }
}
