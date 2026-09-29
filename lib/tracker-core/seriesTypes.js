// Series Type 레지스트리 — 콘텐츠/IP 종류를 정의하는 단일 소스.
// formatType(제작 구조: text_card | cut)과는 완전히 독립적인 축이다.
// 새 시리즈 타입을 추가하려면 이 배열에 항목을 추가하기만 하면 된다 —
// 다른 파일(홈 화면 생성 버튼, 기획STEP, 재생시간STEP 등)은 전부 이 배열을 순회해서 렌더링하므로
// "if (seriesType === 'horror')" 같은 하드코딩을 코드 곳곳에 두지 않는다.

import { RATE_NORMAL, RATE_SLOW, RATE_HORROR } from "./sceneTiming.js";

export const SERIES_TYPES = [
  {
    key: "general_issue",
    label: "일반 이슈",
    shortLabel: "이슈",
    legacyKeys: ["issue"], // v1 데이터의 구 seriesType 값 → 이 키로 정규화
    ratePreset: RATE_SLOW,
    description: "뉴스/정책 등 시사 이슈 카드뉴스·CUT 콘텐츠",
  },
  {
    key: "horror",
    label: "괴담",
    shortLabel: "괴담",
    legacyKeys: ["horror"],
    ratePreset: RATE_HORROR,
    description: "공포/괴담류 콘텐츠",
  },
  {
    key: "two_year_intern",
    label: "두살인턴",
    shortLabel: "두살인턴",
    legacyKeys: [],
    ratePreset: RATE_NORMAL,
    description: "두살인턴 시리즈 전용",
  },
  {
    key: "freeform",
    label: "자유형",
    shortLabel: "자유형",
    legacyKeys: [],
    ratePreset: null, // 프리셋 없음 — 재생시간STEP에서 수동 rate 입력을 허용
    description: "프리셋 없이 자유롭게 제작",
  },
];

const DEFAULT_KEY = SERIES_TYPES[0].key;

export function getSeriesType(key) {
  if (!key) return null;
  return (
    SERIES_TYPES.find((s) => s.key === key) ||
    SERIES_TYPES.find((s) => (s.legacyKeys || []).includes(key)) ||
    null
  );
}

// 알 수 없거나 레거시 키를 항상 현재 레지스트리의 key로 정규화한다.
// 레지스트리에 없는 값이 들어와도 절대 throw하지 않고 기본값으로 안전하게 폴백한다.
export function normalizeSeriesTypeKey(key) {
  const st = getSeriesType(key);
  return st ? st.key : DEFAULT_KEY;
}

export function seriesTypeLabel(key) {
  const st = getSeriesType(key);
  return st ? st.label : key || "(미지정)";
}

export function ratePresetForSeriesType(key) {
  const st = getSeriesType(key);
  return (st && st.ratePreset) || RATE_NORMAL;
}
