// Render Manifest Compiler (P0-1)
//
// The single place where the final render specification of a Simple V2 episode is completed.
// Pure: no DOM, no IndexedDB (the asset manifest is passed in), no view state.
//
//   Episode (+ optional variantPlan)
//     -> buildProduction()                     (production.js, reused as-is)
//     -> Simple V2 production contract         (moved out of simpleAssemblyV2View.js)
//     -> source-time -> output-time conversion (generic, never episode-specific)
//     -> validation
//     -> canonical JSON -> SHA-256 manifestHash
//
// TIME CONTRACT
//   source time : seconds on the collected source video (trimStart/trimEnd, analysis events).
//   output time : seconds on the rendered timeline (cut.start + offset inside the cut).
//   Everything the renderer consumes (subtitleEvents, editorialPlan.events, sourceCallouts,
//   sourceEffectCaptions) is OUTPUT time. A plan/effect list declares `timeDomain: "source"`
//   to be converted here; without a declaration it is treated as already OUTPUT (legacy).
//
// ORDER CONTRACT
//   A variantPlan's beat order is the planned order and is never re-sorted by source time.
//   (Legacy/manual applySourceAnalysisResult keeps its sort unless preserveOrder is set.)

import { buildProduction } from "./production.js";
import { getCutGlobalRange } from "./timeline.js";
import { applySourceAnalysisResult } from "./simpleProductionV2.js";

export const RENDER_MANIFEST_SCHEMA = "render-manifest/1";
export const RENDER_COMPILER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// SHA-256 (sync, dependency-free so the compiler stays synchronous in browser and Node)
// ---------------------------------------------------------------------------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text));
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

// ---------------------------------------------------------------------------
// Canonical JSON: sorted keys, undefined dropped, non-finite numbers -> null.
// ---------------------------------------------------------------------------
export function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return "null";
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

// ---------------------------------------------------------------------------
// Source time -> output time (generic)
// ---------------------------------------------------------------------------

// segments: [{ start, duration, trimStart, trimEnd, speed? }] — one per source_video cut,
// in PLAN order (never sorted). Returns the output-time pieces covered by [srcStart, srcEnd).
// A range covered by several segments (repeat/replay) yields one piece per segment.
export function sourceRangeToOutputRanges(segments, srcStart, srcEnd) {
  const out = [];
  const s0 = Number(srcStart), s1 = Number(srcEnd);
  if (!Number.isFinite(s0) || !Number.isFinite(s1) || s1 <= s0) return out;
  for (const seg of segments || []) {
    const ts = Number(seg.trimStart), te = Number(seg.trimEnd);
    if (!Number.isFinite(ts) || !Number.isFinite(te) || te <= ts) continue;
    const speed = Number(seg.speed) > 0 ? Number(seg.speed) : 1;
    const a = Math.max(s0, ts), b = Math.min(s1, te);
    if (b <= a) continue;
    const segStart = Number(seg.start) || 0;
    out.push({ start: segStart + (a - ts) / speed, end: segStart + (b - ts) / speed });
  }
  return out;
}

// Converts a list of timed events ({start,end,...}) from source to output time.
// Events that fall in no segment are dropped and reported (never silently shifted).
export function convertEventsSourceToOutput(events, segments, dropped = []) {
  const result = [];
  (Array.isArray(events) ? events : []).forEach((event, index) => {
    const pieces = sourceRangeToOutputRanges(segments, event?.start, event?.end);
    if (!pieces.length) { dropped.push({ index, text: event?.text ?? null, start: event?.start, end: event?.end }); return; }
    pieces.forEach((p) => result.push({ ...event, start: p.start, end: p.end }));
  });
  return result;
}

function segmentsFromProductionCuts(cuts) {
  return (cuts || [])
    .filter((c) => c?.mediaType === "source_video" && c.sourceVideo)
    .map((c) => ({
      start: Number(c.start || 0), duration: Number(c.duration || 0),
      trimStart: Number(c.sourceVideo.trimStart || 0), trimEnd: Number(c.sourceVideo.trimEnd),
      speed: c.sourceVideo.speed,
    }));
}

function segmentsFromEpisodeCuts(ep) {
  const cuts = ep?.cuts || [];
  return cuts
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c?.mediaType === "source_video" && c.sourceVideo)
    .map(({ c, i }) => ({
      start: getCutGlobalRange(cuts, i).start,
      duration: getCutGlobalRange(cuts, i).duration,
      trimStart: Number(c.sourceVideo.trimStart || 0), trimEnd: Number(c.sourceVideo.trimEnd),
      speed: c.sourceVideo.speed,
    }));
}

// ---------------------------------------------------------------------------
// Source editorial plan (moved from simpleAssemblyV2View.js getSourceEditorialPlan)
// ---------------------------------------------------------------------------

// LEGACY COMPATIBILITY: sourceFirstPlan.version < 3 episodes (the early tractor/bird pilot)
// used built-in A/B/C caption presets. They are kept verbatim so those episodes render as
// before. Nothing new is added here; new episodes carry their plan as data
// (sourceEditorialPlans / variantPlan).
function legacyPresetPlan(profile, total) {
  if (profile === "A") return { headline: "저 작은 새는 왜 안 피할까?", useNarration: false, events: [{ start: 0, end: 1.8, text: "바퀴가 코앞인데…" }, { start: 5.8, end: 7.2, text: "이유는 바로 아래에 있었다" }, { start: 7.2, end: 9.5, text: "알 두 개" }, { start: 10.0, end: 12.6, text: "농부도 그제야 알아챘다" }, { start: 12.8, end: 15.5, text: "둥지를 피해 길을 바꾼다" }, { start: 16.8, end: total, text: "그리고 다시 돌아온 어미 새" }], callouts: [{ start: 2.15, end: 3.75, text: "멈춰!! 멈추라고....", rotateDeg: -4, suppressSubtitle: true }, { start: 3.9, end: 5.75, text: "차라리 날 밟고 가라!!", rotateDeg: 2.5, suppressSubtitle: true }] };
  if (profile === "B") return { headline: "트랙터 앞을 막아선 작은 새", useNarration: false, events: [{ start: 0, end: 4, text: "도망가지 않았다" }, { start: 4, end: 7, text: "오히려 더 가까이 막아섰다" }, { start: 7, end: 10, text: "이유는 바로 아래에 있었다" }, { start: 10, end: Math.max(10, total - 4), text: "농부는 둥지를 피해 갔다" }, { start: Math.max(10, total - 4), end: total, text: "마지막까지 지켜낸 자리" }] };
  return { headline: "왜 저러는 걸까?", useNarration: false, events: [{ start: 0, end: 4, text: "잠깐… 안 비킨다고?" }, { start: 4, end: 7, text: "STOP!" }, { start: 7, end: 10, text: "알 두 개 🥚🥚" }, { start: 10, end: Math.max(10, total - 4), text: "이제야 이해한 농부" }, { start: Math.max(10, total - 4), end: total, text: "무사 귀환" }] };
}

// Returns the editorial plan in OUTPUT time. Never returns (or mutates) episode-owned objects.
export function resolveSourceEditorialPlan(ep, total, { segments = null } = {}) {
  if (!ep?.simpleProductionV2?.sourceFirst) return { headline: "", events: [], callouts: [], useNarration: true };
  const profile = ep.simpleProductionV2.sourceRenderProfile || "A";
  const saved = ep.simpleProductionV2.sourceEditorialPlans?.[profile];
  const planVersion = Number(ep.sourceFirstPlan?.version || 0);
  let plan;
  if (saved) plan = clone(saved);
  else if (planVersion >= 3) plan = { headline: "", events: [], callouts: [], useNarration: false };
  else plan = legacyPresetPlan(profile, total);

  if (plan.timeDomain === "source") {
    const segs = segments || segmentsFromEpisodeCuts(ep);
    const dropped = [];
    plan.events = convertEventsSourceToOutput(plan.events, segs, dropped);
    plan.callouts = convertEventsSourceToOutput(plan.callouts, segs, dropped);
    plan.droppedEvents = dropped;
    plan.timeDomain = "output";
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Simple V2 production contract (moved from simpleAssemblyV2View.js simpleProduction /
// applySourceEditorialPlan). Mutates only the freshly built `production`.
// ---------------------------------------------------------------------------
function applySimpleV2Contract(ep, production, warnings) {
  production.episode.productionWorkflow = "simple_v2";
  production.episode.newsInfoCardEnabled = false;
  production.renderSettings = ep.contentFormat === "longform" ? { width: 1920, height: 1080, fps: 30 } : { width: 1080, height: 1920, fps: 30 };
  production.subtitleEvents = [];
  (production.cuts || []).forEach((cut) => {
    cut.newsCard = null;
    cut.economyVisualAid = null;
    if (cut.subtitle) { cut.subtitle.narration = false; cut.subtitle.dialogue = false; }
  });
  if (ep.simpleProductionV2?.sourceFirst !== true) return production;

  production.episode.sourceFirst = true;
  const src = (production.cuts || []).filter((c) => c?.mediaType === "source_video");
  production.sourceRenderDiagnostics = {
    sourceFirst: true, sourceCutCount: src.length,
    sourceCuts: src.map((c) => ({ id: c.id, start: c.start, duration: c.duration, blobPath: !!c.sourceVideo?.blobPath, url: !!c.sourceVideo?.url, mute: c.sourceVideo?.mute })),
  };

  const segments = segmentsFromProductionCuts(production.cuts);
  const total = Number(production.totalDuration || 0);
  const profile = ep.simpleProductionV2.sourceRenderProfile || "A";
  const plan = resolveSourceEditorialPlan(ep, total, { segments });
  (plan.droppedEvents || []).forEach((d) => warnings.push({ severity: "warning", code: "event-outside-segments", message: `원본 시간 ${d.start}~${d.end}초 이벤트가 사용된 구간에 없어 제외됨${d.text ? `: ${d.text}` : ""}` }));

  production.editorialPlan = { version: "SOURCE-EDITORIAL-1", profile, headline: plan.headline || "", events: plan.events || [], useNarration: plan.useNarration !== false };
  production.subtitleEvents = (plan.events || []).map((e, i) => ({ id: `editorial-${i + 1}`, start: Number(e.start || 0), end: Number(e.end || 0), text: String(e.text || ""), kind: "editorial" }));
  production.captionStyle = { ...(production.captionStyle || {}), topPct: 72, fontSizePct: 4.6, maxWidthPct: 82, fontWeight: 800, backgroundBox: true, backgroundOpacity: 0.58 };
  const planVersion = Number(ep.sourceFirstPlan?.version || 0);
  if (planVersion >= 3) production.sourceCallouts = plan.callouts || [];
  else if (profile === "A") {
    // LEGACY COMPATIBILITY (sourceFirstPlan.version < 3, profile A): styled callouts.
    production.sourceCallouts = [{ start: 2.15, end: 3.75, text: "멈춰!! 멈추라고....", color: "#FFD928", xPct: 48, yPct: 34, rotateDeg: -4, mark: "shock", suppressSubtitle: true }, { start: 3.9, end: 5.75, text: "차라리 날 밟고 가라!!", color: "#FFD928", xPct: 47, yPct: 33, rotateDeg: 2.5, mark: "anger", suppressSubtitle: true }];
  }

  // Effect captions: buildProduction copies sourceFirstPlan.effectCaptions as-is. Convert only
  // when the plan declares them as source time; undeclared lists stay output time (legacy).
  if (ep.sourceFirstPlan?.effectCaptionsTimeDomain === "source") {
    const dropped = [];
    production.sourceEffectCaptions = convertEventsSourceToOutput(production.sourceEffectCaptions, segments, dropped);
    dropped.forEach((d) => warnings.push({ severity: "warning", code: "event-outside-segments", message: `효과 자막(원본 ${d.start}~${d.end}초)이 사용된 구간에 없어 제외됨${d.text ? `: ${d.text}` : ""}` }));
  }

  production.bgm = null;
  production.audioPolicy = clone(plan.audioPolicy || { bgm: 'off', sfx: 'off' });
  (production.cuts || []).forEach((cut) => { if (cut.mediaType === "source_video" && cut.sourceVideo) { cut.sourceVideo.volume = 1; cut.sourceVideo.mute = false; } });
  if (plan.useNarration === false) {
    production.audioMode = "none";
    production.masterNarration = null;
    (production.cuts || []).forEach((cut) => { cut.audioEvents = []; if (cut.mediaType === "source_video" && cut.sourceVideo) cut.sourceVideo.mute = false; });
  }
  return production;
}

// ---------------------------------------------------------------------------
// Validation of the finished production (output-time invariants)
// ---------------------------------------------------------------------------
export function validateRenderProduction(production) {
  const issues = [];
  const total = Number(production?.totalDuration || 0);
  const err = (code, message) => issues.push({ severity: "error", code, message });
  if (!(total > 0)) err("no-duration", "전체 출력 길이가 0입니다.");
  const inRange = (label, list) => (list || []).forEach((e, i) => {
    const s = Number(e?.start), t = Number(e?.end);
    if (!Number.isFinite(s) || !Number.isFinite(t) || t <= s) err("bad-time-range", `${label} #${i + 1} 시간 범위가 잘못됨 (${e?.start}~${e?.end})`);
    else if (s < 0 || t > total + 1e-6) err("event-outside-output", `${label} #${i + 1}(${e?.text ?? ""})이 출력 길이(${total}s) 밖입니다 (${s}~${t})`);
  });
  inRange("subtitle", production?.subtitleEvents);
  inRange("effectCaption", production?.sourceEffectCaptions);
  inRange("callout", production?.sourceCallouts);
  (production?.cuts || []).forEach((c, i) => {
    if (c?.mediaType === "source_video" && !(Number(c.sourceVideo?.trimEnd) > Number(c.sourceVideo?.trimStart || 0))) err("bad-trim", `CUT ${i + 1} trim 범위가 잘못됨`);
    if (c?.mediaType === "source_video" && !c.sourceVideo?.sourceAssetId && !c.sourceVideo?.blobPath && !c.sourceVideo?.url) err("no-source-identity", `CUT ${i + 1} 원본 식별자가 없음`);
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Hash payload: everything render-relevant, nothing volatile.
//   excluded: generatedAt, generatedBy, revision (timestamps + legacy fnv fingerprint),
//             sourceRenderDiagnostics (diagnostic booleans), signed playback URLs.
//   A source URL is only kept as identity when the cut has neither sourceAssetId nor blobPath.
// ---------------------------------------------------------------------------
const VOLATILE_SOURCE_KEYS = ["url", "playbackUrl", "blobUrl", "playbackValidUntil"];

export function manifestPayloadFromProduction(production) {
  const payload = clone(production);
  delete payload.generatedAt;
  delete payload.generatedBy;
  delete payload.revision;
  delete payload.sourceRenderDiagnostics;
  (payload.cuts || []).forEach((cut) => {
    const sv = cut?.sourceVideo;
    if (!sv) return;
    const stable = !!(sv.sourceAssetId || sv.blobPath);
    VOLATILE_SOURCE_KEYS.forEach((k) => { if (k === "url" && !stable) return; delete sv[k]; });
  });
  return payload;
}

export function hashProduction(production) {
  const payload = manifestPayloadFromProduction(production);
  return sha256Hex(canonicalize({ schema: RENDER_MANIFEST_SCHEMA, production: payload }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// compileRenderManifest({ episode, assetManifestResult, variantPlan?, now? })
//   variantPlan (optional, planned order preserved):
//     { profile?, timeDomain?: "source"|"output" (effectCaptions),
//       beats: [{label,narration,trimStart,trimEnd}], effectCaptions?,
//       headline?, events?, callouts?, plansTimeDomain?: "source"|"output" }
//   The episode passed in is never mutated.
export function compileRenderManifest({ episode, assetManifestResult = { manifest: [] }, variantPlan = null, now = 0 } = {}) {
  if (!episode) throw new Error("compileRenderManifest: episode가 필요합니다.");
  const ep = variantPlan ? clone(episode) : episode;
  const warnings = [];

  if (variantPlan) {
    const profile = variantPlan.profile || ep.simpleProductionV2?.sourceRenderProfile || "A";
    applySourceAnalysisResult(ep, { beats: variantPlan.beats, effectCaptions: variantPlan.effectCaptions, timeDomain: variantPlan.timeDomain }, { preserveOrder: true });
    ep.simpleProductionV2.sourceRenderProfile = profile;
    // A compile of a plan must be reproducible: the random ids/dates newEpisode()/newCut() mint
    // must not leak into the hash. Ids derive from the plan position (or variantPlan.episodeId).
    if (variantPlan.episodeId) ep.id = String(variantPlan.episodeId);
    ep.date = "";
    (ep.cuts || []).forEach((cut, i) => { cut.id = `cut_${i + 1}`; });
    ep.simpleProductionV2.sourceEditorialPlans = {
      ...(ep.simpleProductionV2.sourceEditorialPlans || {}),
      [profile]: {
        headline: variantPlan.headline || "", events: clone(variantPlan.events || []), callouts: clone(variantPlan.callouts || []),
        useNarration: false, timeDomain: variantPlan.plansTimeDomain === "source" ? "source" : "output",
      },
    };
  }

  const production = applySimpleV2Contract(ep, buildProduction(ep, assetManifestResult, { now }), warnings);
  const issues = [...validateRenderProduction(production), ...warnings];

  const payload = manifestPayloadFromProduction(production);
  const manifestHash = sha256Hex(canonicalize({ schema: RENDER_MANIFEST_SCHEMA, production: payload }));

  // Volatile playback URLs are not part of the immutable payload; they travel separately so
  // the (mutable) render copy can still play the source.
  const sourceUrls = (production.cuts || []).map((cut) => {
    const sv = cut?.sourceVideo;
    return sv ? Object.fromEntries(VOLATILE_SOURCE_KEYS.filter((k) => sv[k] !== undefined).map((k) => [k, sv[k]])) : null;
  });

  return deepFreeze({
    schema: RENDER_MANIFEST_SCHEMA,
    compilerVersion: RENDER_COMPILER_VERSION,
    manifestHash,
    ok: !issues.some((i) => i.severity === "error"),
    issues,
    payload,
    runtime: { sourceUrls, sourceRenderDiagnostics: production.sourceRenderDiagnostics || null, envelope: clone({ generatedAt: production.generatedAt, generatedBy: production.generatedBy, revision: production.revision }) },
  });
}

// A fresh, mutable production for the Preview/Renderer. Mutating it (e.g. refreshing signed
// URLs) cannot change the manifest; verifyProductionMatchesManifest() proves it before render.
export function getRenderProduction(manifest) {
  const production = clone(manifest.payload);
  (production.cuts || []).forEach((cut, i) => {
    const urls = manifest.runtime?.sourceUrls?.[i];
    if (urls && cut.sourceVideo) Object.assign(cut.sourceVideo, urls);
  });
  if (manifest.runtime?.sourceRenderDiagnostics) production.sourceRenderDiagnostics = clone(manifest.runtime.sourceRenderDiagnostics);
  Object.assign(production, clone(manifest.runtime?.envelope || {}));
  production.manifestHash = manifest.manifestHash;
  return production;
}

export function verifyProductionMatchesManifest(manifest, production) {
  const p = { ...production };
  delete p.manifestHash;
  const actual = hashProduction(p);
  if (actual !== manifest.manifestHash) {
    throw new Error(`RenderManifest 불일치: 컴파일 이후 production이 변경되었습니다 (${manifest.manifestHash.slice(0, 12)} ≠ ${actual.slice(0, 12)}). 렌더를 차단했습니다.`);
  }
  return true;
}
