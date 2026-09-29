// Job COMPILE contract (P0-2). Pure and shared verbatim with the server Worker (see
// tools/tracker-core.manifest.json): the frontend and the Worker MUST produce the same
// manifestHash for the same JobPlan.
//
// JobPlan (stored as plan revision N in private Blob, never inside the Episode):
//   { schema: "job-plan/1", profile: "source_shorts", sourceAssetId,
//     variantPlan: { profile?, beats[], effectCaptions?, headline?, events?, callouts?,
//                    timeDomain?, plansTimeDomain? } }
// SourceAsset (from the Source Registry): { sourceAssetId, blobPath, sha256, duration, ... }

import { newEpisode } from "./model.js";
import { ensureSimpleProductionV2 } from "./simpleProductionV2.js";
import { compileRenderManifest } from "./renderManifest.js";

export const JOB_PLAN_SCHEMA = "job-plan/1";
export const VIRTUAL_EPISODE_ID = "virtual_source_episode";
export const JOB_PROFILES = Object.freeze(["source_shorts"]);

// Stable identity of every source the manifest depends on. Signed playback URLs are never identity.
export function sourceIdentityFromManifest(manifest) {
  const seen = new Map();
  for (const cut of manifest.payload.cuts || []) {
    const sv = cut?.sourceVideo;
    if (!sv) continue;
    const key = `${sv.sourceAssetId || ""}|${sv.blobPath || ""}`;
    if (!seen.has(key)) seen.set(key, { sourceAssetId: sv.sourceAssetId || null, blobPath: sv.blobPath || null, sha256: sv.sha256 || null });
  }
  return [...seen.values()];
}

export function buildVirtualSourceEpisode({ jobId, profile = "source_shorts", sourceAsset }) {
  if (!JOB_PROFILES.includes(profile)) throw new Error(`알 수 없는 Job profile: ${profile}`);
  if (!jobId) throw new Error("jobId가 필요합니다.");
  if (!sourceAsset?.sourceAssetId) throw new Error("sourceAsset.sourceAssetId가 필요합니다.");
  const ep = newEpisode("general_issue", "cut");
  ep.id = String(jobId);
  ep.contentFormat = "shorts";
  ep.channelKey = "unassigned";
  ep.title = "";
  ep.date = "";
  ensureSimpleProductionV2(ep);
  const s = ep.simpleProductionV2;
  const media = {
    sourceAssetId: sourceAsset.sourceAssetId,
    blobPath: sourceAsset.blobPath || "",
    duration: Number(sourceAsset.duration) > 0 ? Number(sourceAsset.duration) : undefined,
    ...(sourceAsset.sha256 ? { sha256: String(sourceAsset.sha256) } : {}),
    ...(sourceAsset.width ? { width: sourceAsset.width } : {}),
    ...(sourceAsset.height ? { height: sourceAsset.height } : {}),
  };
  s.sourceFirst = true;
  s.sourceAssetId = media.sourceAssetId;
  s.sourceMedia = media;
  ep.sourceFirstPlan = { version: 3, analysisStatus: "ready", sourceAssetId: media.sourceAssetId, sourceMedia: { ...media }, beats: [] };
  return ep;
}

// -> RenderManifest (frozen) + identity list. Throws on an invalid plan.
export function compileJobPlan({ jobId, plan, sourceAsset, assetManifestResult = { manifest: [] } }) {
  if (plan?.schema !== JOB_PLAN_SCHEMA) throw new Error(`지원하지 않는 plan schema: ${plan?.schema}`);
  if (plan.sourceAssetId !== sourceAsset?.sourceAssetId) throw new Error("plan.sourceAssetId와 sourceAsset이 일치하지 않습니다.");
  const episode = buildVirtualSourceEpisode({ jobId, profile: plan.profile, sourceAsset });
  // The manifest is a render spec, not a job record: the episode id is constant so the same plan + source
  // yields the same manifestHash in every job (lets renders be cached/deduplicated by hash).
  const manifest = compileRenderManifest({ episode, assetManifestResult, variantPlan: { ...plan.variantPlan, episodeId: VIRTUAL_EPISODE_ID } });
  return { manifest, identity: sourceIdentityFromManifest(manifest) };
}
