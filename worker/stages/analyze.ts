import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSourceFile } from '../../lib/media/analyze.js'
import { putAddressed, sha256 } from '../../lib/jobs/blobs.js'
import { canonicalize } from '../../lib/tracker-core/renderManifest.js'
import { keyframeSheet } from '../../lib/media/ffmpeg.js'
import { FONTS_DIR } from '../../lib/media/ass.js'
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
      let analysis
      try { analysis = await analyzeSourceFile(file.path, { sourceAssetId: asset.sourceAssetId, sha256: asset.sha256 ?? null }) }
      catch (e: any) { throw new StageError('SOURCE_UNDECODABLE', String(e?.message || e)) }
      if (!analysis.usable.length) throw new StageError('SOURCE_NOT_USABLE', 'no usable (non-black) range in the source')
      // Timestamped keyframe sheet for the semantic story review in PLAN (a story cannot be judged from numbers alone).
      let keyframeSheetRef: string | null = null
      try {
        const kPath = join(work, 'keyframes.jpg')
        await keyframeSheet(file.path, kPath, { duration: analysis.media.duration, fontFile: join(FONTS_DIR, 'NotoSansKR_700Bold.ttf') })
        const bytes = await readFile(kPath); keyframeSheetRef = (await blobs.putBytes(`analysis/keyframes/${sha256(bytes)}.jpg`, bytes, 'image/jpeg')).path
      } catch { /* optional: PLAN then records semantic status 'failed' (no keyframes) */ }
      const stored = await putAddressed(blobs, 'analysis', analysis)
      return {
        outputRef: stored.path, outputHash: sha256(canonicalize(analysis)),
        result: { analysisRef: stored.path, contactSheetRef: null, keyframeSheetRef, summary: { duration: analysis.media.duration, scenes: analysis.scenes.length, highlights: analysis.highlights.length, usableSeconds: analysis.usable.reduce((s, r) => s + r.end - r.start, 0), hasAudio: analysis.media.hasAudio } },
        provider: 'ffmpeg', model: `${analysis.analyzer.name}@${analysis.analyzer.version}`
      }
    } finally { await rm(work, { recursive: true, force: true }); await file.cleanup() }
  }
}
