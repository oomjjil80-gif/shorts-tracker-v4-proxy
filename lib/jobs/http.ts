import type { Request, Response } from 'express'
import { createHash } from 'node:crypto'
import { canonicalize } from '../tracker-core/renderManifest.js'
import { createPgDbFromEnv } from './db.js'
import { createJobStore, type JobStore } from './store.js'
import { createVercelJobBlobStore, putAddressed, type JobBlobStore } from './blobs.js'
import { PIPELINES } from './pipeline.js'
import { isProfileId, getProfile, profileOf } from './profiles.js'
import { JobError, type Job, type StageRun } from './types.js'
import { validateReferenceProfile, stableHash } from '../reference/contracts.js'
import { analyzeRegisteredReference } from '../reference/serverPipeline.js'
import { buildReferenceProductionBrief } from '../reference/profile.js'
import { normalizeGenerativeBrief, generativeBriefHash } from '../generative/contracts.js'
import { normalizeLongformBrief, longformBriefHash } from '../generative/longform.js'
import { yadamRemasterBrief } from '../generative/yasaLongform.js'
import { derivedSourceText, type DerivedShortsDoc } from '../generative/derivedShorts.js'
import { createVoicePreview, PreviewError } from '../generative/voicePreview.js'
import { createTrackerTts, TrackerTtsError } from '../generative/trackerTts.js'
import { creativeContentFor, resolveCreativeProfile, imageStyleFor, visualStyleWrap } from '../generative/creativeProfile.js'
import { openAiTts } from '../generative/providers.js'

// HTTP adapter for Production Jobs. It is NOT a Vercel function: api/story.ts routes taskType job_* here
// (Hobby plan allows 12 functions). CORS is applied by the router. Domain logic stays in store/gate/pipeline.
// Short requests only: validate, write DB rows, return. Rendering / AI never runs inside a Vercel request.
// Workspace = sha256(X-Sync-Key), the same isolation the cloud-sync API uses.

const MAX_PLAN_BYTES = 200_000
const DEFAULT_BUDGET_USD = Number(process.env.JOB_DEFAULT_BUDGET_USD || 5)
const MAX_BUDGET_USD = 50

export type JobsDeps = {
  getStore: () => Promise<JobStore>
  blobs: JobBlobStore
  sourceExists?: (sourceAssetId: string) => Promise<boolean>
  analyzeReference?: typeof analyzeRegisteredReference
  voicePreview?: (input: any) => Promise<{ playbackUrl: string; validUntil: number; cache: 'HIT' | 'MISS' }>
  trackerTts?: { clips: (input: any) => Promise<any>; assemble: (input: any) => Promise<any>; audio?: (ref: string) => Promise<Buffer> }
}

function workspaceOf(req: Request): string {
  const key = String(req.headers['x-sync-key'] || '').trim()
  if (key.length < 24) throw new JobError('UNAUTHORIZED', '유효한 X-Sync-Key가 필요합니다.')
  return createHash('sha256').update(key).digest('hex')
}

export const JOB_TASK_TYPES = ['job_create', 'job_get', 'job_preview', 'job_package', 'job_decision', 'job_cancel', 'job_derived', 'job_retry_render', 'job_remaster_yasa'] as const
export type JobTaskType = (typeof JOB_TASK_TYPES)[number]
// Longform voice preview: a short cached sample of the chosen voice (POST; no database)
export const VOICE_PREVIEW_TASK = 'longform_voice_preview'
// Creative Settings for browser-made content (Story Writer): the server resolves AUTO (POST; no database, no paid call)
export const CREATIVE_RESOLVE_TASK = 'creative_resolve'
// Tracker TTS for browser-made content: voice clips in small batches, then one levelled narration (POST; no database)
export const TTS_CLIPS_TASK = 'tts_clips', TTS_ASSEMBLE_TASK = 'tts_assemble', TTS_AUDIO_TASK = 'tts_audio'
export const isJobTaskType = (t: unknown): boolean => typeof t === 'string' && (t.startsWith('job_') || [VOICE_PREVIEW_TASK, CREATIVE_RESOLVE_TASK, TTS_CLIPS_TASK, TTS_ASSEMBLE_TASK, TTS_AUDIO_TASK].includes(t))

const STATUS_BY_CODE: Record<string, number> = {
  METHOD_NOT_ALLOWED: 405, UNAUTHORIZED: 401, NOT_FOUND: 404, BAD_REQUEST: 400, IDEMPOTENCY_KEY_REUSED: 409, NOT_AWAITING_DECISION: 409, JOB_CLOSED: 409,
  JOB_BUSY: 409, PLAN_REV_CONFLICT: 409, UNKNOWN_MANIFEST: 422, QC_NOT_PASSED: 422, SOURCE_ASSET_NOT_FOUND: 404, JOBS_DB_NOT_CONFIGURED: 503,
  PROVIDER_BILLING: 503, PROVIDER_STOP: 503, PROVIDER_DOWN: 503, PREVIEW_FAILED: 502, TTS_FAILED: 502, NOT_RENDER_RETRYABLE: 409, PREREQUISITE_MISSING: 409
}

const latest = (runs: StageRun[], stage: string) => [...runs].reverse().find((r) => r.stage === stage && r.status === 'SUCCEEDED')
// Wisdom Longform -> derived Shorts: the parent's recommendation (written by its PLAN) and the children made from it
// (parent/child relation kept next to the recommendation; no new table)
const childrenRef = (parentId: string) => `derived-shorts-children/${parentId}.json`
async function derivedOf(store: JobStore, blobs: JobBlobStore, parentId: string, workspaceId: string) {
  const parent = await store.getJob(parentId, workspaceId)
  if (!parent || parent.profile !== 'wisdom_longform') throw new JobError('NOT_FOUND', 'parent Wisdom Longform job not found')
  const plan = latest(await store.listStageRuns(parent.id), 'PLAN'), d: any = (plan?.result as any)?.derived ?? null
  const doc = d?.ref ? ((await blobs.getJson(d.ref)) as DerivedShortsDoc | null) : null
  const children: Array<{ candidateId: string; jobId: string }> = ((await blobs.getJson(childrenRef(parent.id)).catch(() => null)) as any)?.children ?? []
  return { parent, status: !plan ? 'pending' : String(d?.status || 'off'), doc, children }
}
const referenceReasons = (gate: any): string[] => (gate?.checks || []).filter((c: any) => c.status !== 'PASS').map((c: any) => `${c.status}: ${c.featureId}`)

// What the phone needs: one progress line, the variants, and (later) the final file. No logs, no JSON.
function view(job: Job, runs: StageRun[]) {
  const compile = latest(runs, 'COMPILE')
  const qc = latest(runs, 'AUTO_QC')
  const render = latest(runs, 'RENDER')
  const plan = latest(runs, 'PLAN')
  const pkg = latest(runs, 'PACKAGE')
  const rq: any[] = (qc?.result as any)?.variants || []
  const rr: any[] = (render?.result as any)?.variants || []
  const cv: any[] = (compile?.result as any)?.variants || []
  const recommended = (qc?.result as any)?.recommendedVariantId ?? null
  const variants = (rq.length ? rq : rr.length ? rr : cv).map((v) => ({
    id: v.variantId, label: v.label, manifestHash: v.manifestHash, durationSec: v.duration ?? v.totalDuration ?? null,
    rendered: rr.some((x) => x.variantId === v.variantId), qc: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.gate?.decision ?? null) : null,
    qcReasons: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.gate?.reasons ?? []) : [],
    qcChecks: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.gate?.checks ?? []) : [],
    contentQc: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.contentGate?.decision ?? null) : null,
    contentQcReasons: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.contentGate?.reasons ?? []) : [],
    referenceQc: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.referenceGate?.decision ?? null) : null,
    referenceQcReasons: rq.length ? referenceReasons(rq.find((x) => x.variantId === v.variantId)?.referenceGate) : [],
    referenceQcChecks: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.referenceGate?.checks ?? []) : [],
    publishable: rq.length ? rq.find((x) => x.variantId === v.variantId)?.publishable === true : false,
    recommended: v.variantId === recommended, approved: !!job.approvedManifestHash && v.manifestHash === job.approvedManifestHash
  }))
  const lastFail = [...runs].reverse().find((r) => r.status === 'FAILED')
  const stages = (PIPELINES[job.profile] || []).map((stage, i, all) => ({
    stage, state: job.status === 'COMPLETE' || all.indexOf(job.stage) > i ? 'done' : stage === job.stage ? (job.status === 'FAILED' || job.status === 'CANCELLED' ? 'stopped' : job.status === 'WAITING_USER' ? 'waiting' : 'active') : 'pending'
  }))
  return {
    id: job.id, profile: job.profile, sourceAssetId: job.sourceAssetId, status: job.status, stage: job.stage, waitReason: job.waitReason,
    budgetUsd: job.budgetUsd, spentUsd: job.spentUsd, planRev: job.planRev, approvedManifestHash: job.approvedManifestHash,
    cancelRequested: job.cancelRequested, createdAt: job.createdAt, updatedAt: job.updatedAt,
    stages, variants, planner: plan ? { provider: (plan.result as any)?.provider ?? null, semantic: (plan.result as any)?.semantic?.status ?? null, fallback: (plan.result as any)?.fallback ?? null } : null,
    manifest: compile ? { hash: compile.outputHash, ref: compile.outputRef, gate: (compile.result as any)?.gate ?? null } : null,
    final: pkg ? { packageRef: (pkg.result as any)?.packageRef ?? null, renderHash: (pkg.result as any)?.renderHash ?? null, durationSec: (pkg.result as any)?.durationSec ?? null, publishable: (pkg.result as any)?.publishable === true } : null,
    error: job.status === 'FAILED' ? (lastFail?.error as any)?.message ?? 'failed' : null,
    runs: runs.map((r) => ({ stage: r.stage, kind: r.kind, attempt: r.attempt, status: r.status, error: r.error, finishedAt: r.finishedAt }))
  }
}

function matching(value: unknown, re: RegExp, message: string): string {
  const v = String(value ?? '')
  if (!re.test(v)) throw new JobError('BAD_REQUEST', message)
  return v
}

function need<T>(cond: T, message: string): NonNullable<T> {
  if (!cond) throw new JobError('BAD_REQUEST', message)
  return cond as NonNullable<T>
}

export function createJobsHttp(deps: JobsDeps) {
  const voicePreview = deps.voicePreview ?? createVoicePreview({ blobs: deps.blobs, tts: (t, k, p) => openAiTts(t, k, p) })
  const trackerTts = deps.trackerTts ?? createTrackerTts({ blobs: deps.blobs, tts: (t, k, p) => openAiTts(t, k, p) })
  return async function handler(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'private, no-store')
    try {
      const workspaceId = workspaceOf(req)
      const input: any = req.method === 'GET' ? req.query || {} : req.body && typeof req.body === 'object' ? req.body : {}
      let taskType = String(input.taskType || '')
      if (taskType === TTS_CLIPS_TASK || taskType === TTS_ASSEMBLE_TASK) {
        if (req.method !== 'POST') throw new JobError('METHOD_NOT_ALLOWED', `${taskType} requires POST`)
        try { return res.status(200).json({ ok: true, ...(await (taskType === TTS_CLIPS_TASK ? trackerTts.clips(input) : trackerTts.assemble(input))) }) }
        catch (e: any) { if (e instanceof TrackerTtsError) throw new JobError(e.code as any, e.message); throw e }
      }
      // the assembled narration's bytes through the API (same origin rules as every job call; no storage CORS needed)
      if (taskType === TTS_AUDIO_TASK) {
        if (req.method !== 'GET') throw new JobError('METHOD_NOT_ALLOWED', `${taskType} requires GET`)
        try { const bytes = await trackerTts.audio!(String(input.ref || '')); res.setHeader('Content-Type', 'audio/mp4'); res.setHeader('Content-Length', String(bytes.length)); return res.status(200).end(bytes) }
        catch (e: any) { if (e instanceof TrackerTtsError) throw new JobError(e.code as any, e.message); throw e }
      }
      if (taskType === CREATIVE_RESOLVE_TASK) {
        if (req.method !== 'POST') throw new JobError('METHOD_NOT_ALLOWED', `${taskType} requires POST`)
        try {
          const content = creativeContentFor(input.family, input.format)
          const c = resolveCreativeProfile(content, input, String(input.topic || '').slice(0, 2000))
          // styleWrap: the style text for prompts the user copies by hand (null when nothing is added)
          return res.status(200).json({ ok: true, creative: { schema: c.schema, content, family: input.family, format: input.format, requested: c.requested, resolved: c.resolved }, styleWrap: visualStyleWrap(imageStyleFor({ content, requested: c.requested, resolved: c.resolved })) })
        } catch (e: any) { throw new JobError('BAD_REQUEST', String(e?.message || e)) }
      }
      if (taskType === VOICE_PREVIEW_TASK) {
        if (req.method !== 'POST') throw new JobError('METHOD_NOT_ALLOWED', `${taskType} requires POST`)
        try { const r = await voicePreview(input); return res.status(200).json({ ok: true, playbackUrl: r.playbackUrl, validUntil: r.validUntil, cache: r.cache }) }
        catch (e: any) { if (e instanceof PreviewError) throw new JobError(e.code as any, e.message); throw e }
      }
      const expectedMethod = taskType === 'job_get' || taskType === 'job_preview' || taskType === 'job_package' || taskType === 'job_derived' ? 'GET' : 'POST'
      if (!JOB_TASK_TYPES.includes(taskType as JobTaskType)) throw new JobError('BAD_REQUEST', `unknown job taskType: ${taskType || '(none)'}`)
      if (req.method !== expectedMethod) throw new JobError('METHOD_NOT_ALLOWED', `${taskType} requires ${expectedMethod}`)

      // routing/validation errors never need the database
      const store = await deps.getStore()

      if (taskType === 'job_preview') {
        // Short-lived playback URLs for renders that belong to THIS job (paths come from its own stage results, never from the caller).
        const id = need(String(req.query?.id || ''), 'id is required')
        const job = await store.getJob(id, workspaceId)
        if (!job) throw new JobError('NOT_FOUND', 'job not found')
        const runs = await store.listStageRuns(job.id)
        const qc = latest(runs, 'AUTO_QC'), render = latest(runs, 'RENDER')
        const rows: any[] = (qc?.result as any)?.variants || (render?.result as any)?.variants || []
        const recommended = (qc?.result as any)?.recommendedVariantId ?? null
        const previews = []
        for (const v of rows) {
          if (typeof v.renderRef !== 'string' || !v.renderRef.startsWith('renders/')) continue
          const signed = await deps.blobs.presign?.(v.renderRef)
          const sheet = typeof v.posterRef === 'string' && v.posterRef.startsWith('renders/') ? await deps.blobs.presign?.(v.posterRef) : null
          if (!signed) continue
          previews.push({ variantId: v.variantId, label: v.label, durationSec: v.duration ?? null, qc: v.gate?.decision ?? null, qcReasons: v.gate?.reasons ?? [], contentQc: v.contentGate?.decision ?? null, contentQcReasons: v.contentGate?.reasons ?? [], referenceQc: v.referenceGate?.decision ?? null, referenceQcReasons: referenceReasons(v.referenceGate), referenceQcChecks: v.referenceGate?.checks ?? [], publishable: v.publishable === true, recommended: v.variantId === recommended, approved: !!job.approvedManifestHash && v.manifestHash === job.approvedManifestHash, url: signed.url, validUntil: signed.validUntil, posterUrl: sheet?.url ?? null })
        }
        return res.status(200).json({ ok: true, jobId: job.id, status: job.status, stage: job.stage, previews })
      }

      if (taskType === 'job_derived') {
        // the parent's derived Shorts: recommended candidates (none / not yet / off are answers too) and the children made
        const d = await derivedOf(store, deps.blobs, need(String(req.query?.id || ''), 'id is required'), workspaceId)
        const children = []
        for (const c of d.children) { const j = await store.getJob(c.jobId, workspaceId); if (j) children.push({ candidateId: c.candidateId, jobId: j.id, status: j.status, stage: j.stage, shortTitle: d.doc?.candidates.find((x) => x.id === c.candidateId)?.shortTitle ?? '' }) }
        return res.status(200).json({ ok: true, status: d.status, parent: { id: d.parent.id, title: d.doc?.parentLongformTitle ?? null, status: d.parent.status }, candidates: (d.doc?.candidates ?? []).map(({ source, score, ...c }) => c), children })
      }

      if (taskType === 'job_package') {
        const id = need(String(req.query?.id || ''), 'id is required')
        const job = await store.getJob(id, workspaceId)
        if (!job) throw new JobError('NOT_FOUND', 'job not found')
        const runs = await store.listStageRuns(job.id)
        const pkg = latest(runs, 'PACKAGE')
        const plan = latest(runs, 'PLAN')
        if (!pkg?.outputRef) throw new JobError('NOT_FOUND', 'package not found')
        const packageJson:any = await deps.blobs.getJson(pkg.outputRef)
        const scriptRef = (plan?.result as any)?.scriptRef
        const script:any = scriptRef ? await deps.blobs.getJson(scriptRef) : null
        if (profileOf(job.profile)?.packageView === 'longform') {
          // Longform: the server made the 16:9 thumbnail and the upload text; the phone only shows and copies them
          const thumb = typeof packageJson?.thumbnailRef === 'string' && packageJson.thumbnailRef.startsWith('renders/') ? await deps.blobs.presign?.(packageJson.thumbnailRef) : null
          const video = typeof packageJson?.finalRenderRef === 'string' && packageJson.finalRenderRef.startsWith('renders/') ? await deps.blobs.presign?.(packageJson.finalRenderRef) : null
          return res.status(200).json({ ok:true, jobId:job.id, package:packageJson, upload: packageJson?.metadata ?? null, thumbnailUrl: thumb?.url ?? null, videoUrl: video?.url ?? null, script: script ? { title:script.title, hook:script.hook } : null })
        }
        // Wisdom Shorts: server-made click thumbnail when PACKAGE produced one (older jobs have none)
        const shortsThumb = typeof packageJson?.thumbnailRef === 'string' && packageJson.thumbnailRef.startsWith('renders/') ? await deps.blobs.presign?.(packageJson.thumbnailRef) : null
        return res.status(200).json({ ok:true, jobId:job.id, package:packageJson, upload: packageJson?.metadata?.title ? packageJson.metadata : null, thumbnailUrl: shortsThumb?.url ?? null, script: script ? { title:script.title, hook:script.hook, ending:script.ending, beats:(script.beats||[]).map((b:any)=>({ narration:b.narration })) } : null })
      }

      if (taskType === 'job_get') {
        const id = need(String(req.query?.id || ''), 'id is required')
        const job = await store.getJob(id, workspaceId)
        if (!job) throw new JobError('NOT_FOUND', 'job not found')
        return res.status(200).json({ ok: true, job: view(job, await store.listStageRuns(job.id)) })
      }

      const body: any = input

      // 숨은야담 REMASTER: a NEW child job made from an earlier 숨은야담 job (kept as it is) with a chosen 그림체 — the
      // source's script, main narration (TTS) and upload text are reused; only the cold open, pictures, captions and the
      // render are made again
      if (taskType === 'job_remaster_yasa') {
        const sourceJobId = need(String(body.sourceJobId || ''), 'sourceJobId is required'), style = String(body.visualStyleProfile ?? 'auto')
        body.taskType = 'job_create'; body.profile = 'yasa_longform'
        body.idempotencyKey = body.idempotencyKey ?? `yasa-remaster-${sourceJobId.replace(/[^A-Za-z0-9]/g, '').slice(-40)}-${style}`.slice(0, 128)
        body.input = { remasterOf: { sourceJobId }, visualStyleProfile: style }
        taskType = 'job_create'
      }
      if (taskType === 'job_create') {
        const profile = String(body.profile || '')
        need(isProfileId(profile), `unknown profile: ${profile}`)
        const longform = getProfile(profile).input === 'longform_brief'
        const generative = getProfile(profile).input !== 'source_asset'
        let generativeBriefRef: string | null = null
        let generativeHash = ''
        let sourceAssetId: string
        if (generative) {
          need(body.plan === undefined, 'wisdom plan is server-owned')
          need(body.referenceAssetIds === undefined, 'Reference-conditioned synthesis belongs to P2.5; P2 wisdom does not accept references')
          let brief
          // a derived Wisdom Short: its brief is built HERE from the parent's stored recommendation (the parent script
          // is the source of truth; the caller only names the parent and the candidate)
          const from = !longform && body.input?.derivedFrom ? body.input.derivedFrom : null
          let derivedFrom: any = null
          if (from) {
            need(profile === 'wisdom', 'derived Shorts are made with the wisdom profile')
            const d = await derivedOf(store, deps.blobs, need(String(from.parentJobId || ''), 'derivedFrom.parentJobId is required'), workspaceId)
            const c = d.doc?.candidates.find((x) => x.id === String(from.candidateId || ''))
            if (!d.doc || !c) throw new JobError('NOT_FOUND', 'derived Shorts candidate not found on the parent')
            derivedFrom = { parentLongformJobId: d.parent.id, parentLongformTitle: d.doc.parentLongformTitle, parentLongformUrl: null, candidateId: c.id, shortTitle: c.shortTitle, hook: c.hook, corePoint: c.corePoint, payoff: c.payoff, sourceClaim: c.sourceClaim, sourceRefs: c.sourceRefs }
            body.input = { ...body.input, kind: 'text', text: derivedSourceText(c, d.doc.parentLongformTitle), derivedFrom: undefined }
          }
          const remasterOf = longform && body.input?.remasterOf ? body.input.remasterOf : null
          if (remasterOf) {
            need(profile === 'yasa_longform', 'a remaster is made from a 숨은야담 Longform job')
            const src = await store.getJob(need(String(remasterOf.sourceJobId || ''), 'remasterOf.sourceJobId is required'), workspaceId)
            if (!src || src.profile !== 'yasa_longform') throw new JobError('NOT_FOUND', 'source 숨은야담 job not found')
            const plan = latest(await store.listStageRuns(src.id), 'PLAN'), scriptRef = String((plan?.result as any)?.scriptRef || '')
            if (!scriptRef) throw new JobError('PREREQUISITE_MISSING', 'the source job has no finished script (PLAN)')
            try { brief = yadamRemasterBrief(src.planRef ? await deps.blobs.getJson(src.planRef) : null, { sourceJobId: src.id, scriptRef, visualStyleProfile: body.input.visualStyleProfile }) } catch (e: any) { throw new JobError('BAD_REQUEST', String(e?.message || e)) }
          } else
          try { brief = longform ? normalizeLongformBrief(body.input, profile as any) : normalizeGenerativeBrief(body.input) } catch (e:any) { throw new JobError('BAD_REQUEST', String(e?.message||e)) }
          if (derivedFrom) (brief as any).derivedFrom = derivedFrom
          generativeHash = longform ? longformBriefHash(brief as any) : generativeBriefHash(brief as any)
          const storedBrief = await putAddressed(deps.blobs, 'generative-briefs', brief)
          generativeBriefRef = storedBrief.path
          sourceAssetId = `${longform ? 'src_genlf_' : 'src_gen_'}${generativeHash.slice(0,32)}`
        } else {
          sourceAssetId = matching(body.sourceAssetId, /^src_[A-Za-z0-9_]{8,120}$/, 'sourceAssetId is invalid')
        }
        const idempotencyKey = matching(body.idempotencyKey, /^[A-Za-z0-9_.:-]{8,128}$/, 'idempotencyKey must be 8-128 chars [A-Za-z0-9_.:-]')
        const budgetUsd = body.budgetUsd === undefined ? DEFAULT_BUDGET_USD : Number(body.budgetUsd)
        need(Number.isFinite(budgetUsd) && budgetUsd >= 0 && budgetUsd <= MAX_BUDGET_USD, `budgetUsd must be 0..${MAX_BUDGET_USD}`)
        if (!generative && deps.sourceExists && !(await deps.sourceExists(sourceAssetId))) throw new JobError('SOURCE_ASSET_NOT_FOUND', 'source asset not found')

        let planRef: string | null = null
        let planHash = ''
        let referenceProfileRef: string | null = null
        let referenceProfileHash = ''
        if (body.plan !== undefined) {
          const plan = body.plan
          need(plan && typeof plan === 'object' && plan.schema === 'job-plan/1', 'plan.schema must be job-plan/1')
          need(plan.profile === profile && plan.sourceAssetId === sourceAssetId, 'plan.profile/sourceAssetId must match the job')
          need(plan.variantPlan && Array.isArray(plan.variantPlan.beats) && plan.variantPlan.beats.length > 0, 'plan.variantPlan.beats is required')
          need(canonicalize(plan).length <= MAX_PLAN_BYTES, 'plan is too large')
          const stored = await putAddressed(deps.blobs, 'plans', plan)
          planRef = stored.path; planHash = stored.sha256
        }
        need(body.referenceProfile === undefined, 'referenceProfile is server-owned; send referenceAssetIds instead')
        if (body.referenceAssetIds !== undefined) {
          need(Array.isArray(body.referenceAssetIds) && body.referenceAssetIds.length > 0 && body.referenceAssetIds.length <= 4, 'referenceAssetIds must contain 1..4 references')
          const ids=[...new Set(body.referenceAssetIds.map((x:unknown)=>matching(x,/^ref_[a-f0-9]{64}$/,'referenceAssetId is invalid')))]
          need(ids.length===body.referenceAssetIds.length,'referenceAssetIds must be unique')
          const analyses=[]
          const analyzeReference=deps.analyzeReference ?? analyzeRegisteredReference
          for(const id of ids as string[]) analyses.push((await analyzeReference(id)).analysis)
          const bundle=buildReferenceProductionBrief({profile,sourceAssetId,analyses})
          const errors=validateReferenceProfile(bundle.profile)
          need(errors.length===0,`server referenceProfile is invalid: ${errors.join(',')}`)
          const stored=await putAddressed(deps.blobs,'reference-profiles',bundle.profile)
          referenceProfileRef=stored.path
          referenceProfileHash=bundle.profileHash
          await putAddressed(deps.blobs,'production-briefs',bundle.brief)
        }
        if (generativeBriefRef) planRef = generativeBriefRef
        const { job, created } = await store.createJob({ workspaceId, profile, sourceAssetId, idempotencyKey, budgetUsd, planRef, referenceProfileRef, requestFingerprint: `${profile}|${sourceAssetId}|${planHash}|${referenceProfileHash}|${generativeHash}` })
        // a derived Short is recorded on its parent (one child per candidate)
        const derivedParent = body.input?.derivedFrom === undefined && generativeBriefRef ? ((await deps.blobs.getJson(generativeBriefRef)) as any)?.derivedFrom : null
        if (derivedParent?.parentLongformJobId) {
          const ref = childrenRef(derivedParent.parentLongformJobId), cur: any = (await deps.blobs.getJson(ref).catch(() => null)) ?? { children: [] }
          if (!cur.children.some((x: any) => x.candidateId === derivedParent.candidateId)) await deps.blobs.putJson(ref, { children: [...cur.children, { candidateId: derivedParent.candidateId, jobId: job.id }] }, { overwrite: true })
        }
        return res.status(created ? 201 : 200).json({ ok: true, created, job: view(job, await store.listStageRuns(job.id)) })
      }

      if (taskType === 'job_decision') {
        const jobId = need(String(body.jobId || ''), 'jobId is required')
        const manifestHash = matching(body.manifestHash, /^[0-9a-f]{64}$/, 'manifestHash must be a SHA-256 hex')
        const reason = body.override ? String(body.override.reason || '') : ''
        const job = await store.recordDecision({ jobId, workspaceId, manifestHash, ...(body.override ? { override: { reason } } : {}) })
        return res.status(200).json({ ok: true, job: view(job, await store.listStageRuns(job.id)) })
      }

      if (taskType === 'job_retry_render') {
        // a Longform that failed at RENDER: the SAME job renders again from its stored assets (no new job, no AI call)
        const job = await store.retryLongformRender({ jobId: need(String(body.jobId || ''), 'jobId is required'), workspaceId })
        return res.status(200).json({ ok: true, job: view(job, await store.listStageRuns(job.id)) })
      }

      if (taskType === 'job_cancel') {
        const jobId = need(String(body.jobId || ''), 'jobId is required')
        const job = await store.requestCancel({ jobId, workspaceId })
        return res.status(200).json({ ok: true, job: view(job, await store.listStageRuns(job.id)) })
      }

    } catch (e: any) {
      const code = e instanceof JobError ? e.code : 'INTERNAL'
      const status = STATUS_BY_CODE[code] ?? (e instanceof JobError ? 400 : 500)
      if (status === 500) console.error('[jobs]', e)
      return res.status(status).json({ ok: false, error: { code, message: status === 500 ? 'internal error' : String(e?.message || e) } })
    }
  }
}

let cachedStore: Promise<JobStore> | null = null
export const defaultJobsHttp = createJobsHttp({
  getStore: () => {
    if (!process.env.DATABASE_URL) return Promise.reject(new JobError('JOBS_DB_NOT_CONFIGURED', 'Production Job database (DATABASE_URL) is not configured'))
    cachedStore ??= createPgDbFromEnv().then((db) => createJobStore(db))
    cachedStore.catch(() => { cachedStore = null })
    return cachedStore
  },
  blobs: createVercelJobBlobStore(),
  sourceExists: async (id) => {
    const { getSourceAsset } = await import('../sourceAssetRegistry.js')
    try { await getSourceAsset(id); return true } catch (e: any) { if (e?.code === 'SOURCE_ASSET_NOT_FOUND') return false; throw e }
  }
})
