// scene_timing.py 로직을 그대로 이식 (오늘의 이슈/괴담 제작 프로세스 문서의 2026.08 표준)
export const RATE_NORMAL = 6.9; // 일반
export const RATE_SLOW = 6.4;   // 정치/뉴스형 ("오늘의 이슈")
export const RATE_HORROR = 6.2; // 공포형 ("오늘의 괴담")
export const PAD = 0.7;
export const FLOOR = 3.5;

export function ratePresetFor(seriesType) {
  return seriesType === "horror" ? RATE_HORROR : RATE_SLOW;
}

// lines: string[] (씬별 나레이션 문장), extraPad: { [index]: number }
export function estimateSceneDurations(lines, { rate, pad = PAD, floor = FLOOR, extraPad = {} } = {}) {
  return lines.map((line, i) => {
    const nChars = (line || "").replace(/[\s·]/g, "").length;
    const d = nChars / rate + pad + (extraPad[i] || 0);
    return Math.max(floor, Math.round(d * 10) / 10);
  });
}

// 실측 타이밍 배열([0.0, t1, t2, ..., totalDur])로부터 씬별 duration 계산
export function durationsFromMeasuredStarts(starts) {
  const durs = [];
  for (let i = 0; i < starts.length - 1; i++) {
    durs.push(Math.round((starts[i + 1] - starts[i]) * 100) / 100);
  }
  return durs;
}
