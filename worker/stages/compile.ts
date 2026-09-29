import { runGate, runCheck, type CheckResult } from '../../lib/qc/gate.js'
import { putAddressed } from '../../lib/jobs/blobs.js'
import { sha256 } from '../../lib/jobs/blobs.js'
import { compileJobPlan } from '../../lib/tracker-core/jobCompile.js'
import { StageError, type StageExecutor } from '../types.js'

const MAX_SHORTS_SECONDS = 180

// COMPILE: JobPlan (Blob) + Source Registry asset -> immutable RenderManifest (Blob, content-addressed),
// then the compile QC gate. The same compileJobPlan() the Tracker frontend ships (tracker-core, checksum-pinned).
export const compileExecutor: StageExecutor = {
  stage: 'COMPILE',
  estimateUsd: () => 0,
  inputHash: (job) => sha256(`${job.planRef}|${job.planRev}|${job.sourceAssetId}`),

  async run({ job, blobs, resolveSourceAsset }) {
    if (!job.planRef) throw new StageError('PLAN_MISSING', 'job has no plan revision to compile')
    const plan: any = await blobs.getJson(job.planRef)
    if (!plan) throw new StageError('PLAN_MISSING', `plan blob not found: ${job.planRef}`)

    let sourceAsset
    try { sourceAsset = await resolveSourceAsset(job.sourceAssetId) }
    catch (e: any) {
      if (e?.code === 'SOURCE_ASSET_NOT_FOUND') throw new StageError('SOURCE_ASSET_NOT_FOUND', String(e.message))
      throw new StageError('SOURCE_LOOKUP_FAILED', String(e?.message || e), true)
    }

    let compiled
    try { compiled = compileJobPlan({ jobId: job.id, plan, sourceAsset }) }
    catch (e: any) { throw new StageError('PLAN_INVALID', String(e?.message || e)) }
    const { manifest, identity } = compiled

    const checks: Array<() => Promise<CheckResult>> = [
      () => runCheck('manifest.compiled', true, () => ({ status: manifest.ok ? 'PASS' : 'FAIL', evidence: manifest.issues })),
      () => runCheck('source.identity_complete', true, () => {
        const missing = identity.filter((i: any) => !i.sourceAssetId || !i.blobPath || !i.sha256)
        return { status: identity.length > 0 && missing.length === 0 ? 'PASS' : 'FAIL', evidence: { identity, missing } }
      }),
      () => runCheck('source.matches_registry', true, () => {
        const bad = identity.filter((i: any) => i.sourceAssetId !== sourceAsset.sourceAssetId || i.blobPath !== sourceAsset.blobPath || (sourceAsset.sha256 && i.sha256 !== sourceAsset.sha256))
        return { status: identity.length > 0 && bad.length === 0 ? 'PASS' : 'FAIL', evidence: { bad } }
      }),
      () => runCheck('timeline.duration', true, () => {
        const d = manifest.payload.totalDuration
        return { status: d > 0 && d <= MAX_SHORTS_SECONDS ? 'PASS' : 'FAIL', evidence: { totalDuration: d, max: MAX_SHORTS_SECONDS } }
      }),
      () => runCheck('plan.events_all_mapped', false, () => {
        const dropped = manifest.issues.filter((i: any) => i.code === 'event-outside-segments')
        return { status: dropped.length === 0 ? 'PASS' : 'FAIL', evidence: dropped }
      })
    ]
    const gate = await runGate(checks)

    const stored = await putAddressed(blobs, 'manifests', { schema: manifest.schema, manifestHash: manifest.manifestHash, compilerVersion: manifest.compilerVersion, identity, payload: manifest.payload })
    // manifestHash (content of the manifest) is the identity; the blob path is only its storage address.
    await putAddressed(blobs, `qc/compile/${manifest.manifestHash}`, gate)

    return {
      outputRef: stored.path,
      outputHash: manifest.manifestHash,
      result: { manifestHash: manifest.manifestHash, identity, gate, totalDuration: manifest.payload.totalDuration },
      wait: gate.decision === 'PASS' ? undefined : 'QC_BLOCKED'
    }
  }
}
