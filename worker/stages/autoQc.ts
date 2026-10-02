import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { putAddressed, sha256 } from '../../lib/jobs/blobs.js'
import { evaluateGate, type CheckResult } from '../../lib/qc/gate.js'
import { analyzeSourceFile, type SourceAnalysis } from '../../lib/media/analyze.js'
import { QC_THRESHOLDS, runRenderQc } from '../../lib/media/qc.js'
import { detectSourceFraming, foregroundRect, measureOuterCanvasFill, regionSignature, type SourceFraming } from '../../lib/media/framing.js'
import { extractJpeg, signatureDistance, probe, sceneScores, detectSilence } from '../../lib/media/ffmpeg.js'
import { extractRenderPlan } from '../../lib/media/render.js'
import { evaluateContentGate } from '../../lib/media/contentGate.js'
import type { SemanticResult, StoryAnalysis } from '../../lib/media/story.js'
import { StageError, type StageExecutor } from '../types.js'
import { evaluateReferenceConformance } from '../../lib/reference/qc.js'
import type { ReferenceProfile, ReferenceAsset } from '../../lib/reference/contracts.js'
import { detectCaptionRegions } from '../../lib/reference/serverPipeline.js'

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
export function createAutoQcExecutor(referenceProfile: ReferenceProfile | null = null, resolveReferenceProfile?: (job:any, blobs:any)=>Promise<ReferenceProfile|null>): StageExecutor { return {
  stage: 'AUTO_QC',
  estimateUsd: () => 0,
  inputHash: (job) => sha256(`auto-qc|v2|${job.id}|${job.planRev}|${job.referenceProfileRef ?? 'no-reference'}`),
  async run({ job, blobs, previous, resolveSourceAsset, resolveSourceFile, signal }) {
    const render = await previous('RENDER')
    const rendered = ((render?.result as any)?.variants || []) as any[]
    if (!rendered.length) throw new StageError('RENDER_MISSING', 'AUTO_QC requires a completed RENDER stage')
    const analysisRun = await previous('ANALYZE')
    const analysis = analysisRun?.outputRef ? await blobs.getJson<SourceAnalysis>(analysisRun.outputRef) : null
    if (!analysis) throw new StageError('ANALYSIS_MISSING', 'AUTO_QC needs the source analysis (expected freeze/silence ranges)')

    // Semantic story from PLAN (if any). Its status is carried verbatim: only 'ok' can yield content PASS.
    const planRun = await previous('PLAN')
    const sem = (planRun?.result as any)?.semantic
    const story = sem?.storyRef ? await blobs.getJson<StoryAnalysis>(sem.storyRef) : null
    const semantic: SemanticResult = sem
      ? { status: sem.status, reason: sem.reason ?? null, story: sem.status === 'ok' ? story : null }
      : { status: 'unavailable', reason: planRun ? 'PLAN recorded no semantic analysis' : 'job has no PLAN stage (client-supplied plan)', story: null }
    if (semantic.status === 'ok' && !semantic.story) { semantic.status = 'failed'; semantic.reason = 'story blob missing' }

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
        let gate, contentGate: any = null, contactSheetRef: string | null = null, posterRef: string | null = null, outputInfo: any = null
        if (!manifest || !bytes) {
          gate = { decision: 'BLOCK', reasons: ['UNKNOWN: artifact.available'], counts: { pass: 0, fail: 0, unknown: 1, requiredPass: 0, requiredTotal: 1 }, checks: [{ id: 'artifact.available', required: true, status: 'UNKNOWN', evidence: { manifest: !!manifest, render: !!bytes } }] }
        } else {
          const renderPath = join(work, `${v.variantId}.mp4`)
          await writeFile(renderPath, bytes)
          outputInfo = await probe(renderPath)
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

          // Output QC is NOT the source detector: it only asks whether the outer canvas still shows persistent pure-black
          // padding. A dark blurred background carries picture energy and passes; true letterbox/pillarbox bars fail.
          try {
            if (job.profile === 'wisdom') {
              const framing = await detectSourceFraming(renderPath)
              const crop = framing.crop
              const expectedTop = 360 / 1920, expectedHeight = 1200 / 1920, tolerance = 0.035
              const h = Number(outputInfo?.height || 1920)
              const actualTop = crop ? crop.y / h : null
              const actualHeight = crop ? crop.height / h : null
              const actualBottom = crop ? Math.max(0, h - crop.y - crop.height) / h : null
              // Headline/subtitle glyphs intentionally live inside the black bands. Pixel-based framing can therefore
              // see the text as foreground and shrink one/both bars. Accept either a clean measured 360/1200/360
              // crop OR prove the immutable render manifest is the wisdom layout and the measured center stays bounded.
              const measuredExact = framing.mode === 'embedded' && crop !== null && actualTop !== null && actualHeight !== null
                && Math.abs(actualTop - expectedTop) <= tolerance && Math.abs(actualHeight - expectedHeight) <= tolerance
                && actualBottom !== null && Math.abs(actualBottom - expectedTop) <= tolerance
              const manifestWisdom = manifest?.payload?.editorialPlan?.profile === 'wisdom-v1'
              const centerBounded = crop !== null && actualHeight !== null && actualHeight >= 0.55 && actualHeight <= 0.75
              const pass = measuredExact || (manifestWisdom && centerBounded)
              checks.push({ id: 'wisdom.screen_dna_layout', required: true, status: pass ? 'PASS' : 'FAIL', evidence: { framing, manifestWisdom, expected: { topBlack: expectedTop, centerHeight: expectedHeight, bottomBlack: expectedTop }, actual: { top: actualTop, centerHeight: actualHeight, bottom: actualBottom }, tolerance, method: measuredExact ? 'pixel-framing' : 'manifest+bounded-center' } })
            } else {
              const fill = await measureOuterCanvasFill(renderPath)
              checks.push({ id: 'visual.frame_utilization', required: true, status: fill.filled ? 'PASS' : 'FAIL', evidence: fill })
            }
          } catch (e: any) {
            checks.push({ id: job.profile === 'wisdom' ? 'wisdom.screen_dna_layout' : 'visual.frame_utilization', required: true, status: 'UNKNOWN', evidence: { error: String(e?.message || e) } })
          }
          gate = evaluateGate(checks)

          // Content (editorial) gate — separate from the technical gate above; recorded, never merged into it.
          try {
            if(job.profile==='wisdom'){
              const scriptRef=(planRun?.result as any)?.scriptRef
              const script:any=scriptRef?await blobs.getJson(scriptRef):null
              const assetRun=await previous('ASSET'), assets:any=assetRun?.outputRef?await blobs.getJson(assetRun.outputRef):null
              const beats=Array.isArray(script?.beats)?script.beats:[], items=Array.isArray(assets?.items)?assets.items:[]
              const ready=items.length===beats.length&&items.every((x:any)=>x.image?.status==='ready'&&x.tts?.status==='ready')
              const measuredTotal=items.reduce((sum:number,x:any)=>sum+Number(x.durationSec||0),0)
              // COMPILE is authoritative for the final timeline. ASSET item durations are pre-compile measurements
              // and may legitimately exceed the bounded source timeline (for example when generated TTS has tail audio).
              // Compare the rendered output with the immutable compiled manifest, while retaining script/asset totals as evidence.
              const manifestTotal=Number(extractRenderPlan(manifest.payload).total)
              const actual=Number(outputInfo?.duration||v.duration||0)
              contentGate=evaluateGate([
                {id:'wisdom.script_structure',required:true,status:script?.schema==='wisdom-script/1'&&beats.length>=4?'PASS':'FAIL',evidence:{beats:beats.length}},
                {id:'wisdom.assets_complete',required:true,status:ready?'PASS':'FAIL',evidence:{beats:beats.length,items:items.length}},
                {id:'wisdom.narration_present',required:true,status:outputInfo?.hasAudio?'PASS':'FAIL',evidence:{hasAudio:outputInfo?.hasAudio??false}},
                {id:'wisdom.duration_matches_script',required:true,status:manifestTotal>0&&actual>0&&Math.abs(manifestTotal-actual)<=Math.max(1,manifestTotal*.05)?'PASS':'FAIL',evidence:{authoritativeManifestTotal:manifestTotal,scriptPlannedTotal:Number(script?.totalSeconds||0),assetMeasuredTotal:measuredTotal,actual}},
                {id:'wisdom.topic_faithfulness',required:true,status:(planRun?.result as any)?.semanticQc?.topicFaithfulness?'PASS':'FAIL',evidence:(planRun?.result as any)?.semanticQc},
                {id:'wisdom.hook',required:true,status:(planRun?.result as any)?.semanticQc?.hook?'PASS':'FAIL',evidence:(planRun?.result as any)?.semanticQc},
                {id:'wisdom.progression',required:true,status:(planRun?.result as any)?.semanticQc?.progression?'PASS':'FAIL',evidence:(planRun?.result as any)?.semanticQc},
                {id:'wisdom.turn',required:true,status:(planRun?.result as any)?.semanticQc?.turn?'PASS':'FAIL',evidence:(planRun?.result as any)?.semanticQc},
                {id:'wisdom.ending',required:true,status:(planRun?.result as any)?.semanticQc?.ending?'PASS':'FAIL',evidence:(planRun?.result as any)?.semanticQc},
                {id:'wisdom.non_repetitive',required:true,status:(planRun?.result as any)?.semanticQc?.nonRepetitive?'PASS':'FAIL',evidence:(planRun?.result as any)?.semanticQc}
              ])
            } else contentGate = evaluateContentGate({ payload: manifest.payload, analysis, semantic, framing: v.sourceFraming ?? null })
          }
          catch (e: any) { contentGate = evaluateGate([{ id: 'content.evaluated', required: true, status: 'UNKNOWN', evidence: { error: String(e?.message || e) } }]) }

          try {
            const posterPath = join(work, `${v.variantId}-poster.jpg`)
            await extractJpeg(renderPath, Math.min(1, (v.duration ?? 2) / 2), posterPath, 'scale=540:-2')
            const poster = await readFile(posterPath); posterRef = (await blobs.putBytes(`renders/${sha256(poster)}.jpg`, poster, 'image/jpeg')).path
          } catch { /* optional */ }
          try { const sheet = await readFile(sheetPath); contactSheetRef = (await blobs.putBytes(`renders/${sha256(sheet)}.jpg`, sheet, 'image/jpeg')).path } catch { /* optional */ }
        }
        if (!contentGate) contentGate = evaluateGate([{ id: 'content.evaluated', required: true, status: 'UNKNOWN', evidence: { reason: 'render artifact unavailable' } }])
        await putAddressed(blobs, `qc/render/${v.renderHash}`, gate)
        await putAddressed(blobs, `qc/content/${v.renderHash}`, contentGate)
        // "Upload as-is" requires BOTH gates. Technical PASS alone is not publishable.
        const jobReferenceProfile = resolveReferenceProfile ? await resolveReferenceProfile(job, blobs) : referenceProfile
        const measurements: Record<string, unknown> = {}
        if (jobReferenceProfile && outputInfo?.width && outputInfo?.height && bytes && manifest) {
          const renderPath=join(work,`${v.variantId}.mp4`)
          const actual = outputInfo.width === outputInfo.height ? 'square' : outputInfo.height > outputInfo.width ? 'portrait' : 'landscape'
          for (const x of jobReferenceProfile.constraints.filter((x:any)=>x.id.endsWith(':composition.frame') || x.id==='composition.frame')) {
            const target=(x.value as any)?.orientation
            if (typeof target === 'string') measurements[x.id]={
              measured:true, pass:target===actual, target, actual,
              method:'ffmpeg-probe-output-orientation',
              provenance:{source:'server-render-bytes',renderHash:v.renderHash,bytesHash:sha256(bytes),width:outputInfo.width,height:outputInfo.height}
            }
          }
          for(const x of jobReferenceProfile.constraints.filter((x:any)=>x.id.endsWith(':visual.style')||x.id==='visual.style')){
            const target=x.value as any
            if(typeof target?.aspectRatio==='number'&&typeof target?.orientation==='string'){
              const actualRatio=Number((outputInfo.width/outputInfo.height).toFixed(4)),targetRatio=Number(target.aspectRatio),delta=Math.abs(actualRatio-targetRatio),tolerance=0.03
              const actualOrientation=outputInfo.width===outputInfo.height?'square':outputInfo.height>outputInfo.width?'portrait':'landscape'
              measurements[x.id]={measured:true,pass:actualOrientation===target.orientation&&delta<=tolerance,target:{orientation:target.orientation,aspectRatio:targetRatio},actual:{orientation:actualOrientation,aspectRatio:actualRatio},tolerance:{aspectRatio:tolerance},method:'ffmpeg-probe-output-geometric-style',provenance:{source:'server-render-bytes',renderHash:v.renderHash,bytesHash:sha256(bytes),width:outputInfo.width,height:outputInfo.height}}
            }
          }
          for(const x of jobReferenceProfile.constraints.filter((x:any)=>x.id.endsWith(':caption.layout')||x.id==='caption.layout')){
            const target=(x.value as any)?.coverage
            if(target&&Number(outputInfo.duration)>0){
              try{
                const renderAsset:any={schema:'reference-asset/1',referenceAssetId:'ref_'+sha256(bytes),kind:'video',sha256:sha256(bytes),bytes:bytes.length,contentType:'video/mp4',blobPath:'render-only',width:outputInfo.width,height:outputInfo.height,duration:Number(outputInfo.duration),createdAt:new Date(0).toISOString()}
                const actualRegions=await detectCaptionRegions(renderPath,renderAsset)
                if(actualRegions?.length){
                  const avg=(k:'x'|'y'|'width'|'height')=>actualRegions.reduce((n,r)=>n+Number(r[k]),0)/actualRegions.length
                  const actualCoverage={x:avg('x'),y:avg('y'),width:avg('width'),height:avg('height')}
                  const targetCenterY=Number(target.y)+Number(target.height)/2,actualCenterY=actualCoverage.y+actualCoverage.height/2,tolerance=0.18
                  measurements[x.id]={measured:true,pass:Math.abs(targetCenterY-actualCenterY)<=tolerance,target:{centerY:Number(targetCenterY.toFixed(3))},actual:{centerY:Number(actualCenterY.toFixed(3)),coverage:actualCoverage},tolerance:{normalizedY:tolerance},method:'reference-caption-vision-output-frame-regions',provenance:{source:'server-render-bytes',renderHash:v.renderHash,bytesHash:sha256(bytes),regions:actualRegions.length}}
                }
              }catch{/* output caption vision failure remains UNKNOWN */}
            }
          }
          try{
            const scores=await sceneScores(renderPath),duration=Number(outputInfo.duration||v.duration||0),cuts:number[]=[]
            for(const s of scores)if(s.score>0.3&&s.t>0.2&&s.t<duration-0.2&&(!cuts.length||s.t-cuts[cuts.length-1]>=0.5))cuts.push(s.t)
            const meanSceneSeconds=duration>0?duration/(cuts.length+1):null
            try{
              const measured=await analyzeSourceFile(renderPath,{sourceAssetId:`render:${v.renderHash}`,sha256:sha256(bytes)})
              for(const x of jobReferenceProfile.constraints.filter((x:any)=>x.id.endsWith(':retention.peak')||x.id==='retention.peak')){
                const target=x.value as any,targetPeak=target?.firstPeak
                const aggregateNorm=Number(target?.firstPeakNormalized)
                if(((targetPeak&&Number.isFinite(Number(target?.duration))&&Number(target.duration)>0&&Number.isFinite(Number(targetPeak.start))&&Number.isFinite(Number(targetPeak.end)))||Number.isFinite(aggregateNorm))&&measured.highlights.length){
                  const targetCenter=targetPeak?(Number(targetPeak.start)+Number(targetPeak.end))/2:0,actualPeak=measured.highlights[0],actualCenter=(actualPeak.start+actualPeak.end)/2
                  const targetDuration=Number(target?.duration),targetNorm=Number.isFinite(aggregateNorm)?aggregateNorm:targetCenter/Math.max(0.001,targetDuration),actualNorm=actualCenter/Math.max(0.001,duration),tolerance=0.2
                  measurements[x.id]={measured:true,pass:Math.abs(targetNorm-actualNorm)<=tolerance,target:{firstPeakNormalized:Number(targetNorm.toFixed(3))},actual:{firstPeakNormalized:Number(actualNorm.toFixed(3)),firstPeak:actualPeak},tolerance:{normalizedTimeline:tolerance},method:'ffmpeg-signals-output-retention-peak',provenance:{source:'server-render-bytes',renderHash:v.renderHash,bytesHash:sha256(bytes),duration}}
                }
              }
            }catch{/* absence remains UNKNOWN */}
            const firstSceneBoundary=cuts.length?cuts[0]:null
            for(const x of jobReferenceProfile.constraints.filter((x:any)=>x.id.endsWith(':story.opening')||x.id==='story.opening')){
              const target=Number((x.value as any)?.openingSeconds)
              if(target>0&&firstSceneBoundary!==null){
                const tolerance=Math.max(0.5,target*0.35),delta=Math.abs(firstSceneBoundary-target)
                measurements[x.id]={measured:true,pass:delta<=tolerance,target:{openingSeconds:target},actual:{firstSceneBoundary:Number(firstSceneBoundary.toFixed(3))},tolerance:{seconds:Number(tolerance.toFixed(3))},method:'ffmpeg-scene-score-output-opening-boundary',provenance:{source:'server-render-bytes',renderHash:v.renderHash,bytesHash:sha256(bytes),duration,sceneCuts:cuts.map(x=>Number(x.toFixed(3)))}}
              }
            }
            for(const x of jobReferenceProfile.constraints.filter((x:any)=>x.id.endsWith(':editing.cadence')||x.id==='editing.cadence')){
              const target=Number((x.value as any)?.meanSceneSeconds)
              if(target>0&&meanSceneSeconds){
                const tolerance=Math.max(0.75,target*0.5),delta=Math.abs(meanSceneSeconds-target)
                measurements[x.id]={measured:true,pass:delta<=tolerance,target:{meanSceneSeconds:target},actual:{meanSceneSeconds:Number(meanSceneSeconds.toFixed(3)),sceneCuts:cuts.length},tolerance:{seconds:tolerance},method:'ffmpeg-scene-score-output-cadence',provenance:{source:'server-render-bytes',renderHash:v.renderHash,bytesHash:sha256(bytes),duration,sceneCuts:cuts.map(x=>Number(x.toFixed(3)))}}
              }
            }
          }catch{/* measurement absence remains UNKNOWN, never PASS */}
          for(const x of jobReferenceProfile.constraints.filter((x:any)=>x.id.endsWith(':narration.structure')||x.id==='narration.structure')){
            const target=x.value as any,ranges=Array.isArray(target?.measuredRanges)?target.measuredRanges:[]
            if(Number(target?.duration)>0){
              try{
                const duration=Math.max(.001,Number(outputInfo.duration||1)),silent=outputInfo.hasAudio?await detectSilence(renderPath):[],silentTotal=silent.reduce((n,z)=>n+Math.max(0,z.end-z.start),0),actualRatio=outputInfo.hasAudio?Math.max(0,1-silentTotal/duration):0
                const targetDuration=Math.max(.001,Number(target?.duration||0)),targetRatio=Number.isFinite(Number(target?.audioActivityRatio))?Number(target.audioActivityRatio):Math.min(1,ranges.reduce((n:number,z:any)=>n+Math.max(0,Number(z.end)-Number(z.start)),0)/targetDuration),tolerance=.25
                measurements[x.id]={measured:true,pass:Math.abs(targetRatio-actualRatio)<=tolerance,target:{audioActivityRatio:Number(targetRatio.toFixed(3))},actual:{audioActivityRatio:Number(actualRatio.toFixed(3))},tolerance:{ratio:tolerance},method:'ffmpeg-silencedetect-output-non-silent-audio-activity-proxy',provenance:{source:'server-render-bytes',renderHash:v.renderHash,bytesHash:sha256(bytes),duration,silentRanges:silent}}
              }catch{/* remains UNKNOWN */}
            }
          }
          for(const x of jobReferenceProfile.constraints.filter((x:any)=>x.id.endsWith(':sound.structure')||x.id==='sound.structure')){
            const target=x.value as any
            if(typeof target?.hasAudio==='boolean'){
              const actualHasAudio=!!outputInfo.hasAudio
              let silentRanges:Array<{start:number;end:number}>=[]
              try{if(actualHasAudio)silentRanges=await detectSilence(renderPath)}catch{/* stays empty; audio presence remains independently probed */}
              const targetSilent=Array.isArray(target.silentRanges)?target.silentRanges:[]
              const targetSilentRatio=targetSilent.reduce((n:number,z:any)=>n+Math.max(0,Number(z.end)-Number(z.start)),0)/Math.max(0.001,Number((x.evidence?.[0] as any)?.end||outputInfo.duration||1))
              const actualSilentRatio=silentRanges.reduce((n,z)=>n+Math.max(0,z.end-z.start),0)/Math.max(0.001,Number(outputInfo.duration||1))
              const audioMatch=target.hasAudio===actualHasAudio
              const silenceMatch=!target.hasAudio||Math.abs(targetSilentRatio-actualSilentRatio)<=0.25
              measurements[x.id]={measured:true,pass:audioMatch&&silenceMatch,target:{hasAudio:target.hasAudio,silentRatio:Number(targetSilentRatio.toFixed(3))},actual:{hasAudio:actualHasAudio,silentRatio:Number(actualSilentRatio.toFixed(3))},tolerance:{silentRatio:0.25},method:'ffmpeg-probe+silencedetect-output-sound',provenance:{source:'server-render-bytes',renderHash:v.renderHash,bytesHash:sha256(bytes),duration:outputInfo.duration,silentRanges}}
            }
          }
        }
        const referenceGate = jobReferenceProfile ? evaluateReferenceConformance(jobReferenceProfile, { planReference: (planRun?.result as any)?.reference ?? null, measurements }) : null
        const publishable = gate.decision === 'PASS' && contentGate.decision === 'PASS' && (!referenceGate || referenceGate.decision === 'PASS')
        results.push({ variantId: v.variantId, label: v.label, manifestHash: v.manifestHash, renderRef: v.renderRef, renderHash: v.renderHash, duration: v.duration, contactSheetRef, posterRef, gate, contentGate, referenceGate, publishable })
      }
      for (const r of results) {
        if (r.gate.decision !== 'PASS') console.log(`[AUTO_QC] job=${job.id} variant=${r.variantId} technical=${JSON.stringify(r.gate.reasons)} failed=${JSON.stringify((r.gate as any).checks?.filter((x:any)=>x.status !== 'PASS') ?? [])}`)
        if (r.contentGate?.decision !== 'PASS') console.log(`[AUTO_QC] job=${job.id} variant=${r.variantId} content=${JSON.stringify(r.contentGate?.reasons || [])}`)
      }
      const passing = results.filter((r) => r.gate.decision === 'PASS')
      const publishable = results.filter((r) => r.publishable)
      const lead = publishable[0] ?? passing[0]
      return {
        outputRef: (lead ?? results[0]).renderRef, outputHash: (lead ?? results[0]).renderHash,
        result: { variants: results, recommendedVariantId: lead?.variantId ?? null, passing: passing.length, publishable: publishable.length, semantic: { status: semantic.status, reason: semantic.reason } },
        wait: passing.length ? undefined : 'QC_BLOCKED'
      }
    } finally { await rm(work, { recursive: true, force: true }); await file.cleanup() }
  }
}}

export const autoQcExecutor: StageExecutor = createAutoQcExecutor(null)
