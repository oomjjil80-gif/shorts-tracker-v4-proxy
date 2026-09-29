// Timeline 계산 모듈 — 시간축 관련 계산은 전부 여기서만 한다(View에 흩뿌리지 않는다).
//
// Phase 5(미리보기 재생)와 Phase 6(production.json 내보내기)도 "언제 무엇이 일어나는가"를
// 판단할 때 이 모듈의 함수를 그대로 재사용해야 한다 — Timeline 화면만의 독자적인 시간 계산
// 로직을 만들지 않는다.
//
// 핵심 원칙:
// - CUT의 global start/end는 이전 CUT들의 resolved duration(manual > measured > estimated)을
//   누적해서 계산한다.
// - CUT 내부 audioEvent.start는 항상 "CUT 상대시간"이다(Phase 3 원칙 그대로 유지) — 이 모듈은
//   표시/계산 시에만 globalStart = cutGlobalStart + event.start로 변환하고, 원본 데이터
//   (episode.cuts[i].audioEvents[j].start)는 절대 건드리지 않는다(순수 함수, 부수효과 없음).

import { resolveCutDuration } from "./model.js";

// resolveCutDuration()은 아직 아무 값도 없으면 null을 반환한다(정직하게). Timeline 레이아웃
// 계산 시에는 숫자가 있어야 누적합이 깨지지 않으므로 여기서만 0으로 대체한다 — "duration이
// 없다"는 사실 자체는 getTimelineWarnings()가 별도로 정확히 잡아낸다(이 함수가 숨기지 않는다).
function resolvedOrZero(cut) {
  const d = resolveCutDuration(cut);
  return d == null ? 0 : d;
}

// duration의 출처(manual/measured/estimated 중 실제로 쓰인 것)를 함께 알려준다 —
// UI에 "최종 2.8초 · 실측 2.1초 · 추정 2.5초"처럼 출처를 구분해서 보여주기 위함.
// rc.3: audioMode(선택)를 함께 넘기면, "measured" 칸이 실제로는 Master Narration의 CUT
// 마커에서 역산된 값일 때 source를 "master"로 구분해 보여준다 — resolveCutDuration()의
// manual > measured > estimated 우선순위/계산 결과 자체는 전혀 바뀌지 않는다(표시용 구분일 뿐).
export function describeCutDuration(cut, audioMode) {
  const d = cut?.duration || {};
  let source = null;
  if (d.manual != null) source = "manual";
  else if (d.measured != null) source = audioMode === "master_narration" ? "master" : "measured";
  else if (d.estimated != null) source = "estimated";
  return {
    manual: d.manual ?? null,
    measured: d.measured ?? null,
    estimated: d.estimated ?? null,
    resolved: resolveCutDuration(cut),
    source, // "manual" | "measured" | "master" | "estimated" | null(값 자체가 없음)
  };
}

// CUT 배열에서 index번째 CUT의 전역 시작 시각 — 이전 CUT들의 resolved duration 누적합.
export function getCutGlobalStart(cuts, index) {
  const list = cuts || [];
  let t = 0;
  for (let i = 0; i < index && i < list.length; i++) t += resolvedOrZero(list[i]);
  return t;
}

export function getCutGlobalRange(cuts, index) {
  const list = cuts || [];
  const cut = list[index];
  const start = getCutGlobalStart(list, index);
  const duration = cut ? resolvedOrZero(cut) : 0;
  return { start, end: start + duration, duration };
}

// 전체 에피소드 재생시간 — 모든 CUT의 resolved duration 합(= 마지막 CUT의 end와 같다).
export function getEpisodeDuration(episode) {
  const cuts = episode?.cuts || [];
  return cuts.reduce((sum, c) => sum + resolvedOrZero(c), 0);
}

// 모든 CUT의 모든 audioEvent를 "전역시간 좌표"로 변환해 평탄화한 목록.
// 원본 audioEvent.start(CUT 상대시간)는 절대 수정하지 않는다 — globalStart는 항상 계산해서만
// 반환한다.
export function getTimelineEvents(episode) {
  const cuts = episode?.cuts || [];
  const events = [];
  cuts.forEach((cut, i) => {
    const cutStart = getCutGlobalStart(cuts, i);
    (cut.audioEvents || []).forEach((evt) => {
      const start = evt.start || 0;
      const duration = evt.duration ?? 0;
      events.push({
        event: evt,
        cutId: cut.id,
        cutIndex: i,
        cutNumber: i + 1,
        globalStart: cutStart + start,
        globalEnd: cutStart + start + duration,
      });
    });
  });
  return events;
}

// rc.4(코드 리뷰 후속 수정) — "지금 이 episode가 Master Narration 모드로 활성화돼 있는가"를
// 판단하는 조건을 한 곳에만 정의한다. buildTimeline()의 VOICE 트랙 필터링, getTimelineWarnings()의
// 경고 대상 필터링, cutTimelineStep.js의 CUT 상세 편집기 audioEvent 목록 필터링이 전부 이
// 함수 하나만 호출해야 세 곳의 판정이 어긋날 여지가 없다. text_card(V1) 포맷에는 audioMode
// 개념 자체가 없으므로 formatType==="cut"도 함께 확인한다.
export function isMasterNarrationMode(episode) {
  return episode?.formatType === "cut" && episode?.audioMode === "master_narration";
}

// Timeline 화면(및 향후 qc.js)이 그대로 재사용할 수 있는 트랙별 데이터 + 전체 요약.
export function buildTimeline(episode) {
  const cuts = episode?.cuts || [];
  const episodeDuration = getEpisodeDuration(episode);
  const isMasterMode = isMasterNarrationMode(episode);

  const cutBlocks = cuts.map((cut, i) => {
    const range = getCutGlobalRange(cuts, i);
    return { cut, index: i, n: i + 1, ...range, durationInfo: describeCutDuration(cut, episode?.audioMode) };
  });

  const flatEvents = getTimelineEvents(episode);
  // rc.4(코드 리뷰 수정) — master_narration 모드에서는 CUT별 narration audioEvent가 "활성
  // 재생 오디오"가 아니다. per_cut → master_narration으로 모드를 전환해도 기존 narration
  // audioEvent/asset은 (다시 per_cut으로 돌아갈 수 있도록) episode 데이터에서 절대 지우지
  // 않지만, 여기 VOICE 트랙에는 더 이상 포함시키지 않는다 — 포함시키면 마스터 나레이션과
  // 기존 CUT별 나레이션이 동시에 "활성 이벤트"로 잡혀 Preview에서 같은 나레이션이 중복
  // 재생되는 문제가 생긴다(모드 전환만으로 데이터를 지우지 않는다는 비파괴 원칙과, "활성
  // 재생 오디오는 모드당 하나의 소스만"이라는 원칙을 동시에 지키기 위한 순수 read-time 필터
  // 링이다 — episode.cuts는 전혀 건드리지 않는다). 대사(dialogue)는 오디오 방식과 무관하게
  // 항상 CUT별로 관리되므로 모드에 상관없이 그대로 포함한다.
  let voice = isMasterMode
    ? flatEvents.filter((e) => e.event.type === "dialogue")
    : flatEvents.filter((e) => e.event.type === "narration" || e.event.type === "dialogue");
  const sfx = flatEvents.filter((e) => e.event.type === "sfx");
  const silence = flatEvents.filter((e) => e.event.type === "silence");

  let subtitle;
  if (isMasterMode) {
    // rc.3(Master Narration Mode) — 나레이션 오디오는 CUT별 audioEvent가 아니라 에피소드
    // 전체에 걸친 단일 트랙이다. VOICE 트랙에는 (per-cut narration audioEvent 대신) 마스터
    // 나레이션 파일 하나를 CUT 마커로 계산된 전체 구간(0~episodeDuration)에 걸친 블록으로
    // 얹는다 — Preview의 오디오 재생 루프(narration/dialogue/sfx 공용)가 이 블록을 그대로
    // "이벤트 하나"로 다뤄서 currentTime을 그대로 offset으로 써도 정확히 맞아떨어진다(CUT1의
    // 시작이 항상 0초이기 때문). 대사(dialogue) 오디오는 기존처럼 CUT별 audioEvent를 그대로 쓴다.
    if (episode.masterNarration && episode.masterNarration.assetId) {
      voice = [
        {
          event: { id: "master_narration", type: "narration", assetId: episode.masterNarration.assetId, master: true },
          cutId: null,
          cutIndex: null,
          cutNumber: null,
          globalStart: 0,
          globalEnd: episodeDuration,
        },
        ...voice,
      ];
    }
    // 자막 원본도 마찬가지 — per-cut narration audioEvent가 없으므로, "이 CUT의 나레이션
    // 자막이 켜져 있고 실제 대본 텍스트가 있다"는 조건만으로 CUT 전역 구간을 그대로 자막
    // 구간으로 쓴다(Story 단계의 cut.narration이 원본, 오디오 이벤트에 의존하지 않는다).
    const narrationSubs = cutBlocks
      .filter((cb) => {
        const explicit = cb.cut?.subtitle?.narration;
        const defaultOn = episode?.channelKey === "economy_current" && episode?.contentFormat === "longform";
        return (explicit === true || (explicit == null && defaultOn)) && cb.cut.narration && cb.cut.narration.trim();
      })
      .map((cb) => ({
        event: { type: "narration" },
        cutId: cb.cut.id,
        cutIndex: cb.index,
        globalStart: cb.start,
        globalEnd: cb.end,
      }));
    const dialogueSubs = flatEvents.filter((e) => e.event.type === "dialogue" && cuts[e.cutIndex]?.subtitle?.dialogue);
    subtitle = [...narrationSubs, ...dialogueSubs].sort((a, b) => a.globalStart - b.globalStart);
  } else {
    subtitle = flatEvents
      .filter((e) => e.event.type === "narration" || e.event.type === "dialogue")
      .filter((e) => {
        const cut = cuts[e.cutIndex];
        const key = e.event.type === "narration" ? "narration" : "dialogue";
        const explicit = cut?.subtitle?.[key];
        const defaultNarrationOn = key === "narration" && episode?.channelKey === "economy_current" && episode?.contentFormat === "longform";
        return explicit === true || (explicit == null && defaultNarrationOn);
      });
  }

  const bgm = episode?.bgm && episode.bgm.assetId
    ? [{ bgm: episode.bgm, globalStart: episode.bgm.start || 0, globalEnd: episode.bgm.end != null ? episode.bgm.end : episodeDuration }]
    : [];

  return {
    episodeDuration,
    cuts: cutBlocks,
    tracks: { video: cutBlocks, voice, sfx, silence, bgm, subtitle },
  };
}

// Timeline 자체 화면에서 즉시 보여줄 경고 — Phase 6 이전 qc.js가 재사용할 수 있도록
// View에 하드코딩하지 않고 여기서 순수 함수로 제공한다. severity: "warning" | "blocker".
export function getTimelineWarnings(episode) {
  const cuts = episode?.cuts || [];
  const warnings = [];
  const episodeDuration = getEpisodeDuration(episode);
  // rc.4(코드 리뷰 후속 수정) — Master Narration 모드에서는 CUT별 narration audioEvent가
  // "비활성 보존 데이터"다(episode.cuts는 건드리지 않지만 활성 재생/노출 대상에서는 제외).
  // 이 경고 계산도 그 원칙을 따라야 한다 — 그러지 않으면 DB에만 남아있는 옛 나레이션이
  // 실제 CUT 길이보다 길다는 이유로 "나레이션이 CUT 종료보다 N초 늦게 끝납니다" 같은 잘못된
  // 경고가 뜬다(실제 VOICE 트랙에는 이미 그 이벤트가 없으므로 사용자 입장에서는 원인을 알 수
  // 없는 유령 경고가 된다). Dialogue/SFX 경고와 per_cut 모드의 narration 경고는 그대로
  // 동작해야 하므로, narration 타입 + 마스터 모드일 때만 이 CUT의 이 이벤트를 건너뛴다.
  const isMasterMode = isMasterNarrationMode(episode);

  cuts.forEach((cut, i) => {
    const n = i + 1;
    const resolved = resolveCutDuration(cut);
    if (resolved == null) {
      warnings.push({ severity: "blocker", cutIndex: i, cutId: cut.id, message: `CUT ${n} 재생시간이 아직 정해지지 않았습니다.` });
      return; // duration이 없으면 아래 오버플로 계산 자체가 의미 없다.
    }
    if (resolved <= 0) {
      warnings.push({ severity: "blocker", cutIndex: i, cutId: cut.id, message: `CUT ${n} duration이 0초입니다.` });
    }

    (cut.audioEvents || []).forEach((evt) => {
      if (isMasterMode && evt.type === "narration") return; // 비활성 보존 데이터 — 경고 대상 아님(episode.cuts는 미수정).
      const start = evt.start || 0;
      const duration = evt.duration ?? 0;
      const end = start + duration;
      if (evt.type === "sfx" && start >= resolved && resolved > 0) {
        warnings.push({
          severity: "warning",
          cutIndex: i,
          cutId: cut.id,
          eventId: evt.id,
          message: `CUT ${n} SFX${evt.name ? ` "${evt.name}"` : ""}가 CUT 종료 이후 시작합니다.`,
        });
        return;
      }
      if (end > resolved) {
        const over = Math.round((end - resolved) * 10) / 10;
        const label = evt.type === "narration" ? "나레이션" : evt.type === "dialogue" ? "대사" : evt.type === "sfx" ? `SFX${evt.name ? ` "${evt.name}"` : ""}` : "정적";
        warnings.push({
          severity: "warning",
          cutIndex: i,
          cutId: cut.id,
          eventId: evt.id,
          message: `CUT ${n} ${label}이(가) CUT 종료보다 ${over}초 늦게 끝납니다.`,
        });
      }
    });
  });

  if (episode?.bgm && episode.bgm.assetId && episode.bgm.end != null && episode.bgm.end > episodeDuration) {
    warnings.push({
      severity: "warning",
      cutIndex: null,
      cutId: null,
      message: `BGM 종료 시각(${episode.bgm.end}초)이 전체 영상 길이(${Math.round(episodeDuration * 10) / 10}초)를 초과합니다.`,
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Phase 5(Preview 재생)가 필요로 하는 순수 시간/볼륨 계산 — 여기도 View에 흩뿌리지 않는다.
// Timeline과 Preview가 서로 다른 시간 계산을 하지 않도록, 아래 함수들을 Preview 화면과
// 테스트가 그대로 재사용한다.
// ---------------------------------------------------------------------------

// 현재 재생시각(초)이 속한 CUT의 index를 반환한다. 범위 밖이면 첫 CUT(currentTime<=0)이나
// 마지막 CUT(currentTime>=전체 길이)으로 clamp한다. CUT이 하나도 없으면 null.
export function getActiveCutIndex(cuts, currentTime) {
  const list = cuts || [];
  if (!list.length) return null;
  let acc = 0;
  for (let i = 0; i < list.length; i++) {
    const dur = resolvedOrZero(list[i]);
    if (currentTime < acc + dur || i === list.length - 1) return i;
    acc += dur;
  }
  return list.length - 1;
}

// CUT별 BGM 동작(continue/lower/raise/stop)이 볼륨에 주는 배율 — Preview 재생과 테스트가
// 같은 상수를 쓰도록 한 곳에만 정의한다. fade_out은 상수가 아니라 해당 CUT 구간 안에서
// 1→0으로 선형 감쇠하므로 getBgmEnvelopeVolume()에서 별도로 계산한다.
// 실제 최종 렌더러(FFmpeg)의 정확한 수치와는 다를 수 있다 — Phase 5는 제작 판단이 가능한
// 정도의 근사치가 목표이지 pixel-perfect 재현이 목표가 아니다(조건 15번).
export const BGM_CUT_ACTION_VOLUME = {
  continue: 1,
  lower: 0.35,
  raise: 1,
  stop: 0,
};

// episode.bgm과 현재 재생시각(초)을 받아 0~1 사이의 최종 재생 볼륨을 계산한다:
// bgm.start~end 범위 밖이면 0, 경계에서 fadeIn/fadeOut(초)만큼 linear fade, 그 위에 현재
// 활성 CUT의 bgmAction 배율을 곱한다. fadeCurve는 지금은 "linear"만 실제로 계산하지만
// 인자로 episode 전체를 받으므로 향후 다른 curve를 추가해도 이 함수의 시그니처는 그대로다.
export function getBgmEnvelopeVolume(episode, currentTime) {
  const bgm = episode?.bgm;
  if (!bgm || !bgm.assetId) return 0;
  const episodeDuration = getEpisodeDuration(episode);
  const start = bgm.start || 0;
  const end = bgm.end != null ? bgm.end : episodeDuration;
  if (currentTime < start || currentTime >= end) return 0;

  const base = bgm.volume ?? 1;
  const fadeIn = Math.max(0, bgm.fadeIn || 0);
  const fadeOut = Math.max(0, bgm.fadeOut || 0);
  let envelope = 1;
  if (fadeIn > 0 && currentTime < start + fadeIn) {
    envelope = Math.min(envelope, (currentTime - start) / fadeIn);
  }
  if (fadeOut > 0 && currentTime > end - fadeOut) {
    envelope = Math.min(envelope, (end - currentTime) / fadeOut);
  }
  envelope = Math.max(0, Math.min(1, envelope));

  const cuts = episode?.cuts || [];
  const activeIndex = getActiveCutIndex(cuts, currentTime);
  const activeCut = activeIndex != null ? cuts[activeIndex] : null;
  const action = (activeCut && bgm.cutActions && bgm.cutActions[activeCut.id]) || "continue";

  let actionMultiplier = BGM_CUT_ACTION_VOLUME[action] ?? 1;
  if (action === "fade_out" && activeCut) {
    const range = getCutGlobalRange(cuts, activeIndex);
    const localT = currentTime - range.start;
    actionMultiplier = range.duration > 0 ? Math.max(0, 1 - localT / range.duration) : 0;
  }

  return Math.max(0, Math.min(1, base * envelope * actionMultiplier));
}
