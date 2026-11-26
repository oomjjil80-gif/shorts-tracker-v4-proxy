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

// E-1: 확정된 나레이션은 그대로 두고 "연출이 없는 장면"의 연출만 만드는 요청의 입력 검사와 결과 정리(모델 호출 없음, 결정적).
// 나레이션·수동 프롬프트·라벨은 입력 맥락일 뿐 응답으로 돌려받지 않는다. 요청한 장면 번호의 연출만 인정한다.
export const FILL_MAX_SCENES = 60
export type FillScene = { sceneIndex: number; label: string; narration: string; prompt: string; direction: string }
export function parseFillDirectionsInput(input: any): { scenes: FillScene[]; targets: number[]; title: string; summary: string } | { error: string } {
  const list = Array.isArray(input?.scenes) ? input.scenes : []
  if (!list.length || list.length > FILL_MAX_SCENES) return { error: `scenes must contain 1-${FILL_MAX_SCENES} scenes` }
  const scenes: FillScene[] = list.map((s: any, i: number) => ({
    sceneIndex: Number(s?.sceneIndex ?? i + 1), label: String(s?.label ?? '').slice(0, 200), narration: String(s?.narration ?? '').trim().slice(0, 4000),
    prompt: String(s?.prompt ?? '').trim().slice(0, 2000), direction: normalizeDirection(s?.direction) || ''
  }))
  if (scenes.some((s, i) => s.sceneIndex !== i + 1 || !s.narration)) return { error: 'every scene needs its number (1..n in order) and narration' }
  const targets = [...new Set((Array.isArray(input?.targets) ? input.targets : []).map(Number))] as number[]
  if (!targets.length || targets.some((t) => !Number.isInteger(t) || t < 1 || t > scenes.length)) return { error: 'targets must be scene numbers within the given scenes' }
  return { scenes, targets: targets.sort((a, b) => a - b), title: String(input?.title ?? '').slice(0, 200), summary: String(input?.summary ?? '').slice(0, 1500) }
}
export function fillDirectionsPrompt(p: { scenes: FillScene[]; targets: number[]; title: string; summary: string }): string {
  return [
    '당신은 영상 연출가다. 확정된 장면별 나레이션을 읽고, 지정된 장면의 시각 연출(direction)만 작성한다.',
    `- 지정된 장면 번호(${p.targets.join(', ')})의 direction만 돌려준다. 다른 장면과 나레이션·제목·라벨은 쓰지 않는다.`,
    `- direction: 장면 구도, 인물 동작, 배경 등 화면 연출을 ${DIRECTION_MAX}자 이내 한 문자열로 쓴다. 나레이션을 반복하지 않고 새 사실·숫자를 만들지 않는다.`,
    '- 이미지에 글자·자막을 넣는 지시는 쓰지 않는다. 화풍·화면 비율·캐릭터 외형은 바꾸지 않는다(수동 프롬프트가 있으면 그것과 어긋나지 않게 한다).',
    '- 앞뒤 장면과 이어지게(같은 인물·장소의 연속성) 쓴다.',
    p.title ? `[제목] ${p.title}` : '', p.summary ? `[요약]\n${p.summary}` : '',
    '[장면 목록]',
    JSON.stringify(p.scenes.map((s) => ({ sceneIndex: s.sceneIndex, label: s.label, narration: s.narration, ...(s.prompt ? { manualPrompt: s.prompt } : {}), ...(s.direction ? { existingDirection: s.direction } : {}), needsDirection: p.targets.includes(s.sceneIndex) })), null, 2)
  ].filter(Boolean).join('\n')
}
export const FILL_DIRECTIONS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['directions'],
  properties: { directions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['sceneIndex', 'direction'], properties: { sceneIndex: { type: 'integer' }, direction: { type: 'string' } } } } }
}
// 모델 응답에서 요청한 장면의 연출만 꺼낸다. 요청하지 않은 장면은 버리고, 하나라도 비었거나 빠지면 불완전(성공 아님)이다.
export function pickRequestedDirections(parsed: any, targets: number[]): { ok: true; directions: Array<{ sceneIndex: number; direction: string }> } | { ok: false; missing: number[] } {
  const got = new Map<number, string>()
  for (const item of Array.isArray(parsed?.directions) ? parsed.directions : []) {
    const index = Number(item?.sceneIndex), direction = normalizeDirection(item?.direction)
    if (targets.includes(index) && direction && !got.has(index)) got.set(index, direction)
  }
  const missing = targets.filter((t) => !got.has(t))
  return missing.length ? { ok: false, missing } : { ok: true, directions: targets.map((sceneIndex) => ({ sceneIndex, direction: got.get(sceneIndex)! })) }
}
