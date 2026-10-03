import { putAddressed, sha256 } from '../../lib/jobs/blobs.js'
import { StageError, type StageExecutor } from '../types.js'

// DECISION: nothing to compute — the job parks until the user (or an explicit API call) picks a variant.
export const decisionExecutor: StageExecutor = {
  stage: 'DECISION', estimateUsd: () => 0, inputHash: (job) => sha256(`decision|${job.id}|${job.planRev}`),
  async run({ previous }) {
    const qc = await previous('AUTO_QC')
    return { result: { awaiting: 'variant choice', recommendedVariantId: (qc?.result as any)?.recommendedVariantId ?? null }, wait: 'DECISION' }
  }
}

async function approvedVariant(job: any, previous: (s: any) => Promise<any>) {
  if (!job.approvedManifestHash) throw new StageError('NOT_APPROVED', 'no approved manifestHash')
  const qc = await previous('AUTO_QC')
  const v = ((qc?.result as any)?.variants || []).find((x: any) => x.manifestHash === job.approvedManifestHash)
  if (!v) throw new StageError('APPROVED_VARIANT_MISSING', 'approved manifest has no rendered variant')
  return v
}

// FINAL: the chosen render is promoted as-is (same Blob path, same bytes). Nothing is re-rendered.
export const finalExecutor: StageExecutor = {
  stage: 'FINAL', estimateUsd: () => 0, inputHash: (job) => sha256(`final|${job.id}|${job.approvedManifestHash}`),
  async run({ job, blobs, previous }) {
    const v = await approvedVariant(job, previous)
    const bytes = await blobs.getBytes(v.renderRef)
    if (!bytes) throw new StageError('FINAL_RENDER_MISSING', `render blob not found: ${v.renderRef}`, true)
    if (sha256(bytes) !== v.renderHash) throw new StageError('FINAL_RENDER_ALTERED', 'render bytes no longer match renderHash')
    return { outputRef: v.renderRef, outputHash: v.renderHash, result: { finalRenderRef: v.renderRef, renderHash: v.renderHash, manifestHash: v.manifestHash, bytes: bytes.length, promoted: 'same-blob' } }
  }
}

// PACKAGE: the durable record of what was made and why it may be published. Later: title/description/tags/pinned comment.
export const packageExecutor: StageExecutor = {
  stage: 'PACKAGE', estimateUsd: () => 0, inputHash: (job) => sha256(`package|${job.id}|${job.approvedManifestHash}`),
  async run({ job, blobs, previous }) {
    const v = await approvedVariant(job, previous)
    const fin = await previous('FINAL')
    if (!fin?.outputRef) throw new StageError('FINAL_MISSING', 'PACKAGE requires FINAL')
    const decision = await previous('DECISION')
    const pkg = {
      schema: 'shorts-package/1',
      finalRenderRef: fin.outputRef, renderHash: v.renderHash, manifestHash: v.manifestHash, sourceAssetId: job.sourceAssetId,
      durationSec: v.duration, variant: { id: v.variantId, label: v.label },
      qc: { decision: v.gate.decision, counts: v.gate.counts, checks: v.gate.checks.map((c: any) => ({ id: c.id, required: c.required, status: c.status })) },
      contentQc: v.contentGate ? { decision: v.contentGate.decision, reasons: v.contentGate.reasons, checks: v.contentGate.checks.map((c: any) => ({ id: c.id, required: c.required, status: c.status })) } : { decision: 'BLOCK', reasons: ['UNKNOWN: content gate not recorded'], checks: [] },
      referenceQc: v.referenceGate ? { decision: v.referenceGate.decision, checks: v.referenceGate.checks.map((c: any) => ({ featureId: c.featureId, axis: c.axis, status: c.status, evidence: c.evidence })) } : null,
      // true only if every mandatory gate (technical, content, and Reference when present) passed; an approved-but-not-publishable video stays flagged
      publishable: v.publishable === true,
      override: (decision?.result as any)?.override ?? null,
      metadata: (() => {
        const planResult:any = (decision?.result as any) || {}
        return { title: null, description: null, tags: [], pinnedComment: null, planResult }
      })()
    }
    const stored = await putAddressed(blobs, 'packages', pkg)
    return { outputRef: stored.path, outputHash: sha256(stored.path), result: { packageRef: stored.path, finalRenderRef: fin.outputRef, renderHash: v.renderHash, manifestHash: v.manifestHash, durationSec: v.duration, publishable: v.publishable === true } }
  }
}
