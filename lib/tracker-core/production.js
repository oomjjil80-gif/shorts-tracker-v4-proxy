// Phase 6 — production.json 생성 도메인 모듈.
//
// 이 화면(cutExportStep.js)이 직접 production.json을 조립하지 않는다 — "View 안에 조립 로직을
// 작성하지 마세요"라는 조건에 따라 전부 여기서만 만든다. View는 이 모듈이 반환한 결과를
// 표시/복사/다운로드만 한다.
//
// 핵심 원칙(조건 28번, "Timeline = Preview = production.json"):
// - 시간 계산은 절대 여기서 다시 만들지 않는다 — timeline.js(getCutGlobalRange/getEpisodeDuration/
//   buildTimeline)를 그대로 재사용한다. Preview가 재생하는 값과 production.json에 찍히는 값이
//   서로 다른 계산 경로를 타면 "명세와 실제가 다르다"는 최악의 결과가 되기 때문이다.
// - Preview/QC(qc.js)의 규칙도 새로 만들지 않는다 — getQcResults()를 그대로 재사용하고,
//   Phase 6에서만 필요한(실제 asset 존재 검증 등) 규칙만 얹는다.
// - production.json은 Tracker 내부 데이터 모델(JSON.stringify(episode))이 아니다 — 내부 필드명이
//   나중에 바뀌어도 Renderer 계약이 불필요하게 깨지지 않도록, 아래 buildCutSchema/buildAudioEventSchema
//   등 명시적 매핑 함수를 항상 거친다.

import { getAsset } from "./db.js";
import { getMasterStart, resolveCaptionStyle } from "./model.js";
import { getCutGlobalRange, getEpisodeDuration, buildTimeline, describeCutDuration } from "./timeline.js";
import { getQcResults, QC_SEVERITY } from "./qc.js";
import { PRODUCTION_SCHEMA_VERSION, APP_VERSION as APP_VERSION_SSOT } from "./version.js";

// Phase 7: 버전 문자열은 js/version.js가 유일한 소스다 — 여기서 다시 리터럴로 적지 않는다.
// export 이름은 기존 호출부(cutExportStep.js, 테스트)와의 호환을 위해 그대로 유지한다.
export const SCHEMA_VERSION = PRODUCTION_SCHEMA_VERSION;
export const APP_VERSION = APP_VERSION_SSOT;

// 향후 사용자가 직접 바꿀 수 있는 화면이 생기더라도(Phase 6 범위 밖) episode.renderSettings가
// 이미 있으면 그 값을 우선한다 — 지금은 이 기본값만 실제로 쓰인다.
export const DEFAULT_RENDER_SETTINGS = { width: 1080, height: 1920, fps: 30 };
export const RENDER_PRESETS = [
  { id: "vertical_720p", label: "9:16 · 720 × 1280", width: 720, height: 1280 },
  { id: "vertical_1080p", label: "9:16 · 1080 × 1920 (권장)", width: 1080, height: 1920 },
  { id: "landscape_720p", label: "16:9 · 1280 × 720", width: 1280, height: 720 },
  { id: "landscape_1080p", label: "16:9 · 1920 × 1080 (권장)", width: 1920, height: 1080 },
];
export const RENDER_FPS_OPTIONS = [24, 30, 60];

export function normalizeRenderSettings(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const width = Number(input.width);
  const height = Number(input.height);
  const fps = Number(input.fps);
  const preset = RENDER_PRESETS.find((p) => p.width === width && p.height === height) || RENDER_PRESETS[1];
  return {
    width: preset.width,
    height: preset.height,
    fps: RENDER_FPS_OPTIONS.includes(fps) ? fps : DEFAULT_RENDER_SETTINGS.fps,
  };
}

export function getRendererReadiness(production) {
  const checks = [];
  const add = (ok, label, detail = "") => checks.push({ ok: !!ok, label, detail });
  const rs = normalizeRenderSettings(production?.renderSettings);
  add((rs.width * 16) === (rs.height * 9) || (rs.width * 9) === (rs.height * 16), "지원 렌더 규격", `${rs.width}×${rs.height}`);
  add(RENDER_FPS_OPTIONS.includes(rs.fps), "지원 FPS", `${rs.fps}fps`);
  add(!!production?.captionStyle, "자막 스타일 계약", production?.captionStyle ? "production.json 포함" : "누락");
  add((production?.cuts || []).length > 0, "CUT 데이터", `${(production?.cuts || []).length}개`);
  add(Number(production?.totalDuration) > 0, "전체 길이", `${Number(production?.totalDuration || 0).toFixed(2)}초`);
  const broken = (production?.assets || []).filter((a) => a.broken).length;
  add(broken === 0, "미디어 참조", broken ? `깨진 asset ${broken}개` : `${(production?.assets || []).length}개 정상`);
  return { ready: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// 파일명 — Renderer가 어떤 OS/파일시스템에서 실행되어도 안전하게 쓸 수 있는 이름을 만든다.
// ---------------------------------------------------------------------------

const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
};

export function extFromMime(mimeType, fallbackName) {
  if (mimeType && EXT_BY_MIME[mimeType]) return EXT_BY_MIME[mimeType];
  const m = /\.([a-zA-Z0-9]+)$/.exec(fallbackName || "");
  if (m) return m[1].toLowerCase();
  return "bin";
}

// 경로 구분자·제어문자 등 파일시스템에 위험한 문자만 제거하고, 한글/영문/숫자는 그대로 둔다.
// 공백은 밑줄로 치환한다(공백이 포함된 파일명은 일부 Renderer/커맨드라인 도구에서 다루기 번거롭다).
export function sanitizeFilename(name, fallback = "asset") {
  let s = String(name ?? "").trim();
  s = s.replace(/[\/\\:*?"<>|]/g, "");
  s = s.replace(/[\x00-\x1f]/g, "");
  s = s.replace(/\s+/g, "_");
  s = s.replace(/^\.+/, "");
  s = s.slice(0, 80);
  return s || fallback;
}

// content_issue의 slug()와 동일한 규칙(한글/영문/숫자만 남기고 나머지는 밑줄) — 두 Export
// 화면이 파일명 만드는 방식을 다르게 두지 않기 위해 같은 규칙을 여기서도 그대로 쓴다.
function slugTitle(s) {
  return (s || "episode").replace(/[^\w가-힣]+/g, "_").slice(0, 40);
}

export function productionFilename(episode) {
  return `production_${slugTitle(episode?.title)}.json`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function buildFilename(usage, ext) {
  switch (usage.usage) {
    case "cutImage":
      return `cut${pad2(usage.cutNumber)}.${ext}`;
    case "styleReference":
      return `style_reference.${ext}`;
    case "characterReference":
      return `character_reference.${ext}`;
    case "bgm":
      return `bgm.${ext}`;
    case "masterNarration":
      return `master_narration.${ext}`;
    case "audioEvent": {
      const n = pad2(usage.cutNumber);
      if (usage.eventType === "narration") return `cut${n}_narration.${ext}`;
      if (usage.eventType === "dialogue") {
        const tag = sanitizeFilename(usage.speaker, "").toLowerCase() || "dialogue";
        return `cut${n}_dialogue_${tag}.${ext}`;
      }
      if (usage.eventType === "sfx") {
        const tag = sanitizeFilename(usage.name, "").toLowerCase() || "sfx";
        return `cut${n}_sfx_${tag}.${ext}`;
      }
      return `cut${n}_audio.${ext}`;
    }
    default:
      return `asset.${ext}`;
  }
}

function audioTypeLabel(type) {
  return { narration: "나레이션", dialogue: "대사", sfx: "SFX", silence: "정적" }[type] || "오디오";
}

function usageLabel(ref) {
  if (ref.usage === "cutImage") return `CUT ${ref.cutNumber} 이미지`;
  if (ref.usage === "audioEvent") return `CUT ${ref.cutNumber} ${audioTypeLabel(ref.eventType)}`;
  if (ref.usage === "bgm") return "BGM";
  if (ref.usage === "masterNarration") return "마스터 나레이션";
  if (ref.usage === "styleReference") return "스타일 레퍼런스";
  if (ref.usage === "characterReference") return "캐릭터 레퍼런스";
  return "asset";
}

function stepHintForUsage(usage) {
  if (usage === "cutImage" || usage === "styleReference" || usage === "characterReference") return "cutImages";
  return "cutAudio";
}

// ---------------------------------------------------------------------------
// 1) episode가 실제로 참조하는 asset 목록 수집 — "사용하지 않는 고아 Asset은 넣지 않는다"는
//    조건을 지키기 위해, episode 데이터를 훑어서 실제로 참조되는 assetId만 모은다.
// ---------------------------------------------------------------------------

function resolveDialogueSpeaker(cut, evt) {
  const line = (cut.dialogueLines || []).find((l) => l.id === evt.sourceDialogueId);
  return (line && line.speaker) || "";
}

export function collectAssetUsages(episode) {
  const usages = [];
  if (!episode) return usages;
  if (episode.styleReferenceAssetId) {
    usages.push({ assetId: episode.styleReferenceAssetId, kind: "image", usage: "styleReference" });
  }
  if (episode.characterReferenceAssetId) {
    usages.push({ assetId: episode.characterReferenceAssetId, kind: "image", usage: "characterReference" });
  }
  if (episode.bgm && episode.bgm.assetId) {
    usages.push({ assetId: episode.bgm.assetId, kind: "audio", usage: "bgm" });
  }
  // rc.3(Master Narration Mode) — 마스터 나레이션 파일도 다른 asset과 똑같이 "실제로
  // 참조되는 asset"으로 등록해야 한다. 이걸 빼먹으면 (1) production.json의 asset manifest에
  // 이 파일이 아예 빠져 Renderer가 받을 수 없고, (2) Data Health Check/findOrphanAssets가
  // 이 파일을 "아무도 참조하지 않는 고아 asset"으로 잘못 판단하게 된다.
  if (episode.audioMode === "master_narration" && episode.masterNarration && episode.masterNarration.assetId) {
    usages.push({
      assetId: episode.masterNarration.assetId,
      kind: "audio",
      usage: "masterNarration",
      sourceDuration: episode.masterNarration.duration ?? null,
    });
  }
  (episode.cuts || []).forEach((cut, i) => {
    const n = i + 1;
    if (cut.image && cut.image.assetId) {
      usages.push({ assetId: cut.image.assetId, kind: "image", usage: "cutImage", cutIndex: i, cutId: cut.id, cutNumber: n });
    }
    if (cut.video && cut.video.assetId) {
      usages.push({ assetId: cut.video.assetId, kind: "video", usage: "cutVideo", cutIndex: i, cutId: cut.id, cutNumber: n });
    }
    (cut.audioEvents || []).forEach((evt) => {
      if (!evt.assetId) return;
      // rc.4(코드 리뷰 수정) — master_narration 모드에서 CUT별 narration audioEvent는
      // "DB에는 보존하지만 production에는 활성 asset으로 내보내지 않는" 비활성 데이터다
      // (timeline.js의 VOICE 트랙 필터링과 동일한 원칙). 여기서 제외해야 asset manifest에도
      // 빠지고(MN-25), 아래 buildCutSchema()가 만드는 CUT audioEvents 목록에서도 이 이벤트
      // 자체가 함께 빠지므로(같은 필터를 buildCutSchema에도 적용) validateProduction()의
      // "manifest에 없는 asset 참조" 오탐도 생기지 않는다. per_cut으로 되돌아가면 이 필터가
      // 그냥 통과하지 않게 되어(else 분기) 다시 정상적으로 활성 usage로 잡힌다 — episode 데이터
      // 자체는 이 필터링 동안 한 번도 수정되지 않는다.
      if (episode.audioMode === "master_narration" && evt.type === "narration") return;
      usages.push({
        assetId: evt.assetId,
        kind: "audio",
        usage: "audioEvent",
        cutIndex: i,
        cutId: cut.id,
        cutNumber: n,
        eventId: evt.id,
        eventType: evt.type,
        speaker: evt.type === "dialogue" ? resolveDialogueSpeaker(cut, evt) || evt.speaker || "" : "",
        name: evt.type === "sfx" ? evt.name || "" : "",
        sourceDuration: evt.sourceDuration ?? evt.duration ?? null,
      });
    });
  });
  return usages;
}

// ---------------------------------------------------------------------------
// 2) 실제 IndexedDB assets store를 조회해 asset manifest를 만든다(조건 6, 7).
//    qc.js는 동기 구조상 "assetId 필드가 있는가"만 본다 — 여기서는 그 assetId가 실제로
//    Blob과 함께 저장돼 있는지까지 실제로 조회해서 검증한다(broken reference 발견).
// ---------------------------------------------------------------------------

export async function loadAssetManifest(episode) {
  const usages = collectAssetUsages(episode);
  const firstUsageById = new Map();
  usages.forEach((u) => {
    if (!firstUsageById.has(u.assetId)) firstUsageById.set(u.assetId, u);
  });

  const usedNames = new Set();
  const manifest = [];
  const brokenRefs = [];

  for (const [assetId, usage] of firstUsageById) {
    let asset = null;
    try {
      asset = await getAsset(assetId);
    } catch (e) {
      asset = null;
    }
    const broken = !asset || !asset.blob;
    if (broken) {
      usages.filter((u) => u.assetId === assetId).forEach((u) => brokenRefs.push(u));
    }

    const mimeType = asset?.mimeType || null;
    const ext = extFromMime(mimeType, asset?.originalFileName);
    let filename = broken ? null : buildFilename(usage, ext);
    if (filename) {
      let unique = filename;
      let suffix = 2;
      while (usedNames.has(unique)) {
        const dot = filename.lastIndexOf(".");
        unique = dot > -1 ? `${filename.slice(0, dot)}_${suffix}${filename.slice(dot)}` : `${filename}_${suffix}`;
        suffix++;
      }
      filename = unique;
      usedNames.add(filename);
    }

    const entry = {
      id: assetId,
      kind: usage.kind,
      filename,
      mimeType,
      size: asset?.sizeBytes ?? null,
    };
    if (usage.kind === "audio") entry.duration = usage.sourceDuration ?? null;
    if (broken) entry.broken = true;
    manifest.push(entry);
  }

  return { manifest, brokenRefs, usages };
}

// ---------------------------------------------------------------------------
// 3) production.json 조립 — 순수 함수(비동기/DB 조회 없음). assetManifestResult는
//    loadAssetManifest()가 미리 계산해 넘겨준 결과를 그대로 받는다.
// ---------------------------------------------------------------------------

function buildAudioEventSchema(evt, cut, cutGlobalStart) {
  const cutRelativeStart = evt.start || 0;
  const base = {
    id: evt.id,
    type: evt.type,
    assetId: evt.assetId || null,
    cutRelativeStart,
    globalStart: cutGlobalStart + cutRelativeStart,
    duration: evt.duration ?? 0,
    volume: evt.volume ?? 1,
    fadeIn: evt.fadeIn || 0,
    fadeOut: evt.fadeOut || 0,
  };
  if (evt.type === "narration") {
    // Subtitle과 동일한 원칙 — 원문은 항상 Story(cut.narration)에서 읽는다. audioEvent에
    // 남아있을 수 있는 옛 evt.text는 신뢰하지 않는다(Phase 5 원칙을 Phase 6에도 그대로 적용).
    base.text = cut.narration || "";
  } else if (evt.type === "dialogue") {
    const line = (cut.dialogueLines || []).find((l) => l.id === evt.sourceDialogueId);
    base.speaker = (line && line.speaker) || evt.speaker || "";
    base.text = (line && line.text) || "";
    base.sourceDialogueId = evt.sourceDialogueId || null;
  } else if (evt.type === "sfx") {
    base.name = evt.name || "";
  }
  return base;
}

function compactNewsText(text, max = 34) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + "…";
}

function deriveNewsCard(cut, i, channelKey) {
  if (channelKey !== "economy_current") return null;

  const narration = String(cut?.narration || "").replace(/\s+/g, " ").trim();
  const rawSituation = String(cut?.situation || "").replace(/\s+/g, " ").trim();
  const purpose = String(cut?.purpose || "").replace(/\s+/g, " ").trim();

  // Preview와 동일하게 내부 메타(scene:/top:)는 최종 영상 문구에 노출하지 않는다.
  const situationParts = rawSituation
    .split("·")
    .map((x) => x.trim())
    .filter(Boolean);
  const topPart = situationParts.find((x) => /^top:/i.test(x));
  const importedTopKey = topPart ? topPart.replace(/^top:/i, "").trim() : "";
  const publicSituation = situationParts
    .filter((x) => !/^scene:/i.test(x) && !/^top:/i.test(x))
    .join(" · ")
    .trim();

  let keyInfo = importedTopKey;
  if (/12\s*억/.test(narration)) keyInfo = "기본공제 12억원 유지";
  else if (/150\s*%/.test(narration)) keyInfo = "세부담 상한 150% 유지";
  else if (/ISA/i.test(narration) && /(계약기간|납입한도)/.test(narration)) keyInfo = "ISA 계약기간·납입한도 현행 유지";
  else if (/국회/.test(narration)) keyInfo = "정부안 확정 · 국회 심사 예정";
  else if (/29일|한 달/.test(narration) && /(뒤집|수정)/.test(narration)) keyInfo = "29일 만에 정책 방향 재수정";
  else if (!keyInfo) {
    const numberHit = narration.match(/(?:\d[\d,.]*\s*(?:원|만원|억원|조원|%|퍼센트|년|개월|일|배|명|건|가구|세|억|조)|ISA|종부세|부가세|소득세|법인세|금리|물가|세율|공제|한도|예산)/i);
    if (numberHit) {
      const at = narration.indexOf(numberHit[0]);
      keyInfo = compactNewsText(
        narration.slice(Math.max(0, at - 11), Math.min(narration.length, at + numberHit[0].length + 17)).trim(),
        36
      );
    } else {
      const firstSentence = narration.split(/[.!?。]/)[0] || narration;
      keyInfo = compactNewsText(firstSentence, 32);
    }
  }

  // Preview Alpha62와 동일한 "대사 축약이 아닌 화면용 카피" 규칙.
  const all = `${publicSituation} ${narration} ${purpose}`;
  let headline = compactNewsText(publicSituation || keyInfo || narration, 18);

  if (/실제.*금리.*상승|금리.*오른 게 아니|금리.*인상.*아니/.test(all)) headline = "금리 인상 NO!!";
  else if (/인정.*여유.*줄|여유.*작아/.test(all)) headline = "대출 여유 DOWN!";
  else if (/사람마다.*한도|한도.*다르|누구나.*똑같/.test(all)) headline = "한도, 사람마다 다름!";
  else if ((/내 돈|자기자금/.test(all)) && (/늘|더 채/.test(all))) headline = "내 돈 부담 UP!";
  else if (/잘 들어봐|계산.*비밀|왜.*한도/.test(all)) headline = "한도 계산의 비밀";
  else if (/구독|좋아요/.test(all)) headline = "구독·좋아요 = 시간 SAVE!";
  else if (/줄.*서|기다|궁금증.*시간/.test(all)) headline = "궁금증 해결엔 시간 필요!";

  return {
    kicker: "",
    headline: compactNewsText(headline, 20),
    keyInfo: ""
  };
}


function deriveEconomyVisualAid(cut, index) {
  const n = [
    cut?.narration,
    cut?.debug?.narration,
    cut?.situation,
    cut?.purpose,
    cut?.visualIntent,
    cut?.topKeyText
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!n) return null;

  // Keep overlays deliberately compact: one relation/equation per explanatory CUT.
  if (/미래.*금리|금리.*올라도|스트레스\s*금리|미래\s*위험/.test(n)) {
    return {
      type: "equation",
      title: "한도 계산",
      lines: ["현재 금리 + 미래 금리 위험"]
    };
  }
  if (/부담.*크게|갚아야 할 부담|인정.*여유|여유.*작아/.test(n)) {
    return {
      type: "flow",
      title: "계산 구조",
      lines: ["상환 부담 ↑  ⇒  인정 여유 ↓"]
    };
  }
  if (/내 돈|자기자금|부족한 만큼|대출 한도.*줄/.test(n)) {
    return {
      type: "equation",
      title: "집값 구성",
      lines: ["대출 ↓  ⇒  자기자금 ↑"]
    };
  }
  // CUT-scoped classification:
  // "기존 빚" 한 단어만으로 비교 장면으로 분류하면 다음 설명 CUT까지
  // 3열 비교표가 따라오는 문제가 생긴다. 실제 조건 확인 CUT을 먼저 분리한다.
  if (/금리만 보고|실제로 얼마까지|소득.*기존 빚|상환방식|실제 한도|내 실제 조건/.test(n)
      && !/누구나 똑같|사람마다 달라|소득도 다르고|이미 진 빚.*다르/.test(n)) {
    return {
      type: "flow",
      title: "내 실제 조건",
      lines: ["소득 + 기존 빚 + 상환방식 ⇒ 실제 한도"]
    };
  }

  // 비교표는 '서로 다름'을 명시하는 장면에만 허용한다.
  if (/누구나 똑같|사람마다 달라|소득도 다르고|이미 진 빚.*다르|조건.*다르|결과.*다르/.test(n)) {
    return {
      type: "compare",
      title: "같은 제도 · 다른 결과",
      columns: [
        { head: "A", body: ["소득 여유 ↑", "기존 빚 ↓", "결손 작음"] },
        { head: "민재", body: ["중간 조건", "중간 부담", "결손 중간"] },
        { head: "B", body: ["기존 빚 ↑", "상환 부담 ↑", "결손 큼"] }
      ]
    };
  }
  return null;
}

function buildCutSchema(cut, i, cuts, audioMode, channelKey) {
  const range = getCutGlobalRange(cuts, i);
  const motion = cut.motion || {};
  return {
    id: cut.id,
    index: i + 1,
    start: range.start,
    duration: range.duration,
    mediaType: cut.mediaType === "source_video" && (cut.sourceVideo?.sourceAssetId || cut.sourceVideo?.url || cut.sourceVideo?.blobPath) ? "source_video" : (cut.mediaType === "video" && cut.video?.assetId ? "video" : (String(cut.visualRole || "").toUpperCase().includes("TRACKER GRAPHIC") ? "graphic" : "image")),
    visualRole: cut.visualRole || null,
    productionPrompt: cut.productionPrompt || "",
    imageAssetId: (cut.image && cut.image.assetId) || null,
    videoAssetId: (cut.video && cut.video.assetId) || null,
    sourceVideo: (cut.sourceVideo?.sourceAssetId || cut.sourceVideo?.url || cut.sourceVideo?.blobPath) ? { sourceAssetId:cut.sourceVideo.sourceAssetId || null, url:cut.sourceVideo.url || cut.sourceVideo.playbackUrl || cut.sourceVideo.blobUrl || "", blobPath:cut.sourceVideo.blobPath || null, ...(cut.sourceVideo.sha256 ? { sha256:String(cut.sourceVideo.sha256) } : {}), playbackValidUntil:cut.sourceVideo.playbackValidUntil || null, originalUrl:cut.sourceVideo.originalUrl || null, trimStart:Math.max(0,Number(cut.sourceVideo.trimStart||0)), trimEnd:cut.sourceVideo.trimEnd==null?null:Math.max(0,Number(cut.sourceVideo.trimEnd)), mute:cut.sourceVideo.mute!==false } : null,
    video: cut.video ? {
      duration: cut.video.duration ?? null,
      trimStart: Math.max(0, Number(cut.video.trimStart || 0)),
      trimEnd: cut.video.trimEnd == null ? null : Math.max(0, Number(cut.video.trimEnd)),
      mute: cut.video.mute !== false,
    } : null,
    motion: {
      type: motion.type || "STATIC",
      startScale: motion.startScale ?? 1,
      endScale: motion.endScale ?? 1,
      panX: motion.panX ?? 0,
      panY: motion.panY ?? 0,
      easing: motion.easing || "linear",
      ...(Array.isArray(motion.visualBeats) && motion.visualBeats.length ? { visualBeats: motion.visualBeats.map((b) => ({ ...b })) } : {}),
    },
    transitionOut: {
      type: cut.transition || "HARD_CUT",
      duration: cut.transitionDuration || 0,
    },
    subtitle: {
      narration: !!(cut.subtitle && cut.subtitle.narration),
      dialogue: !!(cut.subtitle && cut.subtitle.dialogue),
    },
    newsCard: deriveNewsCard(cut, i, channelKey),
    economyVisualAid: channelKey === "economy_current" ? deriveEconomyVisualAid(cut, i) : null,
    // rc.4(코드 리뷰 수정) — master_narration 모드에서는 CUT별 narration audioEvent를 Renderer
    // 계약(production.json)에 내보내지 않는다 — 마스터 나레이션 하나만 활성 오디오이므로,
    // 이걸 그대로 내보내면 Renderer가 같은 나레이션을 두 번(마스터 파일 + 이 CUT 이벤트)
    // 재생할 구조적 위험이 생긴다. episode.cuts[i].audioEvents 자체는 건드리지 않으며(DB에는
    // 그대로 보존, per_cut으로 되돌아가면 다시 정상적으로 내보내진다), 여기서는 production.json
    // 조립 시점에만 필터링한다(collectAssetUsages의 동일 필터와 짝을 이룬다).
    audioEvents: (cut.audioEvents || [])
      .filter((evt) => !(audioMode === "master_narration" && evt.type === "narration"))
      .map((evt) => buildAudioEventSchema(evt, cut, range.start)),
    // Renderer 핵심 계약과 분리된 참고용 메타데이터 — Renderer는 이 하위 필드를 몰라도 된다.
    debug: {
      durationSource: describeCutDuration(cut, audioMode).source,
      imageStatus: (cut.image && cut.image.status) || "미생성",
      purpose: cut.purpose || "",
      situation: cut.situation || "",
      narration: cut.narration || "",
      simpleParentIndex: cut.simpleParentIndex ?? null,
      simpleChildId: cut.simpleChildId ?? null,
      productionSpec: cut.productionSpec ? { ...cut.productionSpec } : null,
      // rc.3: Master Narration 모드일 때만 참고용으로 이 CUT의 마스터 파일 내 시작 지점(초)을
      // 함께 남긴다 — Renderer 필수 계약이 아니라, 사람이 원본 마커 값을 확인하고 싶을 때용.
      ...(audioMode === "master_narration" ? { masterStart: getMasterStart(cut, i) } : {}),
    },
  };
}

function buildSubtitleEvent(flatEvent, cuts) {
  const cut = cuts[flatEvent.cutIndex];
  let text = "";
  if (flatEvent.event.type === "narration") {
    text = (cut && cut.narration) || "";
  } else {
    const line = ((cut && cut.dialogueLines) || []).find((l) => l.id === flatEvent.event.sourceDialogueId);
    text = (line && line.text) || "";
  }
  return { type: flatEvent.event.type, text, start: flatEvent.globalStart, end: flatEvent.globalEnd, cutId: flatEvent.cutId };
}

function buildBgmSchema(episode, totalDuration) {
  const bgm = episode?.bgm;
  if (!bgm || !bgm.assetId) return null;
  return {
    assetId: bgm.assetId,
    start: bgm.start || 0,
    end: bgm.end != null ? bgm.end : totalDuration,
    volume: bgm.volume ?? 1,
    fadeIn: bgm.fadeIn || 0,
    fadeOut: bgm.fadeOut || 0,
    fadeCurve: bgm.fadeCurve || "linear",
    cutActions: { ...(bgm.cutActions || {}) },
  };
}

// 암호학적 해시가 아니다 — "새 crypto 의존성을 추가하지 말라"는 조건에 따라, 새 라이브러리도
// Web Crypto의 비동기 흐름도 필요 없는 간단한 FNV-1a 32bit 해시로 변경 감지용 fingerprint만
// 만든다. 목적은 "Preview 이후 데이터가 바뀌었는데 예전 production.json을 쓰는 문제"를 줄이는
// 것이지 위변조 방지가 아니다.
export function fnv1aHex(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fingerprintProduction(production) {
  const basis = JSON.stringify({
    renderSettings: production.renderSettings,
    captionStyle: production.captionStyle,
    totalDuration: production.totalDuration,
    assets: production.assets,
    cuts: production.cuts,
    subtitleEvents: production.subtitleEvents,
    bgm: production.bgm,
    sourceEffectCaptions: production.sourceEffectCaptions,
  });
  return fnv1aHex(basis);
}

// episode + (loadAssetManifest 결과)를 받아 production.json 전체 객체를 만든다. 순수 함수 —
// DB 조회/난수/현재시각 없이도 동작하도록 opts.now로 시각을 주입할 수 있다(테스트 결정성).
export function buildProduction(episode, assetManifestResult, opts = {}) {
  const cuts = episode?.cuts || [];
  const totalDuration = getEpisodeDuration(episode);
  const timeline = buildTimeline(episode);
  const manifest = (assetManifestResult && assetManifestResult.manifest) || [];

  const audioMode = episode?.formatType === "cut" ? episode?.audioMode || "per_cut" : null;
  const cutSchemas = cuts.map((cut, i) => buildCutSchema(cut, i, cuts, audioMode, episode?.channelKey || "unassigned"));
  const timelineSubtitleEvents = timeline.tracks.subtitle.map((e) => buildSubtitleEvent(e, cuts));
  // Source-first Shorts can exist before TTS assets are attached. Keep captions tied to
  // the same CUT timing contract so Preview/production.json/Renderer do not diverge.
  const sourceFirst = episode?.simpleProductionV2?.sourceFirst === true;
  const subtitleEvents = sourceFirst && timelineSubtitleEvents.length === 0
    ? cuts.map((cut, i) => {
        const range = getCutGlobalRange(cuts, i);
        return { type: "narration", text: String(cut?.narration || "").trim(), start: range.start, end: range.start + range.duration, cutId: cut?.id || null };
      }).filter((e) => e.text && e.end > e.start)
    : timelineSubtitleEvents;
  const bgm = buildBgmSchema(episode, totalDuration);
  // rc.3(Master Narration Mode) — Renderer가 "이 영상은 CUT별 나레이션이 아니라 통합
  // 나레이션 파일 + CUT 시작 마커 기반"이라는 것을 명시적으로 알 수 있게 최상위에 노출한다.
  // per_cut(기존) episode/format에서는 null로 둔다 — 기존 schema를 깨지 않는 선택적 필드다.
  const masterNarrationSchema =
    audioMode === "master_narration" && episode?.masterNarration && episode.masterNarration.assetId
      ? { assetId: episode.masterNarration.assetId, duration: episode.masterNarration.duration ?? null }
      : null;

  const production = {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: { app: "Shorts Production Tracker", appVersion: APP_VERSION },
    generatedAt: opts.now ?? Date.now(),
    revision: {
      episodeUpdatedAt: episode?.updatedAt ?? null,
      timelineReviewedAt: episode?.timelineReviewedAt ?? null,
      previewReviewedAt: episode?.previewReviewedAt ?? null,
      fingerprint: null,
    },
    episode: {
      episodeId: episode?.id ?? null,
      title: episode?.title || "",
      seriesType: episode?.seriesType || "",
      formatType: episode?.formatType || "cut",
      channelKey: episode?.channelKey || "unassigned",
      contentFormat: episode?.contentFormat || "shorts",
      productionProfile: episode?.productionProfile || "standard",
      visualContentMode: episode?.productionPreset?.visualContentMode || "news",
      isSimpleV2: episode?.productionWorkflow === "simple_v2" || episode?.simpleProductionV2?.schemaVersion === 2,
      sourceFirst,
      newsInfoCardEnabled: !(episode?.productionWorkflow === "simple_v2" || episode?.simpleProductionV2?.schemaVersion === 2) && episode?.channelKey === "economy_current" && (episode?.contentFormat || "shorts") === "shorts",
      date: episode?.date || "",
    },
    renderSettings: normalizeRenderSettings(episode?.renderSettings),
    outputFitMode: episode?.outputFitMode === "contain" || episode?.simpleProductionV2?.outputFitMode === "contain" ? "contain" : "cover",
    captionStyle: resolveCaptionStyle(episode),
    audioMode,
    masterNarration: masterNarrationSchema,
    totalDuration,
    assets: manifest,
    cuts: cutSchemas,
    subtitleEvents,
    sourceEffectCaptions: sourceFirst && Array.isArray(episode?.sourceFirstPlan?.effectCaptions) ? episode.sourceFirstPlan.effectCaptions : [],
    bgm,
  };

  production.revision.fingerprint = fingerprintProduction(production);
  return production;
}

// ---------------------------------------------------------------------------
// 4) Final QC — qc.js(Preview QC)를 그대로 재사용하고, Phase 6 전용 규칙(실제 asset 존재,
//    schema 무결성, 검토 게이트)만 얹는다. "화면마다 QC 규칙을 중복 작성하지 않는다"는
//    원칙을 Phase 6에서도 지킨다 — 여기서 severity 판정을 새로 만드는 부분은 정말로
//    qc.js가 다루지 않는 것(실제 Blob 존재, production.json 자체의 내부 무결성)뿐이다.
// ---------------------------------------------------------------------------

export function validateProduction(production, episode, assetManifestResult) {
  const items = [];
  const push = (severity, message, extra = {}) =>
    items.push({
      severity,
      message,
      cutIndex: extra.cutIndex ?? null,
      cutId: extra.cutId ?? null,
      eventId: extra.eventId ?? null,
      stepHint: extra.stepHint ?? null,
    });

  // (1) Preview QC 결과를 그대로 포함한다(중복 규칙 없음 — qc.js가 유일한 소스).
  getQcResults(episode).forEach((i) => items.push({ ...i, stepHint: i.stepHint ?? null }));

  // (2) 실제 저장소에 Blob이 없는 broken asset reference
  const brokenRefs = (assetManifestResult && assetManifestResult.brokenRefs) || [];
  brokenRefs.forEach((ref) => {
    push(QC_SEVERITY.ERROR, `${usageLabel(ref)}가 참조하는 asset이 실제 저장소에 없습니다 — 다시 첨부해주세요.`, {
      cutIndex: ref.cutIndex ?? null,
      cutId: ref.cutId ?? null,
      eventId: ref.eventId ?? null,
      stepHint: stepHintForUsage(ref.usage),
    });
  });

  // (3) totalDuration 일치성 — Timeline과 항상 같아야 한다는 원칙의 안전망
  const recomputed = getEpisodeDuration(episode);
  if (production.totalDuration !== recomputed) {
    push(QC_SEVERITY.ERROR, `전체 길이 계산이 일치하지 않습니다(production.json ${production.totalDuration}초 vs Timeline ${recomputed}초).`, {
      stepHint: "timeline",
    });
  }

  // (4) subtitle start/end 역전
  (production.subtitleEvents || []).forEach((s) => {
    if (!(s.end > s.start)) {
      push(QC_SEVERITY.ERROR, `자막("${(s.text || "").slice(0, 16)}") 시간 범위가 잘못됐습니다.`, { cutId: s.cutId, stepHint: "preview" });
    }
  });

  // (5) BGM start/end 역전
  if (production.bgm && !(production.bgm.end > production.bgm.start)) {
    push(QC_SEVERITY.ERROR, "BGM 시간 범위가 잘못됐습니다(start가 end보다 크거나 같음).", { stepHint: "cutAudio" });
  }

  // (6) schema 필수 필드 + asset manifest 매핑 무결성(안전망 — 정상 흐름에서는 절대 발생하지 않아야 함)
  const manifestIds = new Set((production.assets || []).map((a) => a.id));
  (production.cuts || []).forEach((c, i) => {
    if (c.id == null || c.start == null || c.duration == null) {
      push(QC_SEVERITY.ERROR, `CUT ${i + 1} 데이터에 필수 필드가 누락됐습니다.`, { cutIndex: i, cutId: c.id, stepHint: "timeline" });
    }
    if (c.imageAssetId && !manifestIds.has(c.imageAssetId)) {
      push(QC_SEVERITY.ERROR, `CUT ${i + 1} 이미지 asset이 asset manifest에 없습니다.`, { cutIndex: i, cutId: c.id, stepHint: "cutImages" });
    }
    (c.audioEvents || []).forEach((e) => {
      if (e.assetId && !manifestIds.has(e.assetId)) {
        push(QC_SEVERITY.ERROR, `CUT ${i + 1} 오디오 asset이 asset manifest에 없습니다.`, { cutIndex: i, cutId: c.id, eventId: e.id, stepHint: "cutAudio" });
      }
      if (!Number.isFinite(e.globalStart) || !Number.isFinite(e.duration)) {
        push(QC_SEVERITY.ERROR, `CUT ${i + 1} 오디오 이벤트의 시간 계산이 올바르지 않습니다.`, { cutIndex: i, cutId: c.id, eventId: e.id, stepHint: "cutAudio" });
      }
    });
  });
  if (production.bgm && production.bgm.assetId && !manifestIds.has(production.bgm.assetId)) {
    push(QC_SEVERITY.ERROR, "BGM asset이 asset manifest에 없습니다.", { stepHint: "cutAudio" });
  }

  // (7) Review gate — 없어도 ERROR로 막지는 않는다(사용자가 확인용으로 JSON을 미리 볼 수는
  // 있어야 한다). 대신 WARNING으로 안내하고, [최종 확정] 버튼 자체는 화면(cutExportStep.js)에서
  // isStepDone(ep,"timeline")/isStepDone(ep,"preview")로 별도로 막는다(실수로 건너뛰고 바로
  // 확정하는 것을 방지 — 조건 14번의 목적).
  if (!episode?.timelineReviewedAt) {
    push(QC_SEVERITY.WARNING, "타임라인이 아직 검토 완료로 표시되지 않았습니다.", { stepHint: "timeline" });
  }
  if (!episode?.previewReviewedAt) {
    push(QC_SEVERITY.WARNING, "미리보기가 아직 검토 완료로 표시되지 않았습니다.", { stepHint: "preview" });
  }

  return items;
}

export function serializeProduction(production) {
  return JSON.stringify(production, null, 2);
}
