// Preview/QC 규칙 모듈(Phase 5) — "이대로 영상을 만들어도 되는가?"를 판단하기 위한
// 규칙을 한 곳에서만 정의한다. 화면(previewStep.js)은 이 모듈의 결과를 표시만 할 뿐,
// 자체적으로 QC 판정 로직을 만들지 않는다(조건 9번 "화면마다 별도의 QC 규칙을 중복
// 작성하지 마세요").
//
// 순수 함수만 존재한다(DOM/비동기 DB 조회 없음) — model.js/timeline.js가 이미 갖고 있는
// episode.cuts의 필드(assetId 존재 여부 등)만으로 판정한다. asset이 실제로 IndexedDB에
// 남아있는지(진짜 broken blob 여부)는 db.js의 참조무결성 삭제 흐름(deleteAssetSafely)이
// 애초에 dangling assetId가 생기지 않도록 항상 보장하므로, 여기서는 별도의 비동기 검증을
// 하지 않는다 — "참조 asset 없음"은 "assetId 필드 자체가 비어있음"으로 해석한다.
//
// severity: "error" | "warning" | "info" — Preview 화면과 NextActionEngine이 그대로 재사용한다.

import { resolveCutDuration, isImageApproved } from "./model.js";
import { getTimelineWarnings, getEpisodeDuration, describeCutDuration } from "./timeline.js";

export const QC_SEVERITY = { ERROR: "error", WARNING: "warning", INFO: "info" };

// 임의로 정한 참고 임계값(제작 판단용) — FFmpeg 등 실제 렌더러의 기준이 아니다.
export const SHORT_DURATION_WARN_SEC = 0.5;
export const LONG_DURATION_WARN_SEC = 12;

function isNarratorSpeaker(value) {
  const s = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  return s === "나레이터" || s === "내레이터" || s === "narrator";
}

function dialogueRequiresSeparateAudio(line, audioMode) {
  if (!line?.text || !String(line.text).trim()) return false;
  if (audioMode === "master_narration" && isNarratorSpeaker(line.speaker)) return false;
  return true;
}

function push(items, severity, cutIndex, cutId, message, eventId) {
  items.push({ severity, cutIndex, cutId, eventId: eventId ?? null, message });
}


function applyEconomyGoldenReferenceQc(episode, items) {
  if (episode?.channelKey !== "economy_current") return;
  const cuts=episode?.cuts||[];
  const isShorts=(episode?.contentFormat||"shorts")==="shorts";
  if (isShorts && cuts.length>=2) {
    const firstText=`${cuts[0]?.directorNote||""} ${cuts[0]?.situation||""}`;
    const lastText=`${cuts[cuts.length-1]?.directorNote||""} ${cuts[cuts.length-1]?.situation||""}`;
    if (!/LOOP_OPEN|루프|마지막 CUT/.test(firstText))
      push(items,QC_SEVERITY.WARNING,0,cuts[0]?.id,"경제 Shorts 첫 CUT의 Seamless Loop 시작 설계가 확인되지 않습니다.");
    if (!/LOOP_CLOSE|루프|첫 CUT/.test(lastText))
      push(items,QC_SEVERITY.WARNING,cuts.length-1,cuts[cuts.length-1]?.id,"경제 Shorts 마지막 CUT의 Seamless Loop 마감 설계가 확인되지 않습니다.");
  }
  const staticCount=cuts.filter(c=>!c?.motion||c.motion.type==="STATIC").length;
  if (cuts.length && staticCount/cuts.length>0.65)
    push(items,QC_SEVERITY.WARNING,null,null,"경제 Golden Reference 기준보다 정지 CUT 비율이 높습니다.");
}

// episode 전체에 대한 QC 결과 목록을 계산한다. Timeline의 getTimelineWarnings()를 그대로
// 재사용해 blocker→error/warning→warning으로 매핑하고(시간 계산 관련 경고는 여기서 다시
// 만들지 않는다), 그 위에 QC 전용 규칙(이미지/필수오디오/자막/참고성 INFO)을 추가한다.
export function getQcResults(episode) {
  const cuts = episode?.cuts || [];
  const items = [];

  getTimelineWarnings(episode).forEach((w) => {
    push(items, w.severity === "blocker" ? QC_SEVERITY.ERROR : QC_SEVERITY.WARNING, w.cutIndex, w.cutId, w.message, w.eventId);
  });

  const episodeDuration = getEpisodeDuration(episode);
  if (cuts.length === 0) {
    push(items, QC_SEVERITY.ERROR, null, null, "CUT이 하나도 없어 Preview를 계산할 수 없습니다.");
    return items;
  }

  cuts.forEach((cut, i) => {
    const n = i + 1;

    // ERROR — 이미지(참조 asset) 없음
    if (!cut.image?.assetId) {
      push(items, QC_SEVERITY.ERROR, i, cut.id, `CUT ${n} 이미지가 없습니다.`);
    } else if (cut.image.status === "RETRY") {
      push(items, QC_SEVERITY.WARNING, i, cut.id, `CUT ${n} 이미지가 RETRY 상태입니다 — 다시 제작이 필요해요.`);
    } else if (!isImageApproved(cut)) {
      push(items, QC_SEVERITY.WARNING, i, cut.id, `CUT ${n} 이미지가 검수 완료(PASS/확정) 상태가 아닙니다(현재: ${cut.image.status}).`);
    }

    // ERROR — 필수 오디오 asset 참조 누락(Phase 3 cutAudio 규칙과 같은 기준을 QC에서도 보여줌)
    // rc.3: Master Narration 모드에서는 나레이션이 CUT별 asset이 아니라 에피소드 전체의
    // 마스터 파일이다 — "이 CUT에 나레이션 음성 asset이 없다"는 검사 자체가 성립하지 않는다
    // (마스터 파일/마커 누락은 getTimelineWarnings의 duration-없음 blocker로 이미 ERROR로
    // 잡힌다 — nextActions.js의 isMasterNarrationReady와 같은 데이터를 본다).
    if (episode?.audioMode !== "master_narration" && cut.narration && cut.narration.trim()) {
      const hasNarrationAsset = (cut.audioEvents || []).some((e) => e.type === "narration" && e.assetId);
      if (!hasNarrationAsset) push(items, QC_SEVERITY.ERROR, i, cut.id, `CUT ${n} 나레이션 음성 asset이 없습니다.`);
    }
    (cut.dialogueLines || []).forEach((line) => {
      if (!dialogueRequiresSeparateAudio(line, episode?.audioMode)) return;
      const evt = (cut.audioEvents || []).find((e) => e.type === "dialogue" && e.sourceDialogueId === line.id);
      if (!evt || !evt.assetId) push(items, QC_SEVERITY.ERROR, i, cut.id, `CUT ${n} 대사("${line.text.slice(0, 16)}") 음성 asset이 없습니다.`);
    });
    (cut.audioEvents || [])
      .filter((e) => e.type === "sfx" && e.required && !e.assetId)
      .forEach((e) => push(items, QC_SEVERITY.ERROR, i, cut.id, `CUT ${n} 필수 SFX "${e.name || "이름 없음"}" asset이 없습니다.`, e.id));

    // WARNING — duration이 비정상적으로 짧거나 긴 CUT
    const resolved = resolveCutDuration(cut);
    if (resolved != null && resolved > 0) {
      if (resolved < SHORT_DURATION_WARN_SEC) push(items, QC_SEVERITY.WARNING, i, cut.id, `CUT ${n} 길이(${resolved}초)가 비정상적으로 짧습니다.`);
      if (resolved > LONG_DURATION_WARN_SEC) push(items, QC_SEVERITY.WARNING, i, cut.id, `CUT ${n} 길이(${resolved}초)가 비정상적으로 깁니다.`);
    }

    // WARNING — Subtitle ON인데 표시할 텍스트가 없음(자막 대상 텍스트는 audioEvent가 아니라
    // Story의 cut.narration / dialogueLines.text가 원본이다 — Preview도 이 필드를 그대로 읽는다)
    if (cut.subtitle?.narration && !(cut.narration && cut.narration.trim())) {
      push(items, QC_SEVERITY.WARNING, i, cut.id, `CUT ${n} 나레이션 자막이 켜져 있지만 표시할 텍스트가 없습니다.`);
    }
    if (cut.subtitle?.dialogue && (cut.dialogueLines || []).length > 0 && !(cut.dialogueLines || []).some((l) => l?.text && l.text.trim())) {
      push(items, QC_SEVERITY.WARNING, i, cut.id, `CUT ${n} 대사 자막이 켜져 있지만 표시할 텍스트가 없습니다.`);
    }

    // INFO — 제작은 가능하지만 참고할 사항
    const info = describeCutDuration(cut, episode?.audioMode);
    if (info.source === "estimated") push(items, QC_SEVERITY.INFO, i, cut.id, `CUT ${n}은(는) 추정(estimated) 길이를 사용 중입니다.`);
    if ((cut.motion?.type || "STATIC") === "STATIC") push(items, QC_SEVERITY.INFO, i, cut.id, `CUT ${n} 모션이 STATIC(정지)입니다.`);
    if (!(cut.audioEvents || []).some((e) => e.type === "sfx")) push(items, QC_SEVERITY.INFO, i, cut.id, `CUT ${n}에 SFX가 없습니다.`);
  });

  if (episodeDuration <= 0) {
    push(items, QC_SEVERITY.ERROR, null, null, "전체 영상 길이를 계산할 수 없습니다(모든 CUT의 duration이 0이거나 없음).");
  }

  applyEconomyGoldenReferenceQc(episode, items);

  return items;
}

export function summarizeQc(items) {
  const list = items || [];
  return {
    errorCount: list.filter((i) => i.severity === QC_SEVERITY.ERROR).length,
    warningCount: list.filter((i) => i.severity === QC_SEVERITY.WARNING).length,
    infoCount: list.filter((i) => i.severity === QC_SEVERITY.INFO).length,
  };
}

// "최종 제작 준비 완료"는 ERROR가 0건일 때만 성립한다 — WARNING/INFO만으로는 판단하지 않는다.
export function isReadyForProduction(items) {
  return summarizeQc(items).errorCount === 0;
}
