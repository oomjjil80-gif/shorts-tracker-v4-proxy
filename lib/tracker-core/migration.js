// Load-time migration adapter.
//
// 원칙(사용자 확정):
// - destructive migration 금지 — 기존 필드를 지우거나 값을 덮어써 의미를 바꾸지 않는다.
// - 즉시 rewrite 금지 — 여기서 IndexedDB에 쓰기(save)를 하지 않는다. 읽어올 때마다
//   메모리 상의 객체에 누락 필드의 default만 채워 넣는다. 실제 저장은 사용자가
//   해당 에피소드를 정상적으로 편집·저장할 때 자연스럽게 새 스키마로 반영된다.
// - v1 에피소드는 formatType이 아예 없다(그 필드 자체가 v2에서 생겼기 때문) →
//   formatType이 없으면 "text_card"로 간주한다. v2에서 만든 신규 에피소드는
//   생성 시점에 이미 formatType이 박혀 있으므로 여기서 건드릴 일이 없다.

import { normalizeSeriesTypeKey } from "./seriesTypes.js";
import { dialogueUid, normalizeEpisodeLifecycle } from "./model.js";

function isNarratorSpeaker(value) {
  const s = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  return s === "나레이터" || s === "내레이터" || s === "narrator";
}

function normalizeMasterNarratorCut(cut, audioMode) {
  if (!cut || audioMode !== "master_narration" || !Array.isArray(cut.dialogueLines)) return;
  const nonEmpty = cut.dialogueLines.filter((line) => line?.text && String(line.text).trim());
  if (!nonEmpty.length || !nonEmpty.every((line) => isNarratorSpeaker(line.speaker))) return;

  // Alpha 32 — Alpha 31 Story Writer가 통합 나레이션 문장을 "나레이터" dialogueLines로
  // 저장한 Episode를 읽을 때만 메모리에서 안전하게 교정한다. DB_VERSION은 바꾸지 않고,
  // 실제 캐릭터 대사가 하나라도 섞인 CUT은 전혀 수정하지 않는다.
  if (!String(cut.narration || "").trim()) {
    cut.narration = nonEmpty.map((line) => String(line.text).trim()).join(" ");
  }
  cut.dialogueLines = cut.dialogueLines.filter((line) => !(line?.text && isNarratorSpeaker(line.speaker)));
  if (!cut.subtitle || typeof cut.subtitle !== "object") cut.subtitle = { dialogue: true, narration: true };
  cut.subtitle.narration = true;
}

export function migrateEpisode(ep) {
  if (!ep || typeof ep !== "object") return ep;

  // formatType 기본값 부여 (v1 레코드에는 이 필드가 없었음)
  if (ep.formatType !== "text_card" && ep.formatType !== "cut") {
    ep.formatType = "text_card";
  }

  // seriesType 정규화 (구 "issue"/"horror" 등 → 신규 레지스트리 키)
  ep.seriesType = normalizeSeriesTypeKey(ep.seriesType);

  if (ep.formatType === "text_card") {
    // 기존 text_card 필드가 없으면(이론상 없을 수 없지만 방어적으로) 안전한 기본값만 채움
    if (!Array.isArray(ep.scenes)) ep.scenes = [];
    if (typeof ep.narrationAudioName !== "string") ep.narrationAudioName = "";
  } else {
    // formatType === "cut"
    if (!Array.isArray(ep.cuts)) ep.cuts = [];
    if (typeof ep.globalVisualBible !== "string") ep.globalVisualBible = "";
    if (ep.styleReferenceAssetId === undefined) ep.styleReferenceAssetId = null;
    if (ep.characterReferenceAssetId === undefined) ep.characterReferenceAssetId = null;
    if (!ep.bgm || typeof ep.bgm !== "object") {
      ep.bgm = { assetId: null, start: 0, end: null, volume: 1, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", cutActions: {} };
    }
    if (!ep.bgm.cutActions || typeof ep.bgm.cutActions !== "object") ep.bgm.cutActions = {};
    // Phase 5: fadeIn/fadeOut/fadeCurve가 없던 episode(Phase 4 이전)는 "페이드 없음/linear"로
    // 안전하게 해석한다 — 기존 값을 덮어쓰지 않고, 없을 때만 채운다.
    if (typeof ep.bgm.fadeIn !== "number") ep.bgm.fadeIn = 0;
    if (typeof ep.bgm.fadeOut !== "number") ep.bgm.fadeOut = 0;
    if (typeof ep.bgm.fadeCurve !== "string") ep.bgm.fadeCurve = "linear";
    // Phase 3: 오디오를 어떻게 준비할지(파일 첨부/외부 TTS/없음) — 없던 필드면 기본값 부여.
    if (typeof ep.audioWorkflow !== "string") ep.audioWorkflow = "attach_files";
    // rc.3: Master Narration Mode(audioMode) — 이 필드가 없다는 것은 이 기능이 생기기 전에
    // 만들어진 기존 Episode라는 뜻이다. non-destructive 원칙에 따라 강제 전환하지 않고
    // "per_cut"(기존 CUT별 개별 오디오 방식)으로 채워 기존 동작을 그대로 보존한다 — 신규
    // Episode만 생성 시점에 이미 "master_narration"이 박혀 있으므로 여기서 건드릴 일이 없다.
    if (ep.audioMode !== "master_narration" && ep.audioMode !== "per_cut") ep.audioMode = "per_cut";
    if (!ep.masterNarration || typeof ep.masterNarration !== "object") {
      ep.masterNarration = { assetId: null, duration: null };
    }
    if (typeof ep.masterNarration.assetId === "undefined") ep.masterNarration.assetId = null;
    if (typeof ep.masterNarration.duration === "undefined") ep.masterNarration.duration = null;
    // Phase 4/5: 검토 완료 확인 시각 — 없던 필드면 "미검토"로 안전하게 해석.
    if (ep.timelineReviewedAt === undefined) ep.timelineReviewedAt = null;
    if (ep.previewReviewedAt === undefined) ep.previewReviewedAt = null;
    // Phase 6: production.json 렌더 기본값/생성 이력 — 없던 필드면 기본값으로 안전하게 채운다.
    if (!ep.renderSettings || typeof ep.renderSettings !== "object") {
      ep.renderSettings = { width: 1080, height: 1920, fps: 30 };
    }
    if (ep.lastProductionGeneratedAt === undefined) ep.lastProductionGeneratedAt = null;
    if (ep.lastProductionRevision === undefined) ep.lastProductionRevision = null;
    // V4 Alpha 1: 기존 Episode는 AI/Recipe 필드가 없다. 읽을 때만 안전한 기본값을 채우고
    // 즉시 IndexedDB rewrite는 하지 않는 기존 non-destructive migration 원칙을 그대로 유지한다.
    if (!ep.aiWorkspace || typeof ep.aiWorkspace !== "object") {
      ep.aiWorkspace = { contractVersion: "1.0", providerId: null, modelId: "", status: "idle", lastTaskType: null, lastRequestAt: null, lastResultAt: null, lastError: "", promptInput: "", lastResult: null };
    }
    // V4 Alpha 20: 전용 썸네일 상태 — 기존 Episode는 읽을 때만 기본값을 채운다.
    if (!ep.thumbnail || typeof ep.thumbnail !== "object") {
      ep.thumbnail = { schemaVersion: "1.0", conceptId: "auto", resolvedConceptId: ep.seriesType === "two_year_intern" ? "character_focus" : ep.seriesType === "horror" ? "curiosity" : "channel_default", customConcept: "", headline: "", subline: "", sourceCutIndex: 0, prompt: "", assetId: null, status: "planned", updatedAt: null };
    }
    if (ep.thumbnail.assetId === undefined) ep.thumbnail.assetId = null;
    if (!ep.recipeState || typeof ep.recipeState !== "object") {
      const selectedId = ep.seriesType === "horror" ? "horror_tension" : ep.seriesType === "two_year_intern" ? "two_year_intern_deadpan" : ep.seriesType === "freeform" ? "freeform_balanced" : "general_issue_fast";
      ep.recipeState = { schemaVersion: "1.0", selectedId, appliedId: null, appliedAt: null, source: "builtin" };
    }
    ep.cuts.forEach((cut, i) => {
      if (!cut) return;
      if (typeof cut.index !== "number") cut.index = i;
      if (!cut.image || typeof cut.image !== "object") {
        cut.image = { assetId: null, status: "미생성", generator: "", qcNote: "", retryReason: "" };
      }
      // Alpha 43: 기존 CUT은 video 필드가 없으므로 이미지 CUT으로 안전하게 해석한다.
      if (cut.mediaType !== "video" && cut.mediaType !== "image") cut.mediaType = "image";
      if (!cut.video || typeof cut.video !== "object") cut.video = { assetId: null, duration: null, trimStart: 0, trimEnd: null, mute: true };
      if (cut.video.assetId === undefined) cut.video.assetId = null;
      if (cut.video.duration === undefined) cut.video.duration = null;
      if (cut.video.trimStart === undefined) cut.video.trimStart = 0;
      if (cut.video.trimEnd === undefined) cut.video.trimEnd = null;
      if (cut.video.mute === undefined) cut.video.mute = true;
      if (cut.mediaType === "video" && !cut.video.assetId) cut.mediaType = "image";
      if (!Array.isArray(cut.dialogueLines)) cut.dialogueLines = [];
      normalizeMasterNarratorCut(cut, ep.audioMode);
      // Phase 2까지 만들어진 대사 행에는 안정적 id가 없었다 — non-destructive하게 부여한다.
      // (실제 저장은 여기서 하지 않는다 — 사용자가 이 에피소드를 저장할 때 자연스럽게 반영된다.)
      cut.dialogueLines.forEach((line) => {
        if (line && typeof line.id !== "string") line.id = dialogueUid();
      });
      if (!Array.isArray(cut.audioEvents)) cut.audioEvents = [];
      if (!cut.duration || typeof cut.duration !== "object") {
        cut.duration = { manual: null, measured: null, estimated: null };
      }
      if (cut.masterStart === undefined) cut.masterStart = null;
      if (!cut.motion || typeof cut.motion !== "object") {
        cut.motion = { type: "STATIC", startScale: 1, endScale: 1, panX: 0, panY: 0, easing: "linear" };
      }
      if (!cut.transition) cut.transition = "HARD_CUT";
      if (!cut.subtitle || typeof cut.subtitle !== "object") {
        cut.subtitle = { dialogue: true, narration: true };
      }
    });
  }

  // v4.1.0 Alpha 2: Alpha 1 Story Writer가 만든 CUT Episode는 date를 채우지 않아
  // 기획 완료 조건(title + date)을 영구히 만족하지 못하는 버그가 있었다. 기존 사용자가
  // 날짜를 직접 입력할 필요가 없도록, Story Writer 생성 이력이 있고 date만 비어 있는
  // Episode에 한해서 createdAt의 로컬 날짜를 메모리상 기본값으로 채운다. 기존 date 값은
  // 절대 덮어쓰지 않으며 DB_VERSION/migration rewrite도 발생시키지 않는다.
  if (!String(ep.date || "").trim() && ep.formatType === "cut" && ep.aiWorkspace?.lastTaskType === "story_draft" && ep.createdAt) {
    const created = new Date(ep.createdAt);
    ep.date = `${created.getFullYear()}.${String(created.getMonth() + 1).padStart(2, "0")}.${String(created.getDate()).padStart(2, "0")}`;
  }

  // 공통 메타 필드 누락 방어(구버전 백업 파일 등에서 비어있을 수 있음)
  if (!Array.isArray(ep.sources)) ep.sources = [];
  if (typeof ep.status !== "string") ep.status = "기획";
  // Alpha 12: 읽기 시 누락 기본값만 채우며 IndexedDB를 즉시 rewrite하지 않는다.
  ep.lifecycleStatus = normalizeEpisodeLifecycle(ep.lifecycleStatus, ep.status);
  if (ep.lifecycleChangedAt === undefined) ep.lifecycleChangedAt = ep.updatedAt || ep.createdAt || null;
  if (ep.trashedAt === undefined) ep.trashedAt = ep.lifecycleStatus === "trash" ? (ep.updatedAt || Date.now()) : null;
  // Alpha 17: 기존 Episode는 저장소 rewrite 없이 메모리에서만 안전한 기본값을 받는다.
  if (!["unassigned", "senior_longform", "economy_current", "odd_today", "sports"].includes(ep.channelKey)) ep.channelKey = "unassigned";
  if (!["shorts", "longform"].includes(ep.contentFormat)) ep.contentFormat = "shorts";
  if (!["fast", "standard", "premium"].includes(ep.productionProfile)) ep.productionProfile = "standard";
  // Alpha 24: 채널/브랜드와 소재 카테고리를 분리한다. 기존 Episode는 비파괴적으로 기본값만 받는다.
  const allowedContentCategories = new Set(["general", "economy", "housing", "work", "family", "daily_life", "society", "senior"]);
  if (!allowedContentCategories.has(ep.primaryCategory)) ep.primaryCategory = "general";
  if (!Array.isArray(ep.secondaryTags)) ep.secondaryTags = [];
  ep.secondaryTags = [...new Set(ep.secondaryTags.map((x) => String(x || "").trim()).filter(Boolean))];
  if (!["auto", "manual", "bm"].includes(ep.categorySource)) ep.categorySource = "auto";


  // V5 Alpha1 — 기존 v4 에피소드에도 자동화 계획을 비파괴적으로 추가.
  if (!ep.automationPlan || typeof ep.automationPlan !== "object") {
    ep.automationPlan = {
      schemaVersion: "1.0",
      mode: "auto_first",
      seamlessLoop: {
        enabled: true,
        requiredForEconomyShorts: true,
        openingIntent: "마지막 장면의 공간/상황과 자연스럽게 이어지는 시작",
        closingIntent: "첫 장면으로 다시 이어져도 끝/시작 경계가 튀지 않는 마무리"
      },
      longform: {
        enabled: ep.contentFormat === "longform",
        targetMinutes: 20,
        chapterCount: 7,
        visualChangeSeconds: 18,
        narrationMode: "master_narration",
        autoQc: true
      }
    };
  } else {
    ep.automationPlan.seamlessLoop = {
      enabled: ep.automationPlan?.seamlessLoop?.enabled !== false,
      requiredForEconomyShorts: true,
      openingIntent: ep.automationPlan?.seamlessLoop?.openingIntent || "마지막 장면의 공간/상황과 자연스럽게 이어지는 시작",
      closingIntent: ep.automationPlan?.seamlessLoop?.closingIntent || "첫 장면으로 다시 이어져도 끝/시작 경계가 튀지 않는 마무리"
    };
    ep.automationPlan.longform = {
      enabled: ep.contentFormat === "longform" || ep.automationPlan?.longform?.enabled === true,
      targetMinutes: Number(ep.automationPlan?.longform?.targetMinutes) || 20,
      chapterCount: Number(ep.automationPlan?.longform?.chapterCount) || 7,
      visualChangeSeconds: Number(ep.automationPlan?.longform?.visualChangeSeconds) || 18,
      narrationMode: ep.automationPlan?.longform?.narrationMode || "master_narration",
      autoQc: ep.automationPlan?.longform?.autoQc !== false,
      autoStoryboard: ep.automationPlan?.longform?.autoStoryboard !== false,
      autoTimeline: ep.automationPlan?.longform?.autoTimeline !== false,
      scenePlan: Array.isArray(ep.automationPlan?.longform?.scenePlan) ? ep.automationPlan.longform.scenePlan : []
    };
  }

  return ep;
}

export function migrateEpisodes(list) {
  return (list || []).map(migrateEpisode);
}
