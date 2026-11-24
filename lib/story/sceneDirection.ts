// B-1: 장면 연출(direction) 데이터 계약 — 문자열, 최대 600자. 대본 작성과 같은 Claude 호출에서 함께 생성한다(추가 AI 호출 없음).
export const DIRECTION_MAX = 600

export const DIRECTION_PROMPT = `direction: 해당 장면의 시각적 연출(장면 구도, 인물 동작, 배경 등)을 ${DIRECTION_MAX}자 이내 한 문자열로 적는다. 내레이션을 반복하지 않고 화면에 실제로 보일 것만 쓴다.`

export function normalizeDirection(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text ? Array.from(text).slice(0, DIRECTION_MAX).join('') : undefined
}

// draft의 모든 segment.direction을 계약에 맞게 정리한다(없는 값은 만들지 않는다 → 이전 응답과 하위 호환).
export function normalizeDraftDirections(draft: any): any {
  for (const chapter of Array.isArray(draft?.chapters) ? draft.chapters : []) {
    for (const segment of Array.isArray(chapter?.segments) ? chapter.segments : []) {
      if (!segment || typeof segment !== 'object') continue
      const direction = normalizeDirection(segment.direction)
      if (direction) segment.direction = direction
      else delete segment.direction
    }
  }
  return draft
}

// 전체 수정본이 direction을 지웠거나 비워 두면 같은 챕터·같은 순서의 기존 direction을 되살린다. 구조가 달라진 챕터는 건드리지 않는다.
export function preserveDirections(original: any, revised: any): any {
  const originalChapters = Array.isArray(original?.chapters) ? original.chapters : []
  for (const chapter of Array.isArray(revised?.chapters) ? revised.chapters : []) {
    const before = originalChapters.find((c: any) => Number(c?.chapterNo) === Number(chapter?.chapterNo))
    const beforeSegments = Array.isArray(before?.segments) ? before.segments : []
    const segments = Array.isArray(chapter?.segments) ? chapter.segments : []
    if (beforeSegments.length !== segments.length) continue
    segments.forEach((segment: any, index: number) => {
      if (!segment || typeof segment !== 'object' || normalizeDirection(segment.direction)) return
      const kept = normalizeDirection(beforeSegments[index]?.direction)
      if (kept) segment.direction = kept
    })
  }
  return normalizeDraftDirections(revised)
}
