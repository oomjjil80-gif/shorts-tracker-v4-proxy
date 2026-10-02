import { runGate, runCheck, type CheckResult, type GateResult } from '../../lib/qc/gate.js'
import { putAddressed } from '../../lib/jobs/blobs.js'
import { sha256 } from '../../lib/jobs/blobs.js'
import { compileJobPlan } from '../../lib/tracker-core/jobCompile.js'
import { StageError, type SourceAssetLike, type StageContext, type StageExecutor } from '../types.js'

const MAX_SHORTS_SECONDS = 180

type CompiledVariant = { variantId: string; label: string; planRef: string; manifestHash: string; manifestRef: string; identity: any[]; gate: GateResult; totalDuration: number }

async function compileOne(ctx: Pick<StageContext, 'job' | 'blobs'>, sourceAsset: SourceAssetLike, planRef: string, variantId: string, label: string): Promise<CompiledVariant> {
  const { job, blobs } = ctx
  const plan: any = await blobs.getJson(planRef)
  if (!plan) throw new StageError('PLAN_MISSING', `plan blob not found: ${planRef}`)

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
  return { variantId, label, planRef, manifestHash: manifest.manifestHash, manifestRef: stored.path, identity, gate, totalDuration: manifest.payload.totalDuration }
}

// COMPILE: every plan variant -> immutable RenderManifest (Blob, content-addressed) + compile QC gate.
// A P0-style job (client-supplied plan) has one variant; a P1 job compiles every variant PLAN produced.
export const compileExecutor: StageExecutor = {
  stage: 'COMPILE',
  estimateUsd: () => 0,
  inputHash: (job) => sha256(`${job.planRef}|${job.planRev}|${job.sourceAssetId}`),

  async run(ctx) {
    const { job, resolveSourceAsset, previous } = ctx
    if (!job.planRef) throw new StageError('PLAN_MISSING', 'job has no plan revision to compile')

    let sourceAsset
    try { sourceAsset = await resolveSourceAsset(job.sourceAssetId) }
    catch (e: any) {
      if (e?.code === 'SOURCE_ASSET_NOT_FOUND') throw new StageError('SOURCE_ASSET_NOT_FOUND', String(e.message))
      throw new StageError('SOURCE_LOOKUP_FAILED', String(e?.message || e), true)
    }

    // Variants come from PLAN only while that PLAN output is still the job's current plan (a revision resets this).
    const planRun = await previous('PLAN')
    const assetRun = job.profile === 'wisdom' ? await previous('ASSET') : null
    const timedPlanRef = (assetRun?.result as any)?.timedPlanRef as string | undefined
    const planned = (planRun?.result as any)?.variants as Array<{ variantId: string; label: string; planRef: string }> | undefined
    const useVariants = !!planned?.length && planRun?.outputRef === job.planRef
    const list = timedPlanRef ? [{ variantId: 'v1', label: '추천', planRef: timedPlanRef }] : useVariants ? planned! : [{ variantId: 'v1', label: '추천', planRef: job.planRef }]

    const variants: CompiledVariant[] = []
    for (const v of list) variants.push(await compileOne(ctx, sourceAsset, v.planRef, v.variantId, v.label))

    const passing = variants.filter((v) => v.gate.decision === 'PASS')
    const lead = passing[0] ?? variants[0]
    return {
      outputRef: lead.manifestRef,
      outputHash: lead.manifestHash,
      result: { manifestHash: lead.manifestHash, identity: lead.identity, gate: lead.gate, totalDuration: lead.totalDuration, variants },
      // blocked only if NO variant can proceed
      wait: passing.length ? undefined : 'QC_BLOCKED'
    }
  }
}
