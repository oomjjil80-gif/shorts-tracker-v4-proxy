// 데이터 모델 & 기본값 팩토리
//
// v2: formatType("text_card" | "cut")과 seriesType은 완전히 독립적인 축이다.
// - text_card: 기존 v1 구조(scenes, narrationAudioName) — 100% 그대로 보존.
// - cut: v2 신규 구조(cuts, globalVisualBible, styleReference 등).
// 두 포맷을 하나의 필드셋으로 억지로 합치지 않고, 공통 필드만 공유한다.

// ---- STEP 정의 (포맷별로 완전히 분리) ----

export const STEPS_TEXT_CARD = [
  { key: "plan", label: "① 기획" },
  { key: "scenes", label: "② 대본/씬" },
  { key: "duration", label: "③ 재생시간" },
  { key: "images", label: "④ 이미지검수" },
  { key: "narration", label: "⑤ 나레이션타이밍" },
  { key: "export", label: "⑥ 내보내기" },
];

export const STEPS_CUT = [
  { key: "plan", label: "① 기획" },
  { key: "cutImages", label: "② 이미지" },
  { key: "cutAudio", label: "③ 오디오" },
  { key: "timeline", label: "④ 타임라인" },
  { key: "preview", label: "⑤ 미리보기/QC" },
  { key: "cutExport", label: "⑥ 내보내기" },
];

// Alpha 7: story/CUT은 자동 제작의 기본 흐름에서 제거하고 필요할 때만 여는 고급 편집 화면으로 유지한다.
// 직접 URL #/episode/:id/story 로 접근할 수 있으며 이미지 단계의 '고급 CUT 편집' 버튼에서 진입한다.

// 과거 코드 호환용 별칭 (예전에는 STEPS 하나만 있었음)
export const STEPS = STEPS_TEXT_CARD;

export function stepsFor(formatType) {
  return formatType === "cut" ? STEPS_CUT : STEPS_TEXT_CARD;
}


// Alpha 17 — 채널, 배포 형식, 제작 강도는 기존 seriesType/formatType과 독립된 축이다.
export const CONTENT_CHANNELS = Object.freeze([
  { key: "unassigned", label: "미지정·기타", description: "나중에 채널 지정" },
  { key: "senior_longform", label: "시니어 롱폼", description: "사연·인생·가족·감정형" },
  { key: "economy_current", label: "경제·시사·정치", description: "근거와 사실 검증 중심" },
  { key: "odd_today", label: "오늘도 이상하다", description: "유머·생활정보·일반 뉴스" },
  { key: "sports", label: "스포츠", description: "경기·선수·기록·화제" },
]);
export const CONTENT_FORMATS = Object.freeze([
  { key: "shorts", label: "Shorts" },
  { key: "longform", label: "Longform" },
]);
export const PRODUCTION_PROFILES = Object.freeze([
  { key: "fast", label: "FAST", description: "속도 우선 · 필요한 품질에 도달하면 빠르게 출고" },
  { key: "standard", label: "STANDARD", description: "속도와 완성도의 균형 · 기본 권장" },
  { key: "premium", label: "PREMIUM", description: "IP 일관성과 시각 완성도 우선" },
]);

// Alpha 24 — 채널과 콘텐츠 주제를 분리한다. 채널은 배포/브랜드 축이고,
// primaryCategory + secondaryTags는 소재/이야기 축이다. 경제 채널에서도 주거·직장·가족·세대·생활 등
// 경계 소재를 자유롭게 다룰 수 있어야 하므로 특정 채널을 특정 카테고리에 고정하지 않는다.
export const CONTENT_CATEGORIES = Object.freeze([
  { key: "general", label: "종합·미지정", description: "경계 소재 또는 아직 분류하지 않은 콘텐츠" },
  { key: "economy", label: "경제·돈", description: "소득·자산·세금·연금·물가·금리·투자" },
  { key: "housing", label: "주거·부동산", description: "집값·임대·주거비·이동·주거환경" },
  { key: "work", label: "직장·일", description: "고용·임금·직장문화·커리어·노동시장" },
  { key: "family", label: "가족·세대", description: "부모·자녀·세대격차·결혼·상속·가족경제" },
  { key: "daily_life", label: "일상생활", description: "소비·생활비·생활습관·생활현상" },
  { key: "society", label: "사회·제도", description: "정책·인구·교육·복지·사회구조" },
  { key: "senior", label: "시니어·노후", description: "노후·은퇴·고령층 삶·관계·재산" },
]);
export function contentChannelLabel(key) { return CONTENT_CHANNELS.find((x) => x.key === key)?.label || "미지정·기타"; }
export function contentFormatLabel(key) { return CONTENT_FORMATS.find((x) => x.key === key)?.label || "Shorts"; }
export function productionProfileLabel(key) { return PRODUCTION_PROFILES.find((x) => x.key === key)?.label || "STANDARD"; }
export function contentCategoryLabel(key) { return CONTENT_CATEGORIES.find((x) => x.key === key)?.label || "종합·미지정"; }


// Alpha 12 — 제작 진행 상태와 기존 STEP 상태(ep.status)는 서로 다른 축이다.
// lifecycleStatus는 홈 정리/보관/휴지통에만 사용하고 기존 STEP 진행 판정은 건드리지 않는다.
export const EPISODE_LIFECYCLE = Object.freeze({
  draft: "임시저장",
  ready: "제작대기",
  in_progress: "제작중",
  review: "검수대기",
  publish_ready: "발행대기",
  published: "발행완료",
  on_hold: "보류",
  trash: "폐기",
});

export const EPISODE_LIFECYCLE_KEYS = Object.freeze(Object.keys(EPISODE_LIFECYCLE));

export function normalizeEpisodeLifecycle(value, legacyStatus = "") {
  if (EPISODE_LIFECYCLE_KEYS.includes(value)) return value;
  return legacyStatus === "업로드완료" ? "published" : "in_progress";
}

export function episodeLifecycleLabel(value, legacyStatus = "") {
  return EPISODE_LIFECYCLE[normalizeEpisodeLifecycle(value, legacyStatus)];
}

export const STATUS_BY_STEP = {
  plan: "기획",
  scenes: "대본작성",
  duration: "대본작성",
  images: "이미지검수",
  narration: "나레이션동기화",
  export: "확정",
};

export const STATUS_BY_STEP_CUT = {
  plan: "기획",
  story: "스토리작성",
  cutImages: "이미지검수",
  cutAudio: "오디오작업",
  timeline: "타임라인편집",
  preview: "QC",
  cutExport: "확정",
};

export function statusByStepFor(formatType) {
  return formatType === "cut" ? STATUS_BY_STEP_CUT : STATUS_BY_STEP;
}

export const BADGE_COLOR_PRESETS = [
  { name: "블루", rgb: [60, 90, 200] },
  { name: "레드", rgb: [180, 60, 40] },
  { name: "청록", rgb: [40, 140, 170] },
  { name: "그린", rgb: [30, 160, 120] },
  { name: "퍼플", rgb: [100, 80, 180] },
  { name: "핑크", rgb: [200, 70, 130] },
  { name: "옐로우", rgb: [200, 160, 40] },
  { name: "화이트", rgb: [220, 220, 230] },
];

// CUT의 장면 목적 프리셋 (자유 입력도 허용하므로 select 힌트용)
export const CUT_PURPOSES = ["HOOK", "긴장", "발견", "반전", "개그", "엔딩", "기타"];

export const MOTION_TYPES = [
  "AUTO_BEATS",
  "STATIC",
  "PUSH_IN_SLOW",
  "PUSH_IN",
  "PUNCH_IN",
  "ZOOM_OUT",
  "PAN_LEFT",
  "PAN_RIGHT",
  "PAN_UP",
  "PAN_DOWN",
  "CUSTOM",
];

export const TRANSITION_TYPES = ["HARD_CUT", "FADE", "DISSOLVE"];

// Motion preset → 합리적인 기본값. 일반 사용자는 preset만 골라도 충분해야 하고,
// CUSTOM을 고르거나 "상세 설정"을 열었을 때만 scale/pan을 직접 만진다.
// panX/panY는 프레임 대비 상대 이동량(대략 -1~1 범위 참고값, 절대 픽셀이 아니다).
export const MOTION_PRESET_DEFAULTS = {
  AUTO_BEATS: null,
  STATIC: { startScale: 1, endScale: 1, panX: 0, panY: 0, easing: "linear" },
  PUSH_IN_SLOW: { startScale: 1, endScale: 1.08, panX: 0, panY: 0, easing: "ease-in-out" },
  PUSH_IN: { startScale: 1, endScale: 1.15, panX: 0, panY: 0, easing: "ease-in-out" },
  PUNCH_IN: { startScale: 1, endScale: 1.3, panX: 0, panY: 0, easing: "ease-out" },
  ZOOM_OUT: { startScale: 1.15, endScale: 1, panX: 0, panY: 0, easing: "ease-in-out" },
  PAN_LEFT: { startScale: 1.1, endScale: 1.1, panX: -0.12, panY: 0, easing: "linear" },
  PAN_RIGHT: { startScale: 1.1, endScale: 1.1, panX: 0.12, panY: 0, easing: "linear" },
  PAN_UP: { startScale: 1.1, endScale: 1.1, panX: 0, panY: -0.12, easing: "linear" },
  PAN_DOWN: { startScale: 1.1, endScale: 1.1, panX: 0, panY: 0.12, easing: "linear" },
  // CUSTOM은 강제 기본값이 없다 — 사용자가 마지막으로 쓰던 값을 그대로 유지한다.
  CUSTOM: null,
};

export function applyMotionPreset(cut, presetType) {
  cut.motion = cut.motion || {};
  cut.motion.type = presetType;
  if (presetType !== "AUTO_BEATS") delete cut.motion.visualBeats;
  const defaults = MOTION_PRESET_DEFAULTS[presetType];
  if (defaults) Object.assign(cut.motion, defaults);
  return cut;
}

// 이미지 QC 상태. "생성중"은 데이터 호환을 위해 남겨두지만(값이 있어도 안전하게 처리),
// Alpha 4부터 이미지 프록시가 연결된 경우 Nano Banana 생성을 호출할 수 있다. 생성중은 자동 상태로만 사용한다.
export const IMAGE_STATUSES = ["미생성", "생성중", "검수필요", "PASS", "RETRY", "확정"];
export const IMAGE_STATUS_SELECTABLE = ["검수필요", "PASS", "RETRY", "확정"];
export const IMAGE_APPROVED_STATUSES = ["PASS", "확정"];
export const IMAGE_GENERATORS = ["Gemini", "Grok", "GPT", "기타"];
export const RETRY_REASONS = ["공간관계", "캐릭터 불일치", "표정", "구도", "스타일", "해부학", "기타"];

export function isImageApproved(cut) {
  return !!(cut?.image?.assetId && IMAGE_APPROVED_STATUSES.includes(cut.image.status));
}

export function uid() {
  return "ep_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function cutUid() {
  return "cut_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export function dialogueUid() {
  return "dl_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export function audioEventUid() {
  return "aev_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

// ---- 오디오 이벤트(Phase 3) ----
// CUT 내부 오디오는 narration/dialogue/sfx/silence를 하나의 공통 배열(audioEvents)로 관리한다.
// 모든 이벤트가 동일한 flat shape을 갖되, 타입별로 의미 있게 쓰는 필드만 다르다:
//   narration: assetId, text, volume, fadeIn/fadeOut
//   dialogue:  assetId, speaker, text, voice, volume, fadeIn/fadeOut (+ sourceDialogueId로 STEP2 대사와 연결)
//   sfx:       assetId, name, volume, fadeIn/fadeOut, required(선택 여부 — NextActionEngine 판정용)
//   silence:   assetId 없음, duration 필수
// start는 항상 "CUT 시작 시점 기준 상대시간(초)"이다.
export const AUDIO_EVENT_TYPES = ["narration", "dialogue", "sfx", "silence"];

export function newAudioEvent(type = "sfx") {
  return {
    id: audioEventUid(),
    type,
    start: 0,
    duration: type === "silence" ? 1 : null, // silence는 duration 필수, 나머지는 파일 첨부 시 자동 측정됨
    // sourceDuration = 파일 metadata에서 측정된 "원본 그대로"의 길이(첨부/교체할 때마다 갱신).
    // duration = 실제 타임라인에 쓰이는 "편집용" 길이 — 처음 첨부 시 sourceDuration과 같은 값으로
    // 시작하지만, Timeline에서 사용자가 따로 조정하면 duration만 바뀌고 sourceDuration은 보존된다
    // (원본 측정값과 편집값이 서로 다른 개념임을 데이터로 명확히 구분).
    sourceDuration: null,
    assetId: null, // silence는 사용하지 않음
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    // dialogue 전용 연결 필드 — narration/sfx/silence에서는 null
    sourceDialogueId: null,
    speaker: "",
    text: "",
    voice: "",
    name: "", // sfx 전용
    required: false, // sfx 전용 — true면 파일이 없을 때 NextActionEngine이 필요로 안내
  };
}

// STEP 2의 dialogueLines(대본/창작 데이터)와 STEP 4의 audioEvents(실제 편집 타임라인 데이터)는
// 별도 배열로 유지한다 — sourceDialogueId로만 연결한다(대사 순서 index로 연결하지 않는다).
export function newDialogueLine() {
  return { id: dialogueUid(), speaker: "", text: "", offset: 0, voice: "" };
}

export const BGM_ACTIONS = ["continue", "lower", "raise", "stop", "fade_out"];

export const AUDIO_WORKFLOWS = ["attach_files", "external_tts", "none"];

// STEP 2(스토리) 완료 판정과 STEP 4(오디오)의 "이 CUT에 나레이션/대사 콘텐츠가 있는가" 판정이
// 서로 다른 곳에서 각자 기준을 만들면 어긋나기 쉽다 — 한 곳(hasStoryContent)에서만 정의한다.
// 대사는 speaker/voice/offset만 채워진 빈 행은 인정하지 않는다 — 실제 text가 있어야 한다.
export function hasStoryContent(cut) {
  if (!cut) return false;
  if (cut.narration && cut.narration.trim()) return true;
  return (cut.dialogueLines || []).some((line) => line?.text && line.text.trim());
}

// CUT에 여러 오디오 이벤트가 있을 때 duration.measured는 "가장 늦게 끝나는 이벤트의 끝 시각"이다
// (단순히 음성 파일 하나의 길이가 아니다). silence 이벤트도 포함한다.
// duration이 아직 없는(파일 미첨부) 이벤트는 계산에서 제외한다.
export function computeMeasuredDuration(cut) {
  const events = (cut?.audioEvents || []).filter((e) => e.duration != null);
  if (!events.length) return null;
  return Math.max(...events.map((e) => (e.start || 0) + e.duration));
}

// audioEvents가 바뀔 때마다 호출해서 duration.measured를 다시 계산해 넣는다.
// manual > measured > estimated 우선순위 원칙은 그대로 유지된다(measured를 갱신할 뿐,
// manual이 있으면 resolveCutDuration()에서 여전히 manual이 이긴다).
export function recalcMeasuredDuration(cut) {
  if (!cut) return cut;
  cut.duration = cut.duration || { manual: null, measured: null, estimated: null };
  cut.duration.measured = computeMeasuredDuration(cut);
  return cut;
}

// ---- text_card (레거시) 팩토리 — 기존 동작 그대로 보존 ----

export function newScene(i = 0) {
  return {
    badge: "",
    panel: i === 0 || i % 3 === 0,
    headline: "",
    caption: "",
    narration_line: "",
    headline_size: null,
    badge_color: [60, 90, 200],
    bg_top: [12, 12, 22],
    bg_bottom: [26, 28, 48],
    countup: null,
    extra_pad: 0,
    measured_start: null,
  };
}

// ---- cut (v2) 팩토리 — 신규 ----

export function newCut(i = 0) {
  return {
    id: cutUid(),
    index: i,
    purpose: "", // HOOK/긴장/발견/반전/개그/엔딩/기타 (CUT_PURPOSES 참고, 자유 입력 허용)
    situation: "",
    narration: "",
    directorNote: "",
    productionPrompt: "",
    // rc.3(Master Narration Mode) — episode.audioMode === "master_narration"일 때만 의미를
    // 갖는 필드. "이 CUT이 통합 나레이션 파일 안에서 실제로 시작하는 지점(초)"을 사용자가
    // 재생하며 직접 마킹한 값이다. null이면 아직 마킹 안 함(단, index 0은 관례상 0초로 자동
    // 취급 — getMasterStart() 참고). per_cut 모드에서는 그냥 쓰이지 않는 죽은 필드다.
    masterStart: null,
    dialogueLines: [], // [{ speaker, text, offset, voice }]
    // Alpha 43 — Mixed Timeline. image는 항상 fallback 자산으로 보존하고, mediaType=video일 때만
    // 외부 Flow MP4를 우선 사용한다. 기존 Episode는 migration에서 image 기본값을 받는다.
    mediaType: "image", // image | video
    video: { assetId: null, duration: null, trimStart: 0, trimEnd: null, mute: true },
    image: {
      assetId: null,
      status: "미생성", // 미생성/생성중/검수필요/PASS/RETRY/확정
      generator: "", // Gemini/Grok/GPT/기타
      qcNote: "",
      retryReason: "",
    },
    audioEvents: [], // [{ type: narration|dialogue|sfx|silence, ...}]
    duration: {
      manual: null, // 사용자가 직접 지정 — 최우선
      measured: null, // 오디오 실측 — 차순위
      estimated: null, // 글자수 기반 추정 — 참고값(최하위)
    },
    motion: {
      type: "STATIC",
      startScale: 1,
      endScale: 1,
      panX: 0,
      panY: 0,
      easing: "linear",
    },
    transition: "HARD_CUT",
    transitionDuration: 0, // HARD_CUT은 항상 0. FADE/DISSOLVE에서만 의미 있는 값.
    subtitle: { dialogue: true, narration: true },
  };
}

// HARD_CUT은 항상 0초 — transition 타입을 바꿀 때 이 헬퍼로 강제한다(뷰마다 따로 구현하지 않도록).
export function setCutTransition(cut, type, duration) {
  cut.transition = type;
  cut.transitionDuration = type === "HARD_CUT" ? 0 : Math.max(0, Number(duration) || 0);
  return cut;
}

// CUT 순서 변경/추가/삭제 후 index를 실제 배열 순서에 맞게 재계산한다.
// 안정적인 id(cut.id)는 절대 건드리지 않는다 — asset 참조가 cutId를 키로 삼기 때문.
export function reindexCuts(cuts) {
  cuts.forEach((c, i) => {
    c.index = i;
  });
  return cuts;
}

// CUT 복제 — 텍스트/연출 필드는 그대로 복사하되, id는 새로 발급하고
// 이미지/오디오/실측duration처럼 "이 CUT 고유의 산출물"은 복제하지 않고 초기화한다.
// (이미지를 그대로 공유하면 한쪽에서 삭제할 때 참조무결성 처리가 다른 쪽까지 건드리게 되어 혼란스럽다.)
export function duplicateCut(cut) {
  const clone = JSON.parse(JSON.stringify(cut));
  clone.id = cutUid();
  clone.mediaType = "image";
  clone.video = { assetId: null, duration: null, trimStart: 0, trimEnd: null, mute: true };
  clone.image = { assetId: null, status: "미생성", generator: "", qcNote: "", retryReason: "" };
  clone.audioEvents = [];
  clone.duration = { manual: null, measured: null, estimated: null };
  // 복제된 CUT은 "이 CUT 고유의 산출물"이 아직 없는 새 CUT과 같다 — 마스터 나레이션 시작
  // 마커도 이미지/오디오와 같은 원칙으로 초기화한다(원본의 마커를 그대로 물려받으면 두 CUT이
  // 같은 시작점을 가리키게 되어 duration이 0/음수로 깨진다).
  clone.masterStart = null;
  return clone;
}

// duration 우선순위: manual > measured > estimated
export function resolveCutDuration(cut) {
  const d = cut?.duration || {};
  if (d.manual != null) return d.manual;
  if (d.measured != null) return d.measured;
  if (d.estimated != null) return d.estimated;
  return null;
}

// ---- Master Narration Mode(rc.3) ----
//
// 실제 사용자 Workflow: GPT로 대본 확정 → CapCut에서 화자 하나로 전체 나레이션을 한 번에
// 생성 → Tracker에 그 파일 1개를 등록 → 재생하면서 각 CUT이 실제로 시작하는 지점만 마킹 →
// "다음 마커 - 이 마커" 로 CUT duration을 역산. CUT마다 별도 나레이션 파일을 만드는 것은
// 기본 Workflow가 아니므로, 이 계산 결과를 cut.duration.measured에 그대로 써 넣어 기존
// manual > measured > estimated 우선순위(resolveCutDuration)를 전혀 새로 만들지 않고 그대로
// 재사용한다 — Timeline/Preview/production.json이 전부 resolveCutDuration() 하나만 보므로
// "서로 다른 duration을 계산"할 여지 자체가 없다. describeCutDuration()(timeline.js)에서만
// source를 "measured" 대신 "master"로 구분해 보여준다(우선순위/계산 결과는 동일).
//
// rc.4: CUT1(index 0)은 항상 0.00초로 고정한다 — 사용자가 다시 마킹해서 덮어쓸 수 없다(V2
// 범위에서는 단순화). rc.3에서는 "관례상 0초 자동 처리, 단 직접 마킹하면 그 값 우선"으로
// 두었는데, 이것이 Preview 재생 구조(합성 마스터 나레이션 블록의 globalStart가 항상 0이라는
// 전제 — buildTimeline() 참고)와 충돌할 수 있다는 코드 리뷰 지적을 받아 규칙을 하나로
// 통일했다. cut.masterStart 필드 자체는 지우지 않는다(과거에 이미 값이 저장돼 있어도 그냥
// 무시할 뿐이다 — 비파괴적) — 다만 CUT1용 UI(cutAudioStep.js)에서 더 이상 마킹 버튼을
// 노출하지 않으므로 앞으로 새로 저장될 일은 없다. intro/pre-roll offset이 필요해지면 이번
// V2 범위가 아니라 별도 기능으로 설계한다.
export function getMasterStart(cut, index) {
  if (index === 0) return 0;
  return cut && cut.masterStart != null ? cut.masterStart : null;
}

// Master Narration의 CUT 시작 마커들로부터 각 CUT의 duration을 역산해 cut.duration.measured에
// 채운다. 마커가 없거나(2번째 이후 CUT은 반드시 마킹 필요) 다음 마커가 현재 마커보다 앞서면
// (순서가 뒤엉키면) 그 CUT은 계산하지 않고 null로 남긴다 — 억지로 값을 만들어내지 않는다,
// NextActionEngine이 이 상태를 정직하게 blocker로 보고한다.
export function recalcMasterNarrationDurations(ep) {
  if (!ep || ep.formatType !== "cut") return ep;
  const cuts = ep.cuts || [];
  const total = ep.masterNarration && ep.masterNarration.duration != null ? ep.masterNarration.duration : null;
  const starts = cuts.map((c, i) => getMasterStart(c, i));
  cuts.forEach((cut, i) => {
    const start = starts[i];
    let derived = null;
    if (start != null) {
      if (i < cuts.length - 1) {
        const next = starts[i + 1];
        if (next != null && next > start) derived = next - start;
      } else if (total != null && total > start) {
        derived = total - start;
      }
    }
    cut.duration = cut.duration || { manual: null, measured: null, estimated: null };
    cut.duration.measured = derived;
  });
  return ep;
}

// episode.audioMode(또는 그 모드에 영향을 주는 데이터: CUT 구성/마커/마스터 파일)가 바뀔
// 때마다 이 함수 하나만 호출한다 — 두 모드가 서로 다른 곳에서 각자 cut.duration.measured를
// 계산하다 어긋나는 일이 없도록 진입점을 하나로 통일한다. per_cut으로 전환/유지 중이면
// 기존 recalcMeasuredDuration(오디오 이벤트 기반)으로, master_narration이면 마커 기반으로.
export function recalcAudioModeDurations(ep) {
  if (!ep || ep.formatType !== "cut") return ep;
  if (ep.audioMode === "master_narration") {
    recalcMasterNarrationDurations(ep);
  } else {
    (ep.cuts || []).forEach((cut) => recalcMeasuredDuration(cut));
  }
  return ep;
}

// ---- episode 팩토리 ----
// formatType 기본값은 "cut" — v2 신규 에피소드는 CUT형이 기본이다.
// 기존 v1 레코드는 migration.js에서 formatType: "text_card"가 부여된다(여기서는 신규 생성만 다룬다).

export function newEpisode(seriesType = "general_issue", formatType = "cut") {
  const now = Date.now();
  const common = {
    id: uid(),
    seriesType,
    formatType,
    channelKey: "unassigned",
    contentFormat: "shorts",
    productionProfile: "standard",
    // Alpha 24: 채널과 독립된 소재 분류. 하나의 Primary + 여러 Secondary Tags.
    primaryCategory: "general",
    secondaryTags: [],
    categorySource: "auto", // auto | manual | bm
    // V5 Automation Core — 채널/형식별 반복 제작 규칙의 단일 상태.
    automationPlan: {
      schemaVersion: "1.0",
      mode: "auto_first",
      seamlessLoop: {
        enabled: true,
        requiredForEconomyShorts: true,
        openingIntent: "마지막 장면의 공간/상황과 자연스럽게 이어지는 시작",
        closingIntent: "첫 장면으로 다시 이어져도 끝/시작 경계가 튀지 않는 마무리"
      },
      longform: {
        enabled: false,
        targetMinutes: 20,
        chapterCount: 7,
        visualChangeSeconds: 18,
        narrationMode: "master_narration",
        autoQc: true,
        autoStoryboard: true,
        autoTimeline: true,
        scenePlan: []
      }
    },
    title: "",
    date: "",
    subject: "",
    sources: [],
    status: "기획",
    lifecycleStatus: "draft",
    lifecycleChangedAt: now,
    trashedAt: null,
    metaDescription: "",
    metaHashtags: "",
    metaTitleCandidates: "",
    metaSelectedTitle: "",
    metaTags: "",
    metaPinnedComment: "",
    metaThumbnail: "",
    // V4 Alpha 20: CUT 이미지와 분리된 episode-level 썸네일 제작 상태
    thumbnail: null,
    createdAt: now,
    updatedAt: now,
  };

  if (formatType === "text_card") {
    return {
      ...common,
      scenes: Array.from({ length: 8 }, (_, i) => newScene(i)),
      narrationAudioName: "",
    };
  }

  // formatType === "cut"
  return {
    ...common,
    thumbnail: { schemaVersion: "1.0", conceptId: "auto", resolvedConceptId: seriesType === "two_year_intern" ? "character_focus" : seriesType === "horror" ? "curiosity" : "channel_default", customConcept: "", headline: "", subline: "", sourceCutIndex: 0, prompt: "", assetId: null, status: "planned", updatedAt: null },
    cuts: [], // CUT 개수 고정 없음 — 사용자가 자유롭게 추가
    globalVisualBible: "",
    styleReferenceAssetId: null,
    characterReferenceAssetId: null,
    // fadeIn/fadeOut(초)/fadeCurve(Phase 5) — 실제 볼륨 페이드는 Preview 재생에서만 쓰인다.
    // 기존 데이터에 이 필드들이 없으면(Phase 4 이전 episode) migration.js가 0/"linear"로
    // 안전하게 채운다 — 파괴적 변경 없음. fadeCurve는 지금은 "linear"만 실제로 동작하지만,
    // 향후 ease-in/ease-out/custom을 추가할 수 있도록 문자열 필드로 미리 분리해둔다.
    bgm: { assetId: null, start: 0, end: null, volume: 1, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", cutActions: {} },
    // 오디오를 어떻게 준비할지: 파일 직접 첨부(기본) / 외부 TTS로 대체 / 오디오 없음.
    // 확장 가능하게 값만 두고, Phase 3에서는 "attach_files" 흐름만 실제로 구현한다.
    audioWorkflow: "attach_files",
    // rc.3(Master Narration Mode) — 실제 사용자 Workflow(CapCut 등에서 화자 하나로 통합
    // 나레이션 1개를 만든 뒤, 그 파일 안에서 CUT 시작점만 마킹해 duration을 역산)를 반영한
    // 오디오 준비 방식. "master_narration"(기본/권장 — 신규 CUT 에피소드) | "per_cut"(CUT마다
    // 개별 나레이션 파일을 붙이는 기존 방식, Advanced Mode로 계속 지원). 기존(마이그레이션된)
    // 에피소드는 이 필드가 원래 없었으므로 migration.js가 "per_cut"으로 채워 기존 동작을
    // 그대로 보존한다(non-destructive) — 신규 에피소드만 여기서 기본값 master_narration을 받는다.
    audioMode: "master_narration",
    // audioMode==="master_narration"일 때만 쓰는 단일 파일 슬롯. 파일명은 절대 분석하지
    // 않는다(사용자가 이미 "전체 나레이션" 슬롯에 첨부했다는 것 자체가 컨텍스트이므로).
    masterNarration: { assetId: null, duration: null },
    // Timeline을 사용자가 실제로 "검토했다"는 명시적 확인 시각(Phase 4) — null이면 미검토.
    // 자동 계산(duration/경고 없음)만으로는 검토 완료로 치지 않는다. Timeline에 영향을 주는
    // 데이터가 바뀌면 invalidateTimelineReview()로 다시 null로 되돌려 재검토를 요구한다.
    timelineReviewedAt: null,
    // Preview/QC(Phase 5)를 사용자가 실제로 "검토했다"는 명시적 확인 시각 — null이면 미검토.
    // QC ERROR가 0건이라는 자동 판정만으로는 검토 완료로 치지 않는다. 실제 렌더 결과에 영향을
    // 주는 데이터가 바뀌면 invalidatePreviewReview()로 다시 null로 되돌려 재검토를 요구한다.
    previewReviewedAt: null,
    // Phase 6: production.json 렌더 기본값 — 지금은 편집 화면이 없지만(조건 5번 "향후 변경
    // 가능하도록 구조를 고려"), 나중에 설정 화면이 생기면 이 필드만 채우면 된다.
    renderSettings: { width: 1080, height: 1920, fps: 30 },
    // Phase 6: production.json을 마지막으로 "생성"(다운로드 또는 최종 확정)한 시각/그 시점의
    // fingerprint. episode 안에 production.json 전체를 중복 저장하지 않는다(조건 20번) —
    // 필요할 때 production.js가 다시 계산할 수 있으므로 이 최소 메타데이터만 남긴다.
    lastProductionGeneratedAt: null,
    lastProductionRevision: null,
    // V4 Alpha 1 — AI Provider와 무관한 작업공간 상태. 실제 API 호출/키는 저장하지 않는다.
    aiWorkspace: {
      contractVersion: "1.0",
      providerId: null,
      modelId: "",
      status: "idle",
      lastTaskType: null,
      lastRequestAt: null,
      lastResultAt: null,
      lastError: "",
      promptInput: "",
      lastResult: null,
    },
    // V4 Alpha 1 — Built-in 제작 Recipe 선택/적용 상태. 커스텀 Recipe 저장은 후속 Alpha 범위.
    recipeState: {
      schemaVersion: "1.0",
      selectedId: seriesType === "horror" ? "horror_tension" : seriesType === "two_year_intern" ? "two_year_intern_deadpan" : seriesType === "freeform" ? "freeform_balanced" : "general_issue_fast",
      appliedId: null,
      appliedAt: null,
      source: "builtin",
    },
  };
}

// Timeline에 영향을 주는 데이터(CUT 구성/길이/모션/트랜지션/오디오 이벤트 등)가 바뀌면
// "검토 완료" 상태를 무효화한다 — 자동 계산이 끝났다고 사용자가 확인한 것으로 간주하지 않는다.
export function invalidateTimelineReview(ep) {
  if (ep && ep.formatType === "cut") ep.timelineReviewedAt = null;
  return ep;
}

// 실제 렌더 결과(영상 리듬)에 영향을 주는 데이터가 바뀌면 Preview "검토 완료" 상태를
// 무효화한다 — CUT 순서/duration/이미지/모션/트랜지션/오디오/자막/BGM이 대상이다.
// Story의 단순 메모(situation/directorNote 등)처럼 최종 결과물에 영향을 주지 않는 텍스트
// 편집까지 무효화하지는 않는다 — 호출부가 "렌더에 영향을 주는 변경"에서만 이 함수를 부른다.
export function invalidatePreviewReview(ep) {
  if (ep && ep.formatType === "cut") ep.previewReviewedAt = null;
  return ep;
}

// 오디오 파일을 (재)첨부할 때 공통으로 쓰는 헬퍼 — 원본 실측값(sourceDuration)과 편집용
// duration을 항상 같은 새 값으로 함께 갱신한다(새 파일이니 이전 편집값은 더 이상 의미가 없다).
// 이후 Timeline에서 duration만 따로 조정해도 sourceDuration(원본 실측값)은 보존된다.
export function applyMeasuredDuration(evt, measuredSeconds) {
  if (measuredSeconds == null) return evt;
  evt.sourceDuration = measuredSeconds;
  evt.duration = measuredSeconds;
  return evt;
}

// ---- Caption Style Preset (v2.1-rc.1, 작업지시서 1-C) ----
//
// 원칙:
// - 자막 "타이밍/텍스트"(subtitleEvents, cut.narration, dialogueLines)와 자막 "모양"은 완전히
//   분리된 관심사다 — 스타일 값을 바꿔도 타이밍/텍스트 데이터는 절대 건드리지 않는다.
// - 값은 픽셀 고정이 아니라 9:16 프레임 기준 정규화(% 등 상대) 값으로 저장한다 — 나중에 실제
//   렌더 해상도(1080x1920 등)가 바뀌어도 그대로 재사용 가능해야 한다.
// - 폰트: "교보손글씨2025" 같은 라이선스 미확인 폰트 파일은 앱에 절대 번들하지 않는다.
//   FONT 후보들의 cssStack은 모두 "이름이 있으면 그 폰트, 없으면 시스템 sans"로 안전하게
//   대체되는 CSS font-family 문자열이다 — 실제 파일을 앱이 갖고 있다는 보장은 하지 않는다.
//   UI(previewStep.js)는 폰트 실사용 가능 여부를 감지해 fallback 여부를 사용자에게 표시한다.
export const CAPTION_FONT_OPTIONS = [
  // v2.1-rc.3 — 모바일에서 고를 수 있는 한글 폰트 후보를 확장한다. 폰트 파일 자체를 앱에
  // 번들하지 않는 원칙은 그대로 유지한다. 각 항목은 기기/브라우저에 해당 폰트가 있으면
  // 그 폰트를 사용하고, 없으면 cssStack의 다음 안전 폰트로 자동 대체된다. previewStep.js가
  // 실제 사용 가능 여부를 확인해 선택창과 미리보기에 표시한다.
  // probeFamily: Font Loading API에서 실제 설치/사용 가능 여부를 확인할 대표 family 이름.
  { id: "kyobo_handwriting_2025", label: "교보손글씨2025", cssStack: `"교보손글씨2025", "Noto Sans CJK KR", "Noto Sans KR", system-ui, sans-serif`, probeFamily: "교보손글씨2025", knownUnbundled: true },
  { id: "samsung_one_korean", label: "SamsungOne Korean", cssStack: `"SamsungOneKorean", "SamsungOne", "Noto Sans CJK KR", system-ui, sans-serif`, probeFamily: "SamsungOneKorean", knownUnbundled: true },
  { id: "samsung_one", label: "SamsungOne", cssStack: `"SamsungOne", "Noto Sans CJK KR", system-ui, sans-serif`, probeFamily: "SamsungOne", knownUnbundled: true },
  { id: "noto_sans_cjk_kr", label: "Noto Sans CJK KR", cssStack: `"Noto Sans CJK KR", "Noto Sans KR", system-ui, sans-serif`, probeFamily: "Noto Sans CJK KR", knownUnbundled: true },
  { id: "noto_sans_kr", label: "Noto Sans KR", cssStack: `"Noto Sans KR", "Noto Sans CJK KR", system-ui, sans-serif`, probeFamily: "Noto Sans KR", knownUnbundled: true },
  { id: "noto_serif_cjk_kr", label: "Noto Serif CJK KR", cssStack: `"Noto Serif CJK KR", "Noto Serif KR", serif`, probeFamily: "Noto Serif CJK KR", knownUnbundled: true },
  { id: "noto_serif_kr", label: "Noto Serif KR", cssStack: `"Noto Serif KR", "Noto Serif CJK KR", serif`, probeFamily: "Noto Serif KR", knownUnbundled: true },
  { id: "nanum_gothic", label: "나눔고딕", cssStack: `"NanumGothic", "나눔고딕", "Noto Sans CJK KR", system-ui, sans-serif`, probeFamily: "NanumGothic", knownUnbundled: true },
  { id: "nanum_myeongjo", label: "나눔명조", cssStack: `"NanumMyeongjo", "나눔명조", "Noto Serif CJK KR", serif`, probeFamily: "NanumMyeongjo", knownUnbundled: true },
  { id: "malgun_gothic", label: "맑은 고딕", cssStack: `"Malgun Gothic", "맑은 고딕", "Noto Sans CJK KR", system-ui, sans-serif`, probeFamily: "Malgun Gothic", knownUnbundled: true },
  { id: "apple_sd_gothic_neo", label: "Apple SD Gothic Neo", cssStack: `"Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif`, probeFamily: "Apple SD Gothic Neo", knownUnbundled: true },
  { id: "system_default", label: "시스템 기본 글꼴", cssStack: `-apple-system, system-ui, "Noto Sans CJK KR", sans-serif`, probeFamily: null, knownUnbundled: false },
];
export const DEFAULT_CAPTION_FONT_ID = "kyobo_handwriting_2025";

export const CAPTION_FONT_WEIGHTS = [400, 500, 600, 700, 800];
export const CAPTION_TEXT_ALIGNS = ["left", "center", "right"];

// CHANNEL_TOP_CAPTION — 현재 채널 CapCut 레퍼런스를 그대로 옮긴 기본 프리셋(작업지시서 1-C
// "현재 채널 레퍼런스" 항목 그대로): 상단 중앙, 흰 글자, 얇은 검정 외곽선, 최대 2줄, 폭
// 70~75%, 상단 14~16% 위치, 배경 박스 없음, 은은한 그림자.
export function newCaptionStyle() {
  return {
    presetId: "CHANNEL_TOP_CAPTION",
    fontId: DEFAULT_CAPTION_FONT_ID,
    fontSizePct: 4.2, // canvas 폭(=9:16 프레임 폭) 대비 %. previewStep.js가 canvas 실제 px 폭에 곱해 px로 환산한다.
    fontWeight: 700,
    textAlign: "center",
    topPct: 15, // 프레임 세로 기준 상단에서부터 %
    horizontalAlign: "center", // "center" | "left" | "right" — center면 leftPct 무시
    leftPct: 50,
    maxWidthPct: 72, // 프레임 가로 기준 %
    maxLines: 2,
    lineHeight: 1.35,
    textColor: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 1.5, // px 유사 단위(canvas 폭 대비 정규화는 previewStep.js가 처리)
    shadow: true,
    shadowIntensity: 0.5, // 0~1
    backgroundBox: false,
    backgroundColor: "#000000",
    backgroundOpacity: 0.55,
    backgroundRadius: 8,
  };
}

const CAPTION_STYLE_NUMERIC_RANGES = {
  fontSizePct: [1, 15],
  fontWeight: [100, 900],
  topPct: [0, 95],
  leftPct: [0, 100],
  maxWidthPct: [20, 100],
  maxLines: [1, 6],
  lineHeight: [1, 2.5],
  strokeWidth: [0, 8],
  shadowIntensity: [0, 1],
  backgroundOpacity: [0, 1],
  backgroundRadius: [0, 40],
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isHexColor(s) {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
}

// 프리셋으로 이름 붙여 저장된 미리 정의된 스타일 목록 — 지금은 기본 1개뿐이지만, 향후 채널별
// 프리셋이 늘어나도 이 배열만 확장하면 된다(UI의 "프리셋 선택" 드롭다운이 이 배열을 그대로 씀).
export function economyLongformCaptionStyle() {
  return {
    ...newCaptionStyle(),
    presetId: "ECONOMY_LONGFORM_SPEECH_BEAT",
    fontSizePct: 4.35,
    fontWeight: 700,
    textAlign: "center",
    topPct: 82,
    horizontalAlign: "center",
    leftPct: 50,
    maxWidthPct: 88,
    maxLines: 1,
    lineHeight: 1.2,
    textColor: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 1.7,
    shadow: true,
    shadowIntensity: 0.65,
    backgroundBox: true,
    backgroundColor: "#000000",
    backgroundOpacity: 0.68,
    backgroundRadius: 6,
    captionBeatMode: "speech",
    captionBeatTargetChars: 16,
    captionBeatMaxChars: 22,
  };
}

export const CAPTION_STYLE_PRESETS = [
  { id: "CHANNEL_TOP_CAPTION", label: "채널 기본(상단 중앙)", build: newCaptionStyle },
  { id: "ECONOMY_LONGFORM_SPEECH_BEAT", label: "경제 롱폼(하단 1줄 비트)", build: economyLongformCaptionStyle },
];

// episode.captionStyle을 안전하게 읽는 단일 진입점. 아래 세 경우 모두 안전한 완전한 객체를
// 반환한다 — 호출부(previewStep.js)가 매번 null 체크/필드별 기본값을 반복하지 않아도 된다:
//   1) 필드 자체가 없는 기존 episode(마이그레이션 대상 아님 — 비파괴 fallback)
//   2) 값이 있지만 일부 필드가 빠져 있는 경우(과거 버전에서 저장된 부분 객체)
//   3) 값이 있지만 범위를 벗어나거나 타입이 잘못된 경우(수동 조작/손상된 백업 복원 등) — clamp
export function resolveCaptionStyle(ep) {
  const economyLongform = ep?.channelKey === "economy_current" && ep?.contentFormat === "longform";
  const base = economyLongform ? economyLongformCaptionStyle() : newCaptionStyle();
  const raw = ep && typeof ep.captionStyle === "object" && ep.captionStyle !== null ? ep.captionStyle : {};
  const out = { ...base, ...raw };

  Object.entries(CAPTION_STYLE_NUMERIC_RANGES).forEach(([key, [min, max]]) => {
    const v = Number(out[key]);
    out[key] = Number.isFinite(v) ? clamp(v, min, max) : base[key];
  });
  out.maxLines = Math.round(out.maxLines);
  out.fontWeight = Math.round(out.fontWeight / 100) * 100;
  if (!CAPTION_FONT_WEIGHTS.includes(out.fontWeight)) out.fontWeight = base.fontWeight;

  if (!CAPTION_TEXT_ALIGNS.includes(out.textAlign)) out.textAlign = base.textAlign;
  if (!["center", "left", "right"].includes(out.horizontalAlign)) out.horizontalAlign = base.horizontalAlign;
  if (!isHexColor(out.textColor)) out.textColor = base.textColor;
  if (!isHexColor(out.strokeColor)) out.strokeColor = base.strokeColor;
  if (!isHexColor(out.backgroundColor)) out.backgroundColor = base.backgroundColor;
  if (!CAPTION_FONT_OPTIONS.some((f) => f.id === out.fontId)) out.fontId = base.fontId;
  out.shadow = !!out.shadow;
  out.backgroundBox = !!out.backgroundBox;
  out.presetId = typeof out.presetId === "string" && out.presetId ? out.presetId : base.presetId;

  return out;
}

export function captionStyleSignature(epOrStyle) {
  const style = epOrStyle && epOrStyle.captionStyle ? resolveCaptionStyle(epOrStyle) : resolveCaptionStyle({ captionStyle: epOrStyle || {} });
  const keys = [
    "fontId","fontSizePct","fontWeight","textAlign","topPct","horizontalAlign","leftPct",
    "maxWidthPct","maxLines","lineHeight","textColor","strokeColor","strokeWidth","shadow",
    "shadowIntensity","backgroundBox","backgroundColor","backgroundOpacity","backgroundRadius"
  ];
  return keys.map((k) => `${k}:${String(style[k])}`).join("|");
}

export function captionFontStack(fontId) {
  const found = CAPTION_FONT_OPTIONS.find((f) => f.id === fontId);
  return found ? found.cssStack : CAPTION_FONT_OPTIONS[0].cssStack;
}
