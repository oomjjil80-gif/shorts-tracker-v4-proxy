import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { putAddressed, sha256 } from '../../lib/jobs/blobs.js'
import { evaluateGate, type CheckResult } from '../../lib/qc/gate.js'
import type { SourceAnalysis } from '../../lib/media/analyze.js'
import { QC_THRESHOLDS, runRenderQc } from '../../lib/media/qc.js'
import { detectSourceFraming, foregroundRect, regionSignature, type SourceFraming } from '../../lib/media/framing.js'
import { extractJpeg, signatureDistance } from '../../lib/media/ffmpeg.js'
import { extractRenderPlan } from '../../lib/media/render.js'
import { StageError, type StageExecutor } from '../types.js'

async function framedTimelineCheck(renderPath: string, sourceFile: string, payload: any, framing: SourceFraming): Promise<CheckResult> {
  const id = 'timeline.segment_order_and_trim'
  try {
    if (framing.mode !== 'embedded' || !framing.crop) return { id, required: true, status: 'UNKNOWN', evidence: { reason: 'embedded framing crop missing' } }
    const plan = extractRenderPlan(payload)
    const outRect = foregroundRect(framing.crop)
    const probeAt = plan.cuts.map((c) => Math.min(0.5, c.duration / 2))
    const outSig: Buffer[] = [], srcSig: Buffer[] = []
    for (let k = 0; k < plan.cuts.length; k++) {
      outSig.push(await regionSignature(renderPath, plan.cuts[k].start + probeAt[k], outRect))
      srcSig.push(await regionSignature(sourceFile, plan.cuts[k].trimStart + probeAt[k], framing.crop))
    }
    const rows = outSig.map((o, k) => {
      const d = srcSig.map((s) => signatureDistance(o, s))
      const bestOther = Math.min(...d.filter((_, j) => j !== k), Infinity)
      const same = d[k]
      const ok = same <= QC_THRESHOLDS.frameMatchMaxDist && !(bestOther + QC_THRESHOLDS.frameMismatchMargin < same)
      return { cut: k + 1, dist: Number(same.toFixed(1)), bestOther: Number.isFinite(bestOther) ? Number(bestOther.toFixed(1)) : null, ok }
    })
    return { id, required: true, status: rows.every((r) => r.ok) ? 'PASS' : 'FAIL', evidence: { framing, outputForeground: outRect, rows } }
  } catch (e: any) {
    return { id, required: true, status: 'UNKNOWN', evidence: { error: String(e?.message || e) } }
  }
}

// AUTO_QC: measures every rendered file (not the plan): format, full decode, duration, black/freeze, first/last frame,
// audio, segment order/trim (frame matching against the source), overlay count/visibility/safe-area and frame utilization.
// The job advances to DECISION only if at least one variant passes EVERY required check; otherwise QC_BLOCKED.
export const autoQcExecutor: StageExecutor = {
  stage: 'AUTO_QC',
  estimateUsd: () => 0,
  inputHash: (job) => sha256(`auto-qc|${job.id}|${job.planRev}`),
  async run({ job, blobs, previous, resolveSourceAsset, resolveSourceFile, signal }) {
    const render = await previous('RENDER')
    const rendered = ((render?.result as any)?.variants || []) as any[]
    if (!rendered.length) throw new StageError('RENDER_MISSING', 'AUTO_QC requires a completed RENDER stage')
    const analysisRun = await previous('ANALYZE')
    const analysis = analysisRun?.outputRef ? await blobs.getJson<SourceAnalysis>(analysisRun.outputRef) : null
    if (!analysis) throw new StageError('ANALYSIS_MISSING', 'AUTO_QC needs the source analysis (expected freeze/silence ranges)')

    const asset = await resolveSourceAsset(job.sourceAssetId)
    const file = await resolveSourceFile(asset)
    const work = await mkdtemp(join(tmpdir(), 'tracker-qc-'))
    try {
      const results: any[] = []
      for (const v of rendered) {
        if (signal.aborted) throw new Error('aborted')
        const manifest: any = await blobs.getJson(v.manifestRef)
        const bytes = await blobs.getBytes(v.renderRef)
        // a missing/altered artifact is a FAIL of the whole variant, never a skipped check
        const dir = join(work, v.variantId)
        let gate, contactSheetRef: string | null = null, posterRef: string | null = null
        if (!manifest || !bytes) {
          gate = { decision: 'BLOCK', reasons: ['UNKNOWN: artifact.available'], counts: { pass: 0, fail: 0, unknown: 1, requiredPass: 0, requiredTotal: 1 }, checks: [{ id: 'artifact.available', required: true, status: 'UNKNOWN', evidence: { manifest: !!manifest, render: !!bytes } }] }
        } else {
          const renderPath = join(work, `${v.variantId}.mp4`)
          await writeFile(renderPath, bytes)
          const sheetPath = join(work, `${v.variantId}.jpg`)
          const qc = await runRenderQc({ renderPath, expectedRenderHash: v.renderHash, payload: manifest.payload, sourceFile: file.path, analysis, render: { overlayEvents: v.overlayEvents || [], assSha256: v.assSha256 ?? null }, workDir: dir, contactSheetOut: sheetPath })

          // The generic order/trim check compares the full 9:16 frame. When a padded source was smart-framed, compare
          // the preserved foreground picture against the detected source crop instead, so blur-fill does not look like
          // a content mismatch while a genuinely wrong cut/order still fails.
          let checks = [...qc.gate.checks]
          const sourceFraming = v.sourceFraming as SourceFraming | undefined
          if (sourceFraming?.mode === 'embedded' && sourceFraming.crop) {
            checks = checks.filter((c) => c.id !== 'timeline.segment_order_and_trim')
            checks.push(await framedTimelineCheck(renderPath, file.path, manifest.payload, sourceFraming))
          }

          // Temporal blackdetect cannot see letterboxing because the picture itself is not a black *frame*.
          // Re-run the framing detector on the final MP4: a publishable Short must use the full 9:16 canvas.
          try {
            const outputFraming = await detectSourceFraming(renderPath)
            checks.push({ id: 'visual.frame_utilization', required: true, status: outputFraming.mode === 'full' ? 'PASS' : 'FAIL', evidence: outputFraming })
          } catch (e: any) {
            checks.push({ id: 'visual.frame_utilization', required: true, status: 'UNKNOWN', evidence: { error: String(e?.message || e) } })
          }
          gate = evaluateGate(checks)

          try {
            const posterPath = join(work, `${v.variantId}-poster.jpg`)
            await extractJpeg(renderPath, Math.min(1, (v.duration ?? 2) / 2), posterPath, 'scale=540:-2')
            const poster = await readFile(posterPath); posterRef = (await blobs.putBytes(`renders/${sha256(poster)}.jpg`, poster, 'image/jpeg')).path
          } catch { /* optional */ }
          try { const sheet = await readFile(sheetPath); contactSheetRef = (await blobs.putBytes(`renders/${sha256(sheet)}.jpg`, sheet, 'image/jpeg')).path } catch { /* optional */ }
        }
        await putAddressed(blobs, `qc/render/${v.renderHash}`, gate)
        results.push({ variantId: v.variantId, label: v.label, manifestHash: v.manifestHash, renderRef: v.renderRef, renderHash: v.renderHash, duration: v.duration, contactSheetRef, posterRef, gate })
      }
      const passing = results.filter((r) => r.gate.decision === 'PASS')
      return {
        outputRef: (passing[0] ?? results[0]).renderRef, outputHash: (passing[0] ?? results[0]).renderHash,
        result: { variants: results, recommendedVariantId: passing[0]?.variantId ?? null, passing: passing.length },
        wait: passing.length ? undefined : 'QC_BLOCKED'
      }
    } finally { await rm(work, { recursive: true, force: true }); await file.cleanup() }
  }
}
