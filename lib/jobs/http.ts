import { styleApprovalRef, imageStyleFeatures, thumbnailTextOf } from '../generative/styleApproval.js'
import { approvedThumbnailVersion, composeThumbnailVersion, currentThumbnail, readThumbnailOverride, saveThumbnailVersion } from '../generative/thumbnailOverride.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { normalizeLongformBrief, longformBriefHash, longformRemasterBrief } from '../generative/longform.js'
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

export const JOB_TASK_TYPES = ['job_create', 'job_get', 'job_preview', 'job_package', 'job_decision', 'job_cancel', 'job_derived', 'job_retry_render', 'job_remaster', 'job_remaster_yasa', 'job_list', 'job_style', 'job_style_decision', 'job_style_examples'] as const
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
  PROVIDER_BILLING: 503, PROVIDER_STOP: 503, PROVIDER_DOWN: 503, PREVIEW_FAILED: 502, TTS_FAILED: 502, NOT_RENDER_RETRYABLE: 409, NOT_AWAITING_THUMBNAIL: 409, NO_THUMBNAIL: 409, PREREQUISITE_MISSING: 409, THUMBNAIL_BUSY: 409, THUMBNAIL_LOCKED: 409
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
    // paid calls of this job so far (every attempt, failed ones too): estimated USD + call counts per stage / model
    cost: jobCost(runs),
    runs: runs.map((r) => ({ stage: r.stage, kind: r.kind, attempt: r.attempt, status: r.status, error: r.error, finishedAt: r.finishedAt, paidCalls: usageOfRun(r)?.paidCalls ?? 0, estUsd: usageOfRun(r)?.estUsd ?? 0 }))
  }
}
const usageOfRun = (r: StageRun): any => { const u: any = r.usage; return u?.schema === 'usage/1' ? u : u?.ledger?.schema === 'usage/1' ? u.ledger : null }
export function jobCost(runs: StageRun[]) {
  const byStage: Record<string, { paidCalls: number; estUsd: number; attempts: number }> = {}, byModel: Record<string, { calls: number; estUsd: number | null; outputTokens: number; reasoningTokens: number }> = {}
  let paidCalls = 0, estUsd = 0
  const unpriced = new Set<string>()
  for (const r of runs) {
    const u = usageOfRun(r); if (!u) continue
    const s = (byStage[r.stage] ??= { paidCalls: 0, estUsd: 0, attempts: 0 }); s.attempts++; s.paidCalls += u.paidCalls; s.estUsd = Number((s.estUsd + (u.estUsd ?? 0)).toFixed(4))
    paidCalls += u.paidCalls; estUsd += u.estUsd ?? 0
    for (const [m, x] of Object.entries<any>(u.byModel ?? {})) { const t = (byModel[m] ??= { calls: 0, estUsd: 0, outputTokens: 0, reasoningTokens: 0 }); t.calls += x.calls; t.outputTokens += x.outputTokens; t.reasoningTokens += x.reasoningTokens; t.estUsd = t.estUsd === null || x.estUsd === null ? null : Number((t.estUsd + x.estUsd).toFixed(4)) }
    for (const m of u.unpricedModels ?? []) unpriced.add(m)
  }
  return { paidCalls, estUsd: Number(estUsd.toFixed(4)), byStage, byModel, unpricedModels: [...unpriced] }
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
      const expectedMethod = taskType === 'job_get' || taskType === 'job_list' || taskType === 'job_style' || taskType === 'job_style_examples' || taskType === 'job_preview' || taskType === 'job_package' || taskType === 'job_derived' ? 'GET' : 'POST'
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
        // a remaster child names its source job (the screen links back to it)
        const brief: any = job.planRef ? await deps.blobs.getJson(job.planRef).catch(() => null) : null
        return res.status(200).json({ ok: true, job: { ...view(job, await store.listStageRuns(job.id)), remasterOf: brief?.remaster?.sourceJobId ?? null } })
      }

      // THUMBNAIL FIRST: the thumbnail waiting for approval (or the approved one) and the representative check, for the phone
      // ONE-OFF publish of the candidate 그림체 examples the worker already drew (STYLE_EXAMPLES_RUN): short links to
      // exactly the files its run record names (no other path, no picture is made). confirm=1 marks the run published,
      // after which this answers 410 for good.
      if (taskType === 'job_style_examples') {
        const run = String(req.query?.run || '')
        need(/^[a-z0-9-]{1,32}$/.test(run), 'run is required')
        const base = `style-examples/candidates/${run}`, rec: any = await deps.blobs.getJson(`${base}/run.json`).catch(() => null)
        if (!rec || rec.status !== 'done') throw new JobError('NOT_FOUND', 'no finished example run')
        if (await deps.blobs.getJson(`${base}/published.json`).catch(() => null)) return res.status(410).json({ ok: false, error: { code: 'ALREADY_PUBLISHED', message: 'this run was already published' } })
        if (String(req.query?.confirm || '') === '1') { await deps.blobs.putJson(`${base}/published.json`, { at: new Date().toISOString() }, { overwrite: false }); return res.status(200).json({ ok: true, published: true }) }
        const files: Record<string, string> = {}
        for (const [k, ref] of Object.entries<string>(rec.files ?? {})) { if (!String(ref).startsWith(`${base}/`)) continue; const s = await deps.blobs.presign?.(ref, 30 * 60_000).catch(() => null); if (s) files[k] = s.url }
        return res.status(200).json({ ok: true, run, order: rec.order ?? [], errors: rec.errors ?? {}, report: rec.report ?? {}, files })
      }
      if (taskType === 'job_style') {
        const id = need(String(req.query?.id || ''), 'id is required')
        const job = await store.getJob(id, workspaceId)
        if (!job) throw new JobError('NOT_FOUND', 'job not found')
        const rec: any = await deps.blobs.getJson(styleApprovalRef(job.id)).catch(() => null)
        if (!rec) return res.status(200).json({ ok: true, style: null })
        const cur = rec.status === 'approved' ? rec.approved : rec.attempts?.at(-1)
        const url = async (ref?: string) => (ref && deps.blobs.presign ? (await deps.blobs.presign(ref).catch(() => null))?.url ?? null : null)
        const awaiting = job.status === 'WAITING_USER' && job.waitReason === 'DECISION' && job.stage === 'ASSET'
        // a replacement made after approval (썸네일만 다시 생성 / 문구 수정) is the thumbnail shown and delivered
        const ov = rec.status === 'approved' ? await readThumbnailOverride(deps.blobs, job.id) : null
        const shown = rec.status === 'approved' ? (ov?.current ?? approvedThumbnailVersion(rec)) : null
        return res.status(200).json({ ok: true, style: {
          status: rec.status, awaiting, attempt: cur?.n ?? 0, attempts: rec.attempts?.length ?? 0, thumbnailUrl: await url(ov?.current.thumbnailRef ?? cur?.thumbnailRef),
          thumbnailText: shown?.text ?? null, redrawingThumbnail: !!rec.thumbnailRequest,
          replacement: ov ? { n: ov.current.n, source: ov.current.source, text: ov.current.text, imageIssues: ov.current.imageIssues, check: ov.current.check ? { ok: ov.current.check.ok, score: ov.current.check.judge?.score ?? null, differences: ov.current.check.judge?.differences ?? [] } : null, versions: ov.history.length } : null,
          copy: (rec.attempts?.at(-1)?.lines ?? []).map((l: any) => String(l?.text || '')), issues: ov ? ov.current.imageIssues : [...(rec.attempts?.at(-1)?.copyIssues ?? []), ...(rec.attempts?.at(-1)?.imageIssues ?? [])],
          regenerating: rec.regenerate === true, redrawingRepresentative: rec.redrawRepresentative === true,
          representative: rec.representative ? { status: rec.representative.status, distance: rec.representative.distance, url: await url(rec.representative.ref) } : null
        } })
      }

      // this workspace's jobs, newest first: id, kind, state, title (the brief's topic) and the source of a remaster.
      // The phone merges it into its own list, so a finished job on the server is never lost from the screen.
      if (taskType === 'job_list') {
        const jobs = await store.listJobs(workspaceId, Number(req.query?.limit) || 50)
        const out = await Promise.all(jobs.map(async (j) => {
          const brief: any = getProfile(j.profile).input !== 'source_asset' ? (j.planRef ? await deps.blobs.getJson(j.planRef).catch(() => null) : null) : null
          return { id: j.id, profile: j.profile, status: j.status, stage: j.stage, sourceAssetId: j.sourceAssetId, createdAt: j.createdAt, updatedAt: j.updatedAt, title: typeof brief?.text === 'string' ? brief.text.slice(0, 80) : null, remasterOf: brief?.remaster?.sourceJobId ?? null }
        }))
        return res.status(200).json({ ok: true, jobs: out })
      }

      const body: any = input

      // 승인 / 다시 생성 of the thumbnail: the SAME job continues (approve -> the pictures in that style; regenerate -> one
      // new thumbnail). Only a job waiting for its thumbnail; the decision names the attempt the user saw.
      if (taskType === 'job_style_decision') {
        const jobId = need(String(body.jobId || ''), 'jobId is required'), action = String(body.action || '')
        need(['approve', 'regenerate', 'representative', 'thumbnail_redraw', 'thumbnail_text'].includes(action), 'action must be approve, regenerate, representative, thumbnail_redraw or thumbnail_text')
        const job = await store.getJob(jobId, workspaceId)
        if (!job) throw new JobError('NOT_FOUND', 'job not found')
        // 문구만 바꾸기: the current thumbnail picture + the user's words (no AI call, no job state change). Allowed until the
        // video is rendered (RENDER reads the thumbnail when it composes the package); never while a redraw is on its way.
        if (action === 'thumbnail_text') {
          const rec: any = await deps.blobs.getJson(styleApprovalRef(job.id)).catch(() => null)
          if (!rec || rec.status !== 'approved' || !rec.approved) throw new JobError('NO_THUMBNAIL', 'the thumbnail is not approved yet')
          const open = (job.stage === 'ASSET' && ['WAITING_USER', 'QUEUED', 'RUNNING'].includes(job.status)) || (job.stage === 'RENDER' && job.status === 'QUEUED')
          if (!open) throw new JobError('THUMBNAIL_LOCKED', `the video is past its thumbnail (${job.status}/${job.stage})`)
          if (rec.thumbnailRequest) throw new JobError('THUMBNAIL_BUSY', 'a new thumbnail picture is being drawn')
          let text: string
          try { text = thumbnailTextOf(body.text) } catch (e: any) { throw new JobError('BAD_REQUEST', String(e?.message || e)) }
          const cur = await currentThumbnail(deps.blobs, job.id, rec)
          const bg = cur ? await deps.blobs.getBytes(cur.backgroundRef) : null
          if (!cur || !bg) throw new JobError('NO_THUMBNAIL', 'the thumbnail picture is missing')
          const prev = await readThumbnailOverride(deps.blobs, job.id)
          let v
          try { v = await composeThumbnailVersion(deps.blobs, { background: bg, text, n: (prev?.current.n ?? 0) + 1, source: 'text', imageIssues: cur.imageIssues, check: cur.check ?? null }) }
          catch (e: any) { throw new JobError('BAD_REQUEST', `${e?.code || 'THUMB_TITLE_OVERFLOW'}: ${String(e?.message || e)}`) }
          const ov = await saveThumbnailVersion(deps.blobs, job.id, rec, v)
          return res.status(200).json({ ok: true, job: view(job, await store.listStageRuns(job.id)), thumbnail: { n: ov.current.n, text: ov.current.text, lines: ov.current.lines } })
        }
        if (job.status !== 'WAITING_USER' || job.waitReason !== 'DECISION' || job.stage !== 'ASSET') throw new JobError('NOT_AWAITING_THUMBNAIL', `job is ${job.status}/${job.stage}/${job.waitReason}`)
        // 썸네일만 다시 생성: after approval, the worker draws ONE new thumbnail picture (the approved one stays the style /
        // character lock; the representative scene and every drawn scene are kept) and checks it against the representative
        if (action === 'thumbnail_redraw') {
          const rec: any = await deps.blobs.getJson(styleApprovalRef(job.id)).catch(() => null)
          if (!rec || rec.status !== 'approved' || !rec.approved) throw new JobError('NO_THUMBNAIL', 'the thumbnail is not approved yet (use regenerate)')
          rec.thumbnailRequest = { at: new Date().toISOString() }
          await deps.blobs.putJson(styleApprovalRef(job.id), rec, { overwrite: true })
          const next = await store.resumeStyleApproval({ jobId: job.id, workspaceId })
          return res.status(200).json({ ok: true, job: view(next, await store.listStageRuns(next.id)), style: { status: rec.status, thumbnail: 'redrawing' } })
        }
        const rec: any = await deps.blobs.getJson(styleApprovalRef(job.id)).catch(() => null), cur = rec?.attempts?.at(-1)
        // after approval the job waits only when the representative did not match: redraw it, or start over from a new thumbnail
        const mismatch = rec?.status === 'approved' && rec?.representative?.status === 'mismatch'
        if (mismatch && action === 'representative') rec.redrawRepresentative = true
        else if (mismatch && action === 'regenerate') { rec.status = 'pending'; delete rec.approved; delete rec.representative; rec.regenerate = true }
        else if (!rec || rec.status !== 'pending' || !cur || action === 'representative') throw new JobError('NO_THUMBNAIL', 'no thumbnail is waiting')
        if (!mismatch && body.attempt !== undefined && Number(body.attempt) !== cur.n) throw new JobError('NO_THUMBNAIL', `attempt ${body.attempt} is not the current thumbnail (${cur.n})`)
        if (mismatch) { /* handled above */ } else if (action === 'approve') {
          const bg = await deps.blobs.getBytes(cur.backgroundRef)
          if (!bg) throw new JobError('NO_THUMBNAIL', 'the thumbnail picture is missing')
          const dir = await mkdtemp(join(tmpdir(), 'style-approve-')), f = join(dir, 'bg.jpg')
          try { await writeFile(f, bg); rec.approved = { n: cur.n, backgroundRef: cur.backgroundRef, thumbnailRef: cur.thumbnailRef, features: await imageStyleFeatures(f), at: new Date().toISOString() } } finally { await rm(dir, { recursive: true, force: true }) }
          rec.status = 'approved'
        } else rec.regenerate = true
        await deps.blobs.putJson(styleApprovalRef(job.id), rec, { overwrite: true })
        const next = await store.resumeStyleApproval({ jobId: job.id, workspaceId })
        return res.status(200).json({ ok: true, job: view(next, await store.listStageRuns(next.id)), style: { status: rec.status, attempt: cur.n } })
      }

      // Generic REMASTER entry point. It always makes a NEW child job on the source's own profile and keeps the
      // source immutable. The "changes" object says what changed; cache identity then reuses everything unaffected.
      // job_remaster_yasa remains only as a backwards-compatible alias and translates into the same shared contract.
      if (taskType === 'job_remaster_yasa') {
        body.taskType = 'job_remaster'
        body.changes = { refreshColdOpen: true } // 야담 has one 그림체: the alias never changes it
        taskType = 'job_remaster'
      }
      if (taskType === 'job_remaster') {
        const sourceJobId = need(String(body.sourceJobId || ''), 'sourceJobId is required')
        const src = await store.getJob(sourceJobId, workspaceId)
        if (!src) throw new JobError('NOT_FOUND', 'source job not found')
        need(getProfile(src.profile).input === 'longform_brief', 'this remaster adapter currently supports Longform profiles')
        const changes = body.changes === undefined ? {} : body.changes
        need(changes && typeof changes === 'object' && !Array.isArray(changes), 'changes must be an object')
        const changeHash = createHash('sha256').update(canonicalize(changes)).digest('hex').slice(0, 16)
        body.taskType = 'job_create'; body.profile = src.profile
        // the same request while one is queued / running / complete is the same job; a FAILED one is never handed back:
        // the next free key (…-r2, -r3, …) makes a NEW child job (the source and the failed job stay as they are)
        if (body.idempotencyKey === undefined) {
          const base = `remaster-${sourceJobId.replace(/[^A-Za-z0-9]/g, '').slice(-40)}-${changeHash}`.slice(0, 120)
          let key = base
          for (let n = 2; n < 100; n++) { const prior = await store.getJobByIdempotencyKey(workspaceId, key); if (!prior || prior.status !== 'FAILED') break; key = `${base}-r${n}` }
          body.idempotencyKey = key
        }
        body.input = { remasterOf: { sourceJobId }, changes }
        taskType = 'job_create'
      }
      if (taskType === 'job_create') {
        const profile = String(body.profile || '')
        need(isProfileId(profile), `unknown profile: ${profile}`)
        const longform = getProfile(profile).input === 'longform_brief'
        const generative = getProfile(profile).input !== 'source_asset'
        let generativeBriefRef: string | null = null
        let reuseActive = false // a new (non-remaster) brief: the same one still running is handed back, never paid twice
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
            const src = await store.getJob(need(String(remasterOf.sourceJobId || ''), 'remasterOf.sourceJobId is required'), workspaceId)
            if (!src || src.profile !== profile) throw new JobError('NOT_FOUND', 'source Longform job not found on this profile')
            const plan = latest(await store.listStageRuns(src.id), 'PLAN'), scriptRef = String((plan?.result as any)?.scriptRef || '')
            if (!scriptRef) throw new JobError('PREREQUISITE_MISSING', 'the source job has no finished script (PLAN)')
            try { brief = longformRemasterBrief(src.planRef ? await deps.blobs.getJson(src.planRef) : null, { sourceJobId: src.id, sourceScriptRef: scriptRef, changes: body.input.changes }) } catch (e: any) { throw new JobError('BAD_REQUEST', String(e?.message || e)) }
          } else
          try { brief = longform ? normalizeLongformBrief(body.input, profile as any) : normalizeGenerativeBrief(body.input) } catch (e:any) { throw new JobError('BAD_REQUEST', String(e?.message||e)) }
          if (derivedFrom) (brief as any).derivedFrom = derivedFrom
          generativeHash = longform ? longformBriefHash(brief as any) : generativeBriefHash(brief as any)
          const storedBrief = await putAddressed(deps.blobs, 'generative-briefs', brief)
          generativeBriefRef = storedBrief.path
          reuseActive = !(brief as any).remaster
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
        const { job, created } = await store.createJob({ workspaceId, profile, sourceAssetId, idempotencyKey, budgetUsd, planRef, referenceProfileRef, requestFingerprint: `${profile}|${sourceAssetId}|${planHash}|${referenceProfileHash}|${generativeHash}`, reuseActiveSamePlan: !!generativeBriefRef && reuseActive })
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
