// 카드뉴스 장별 참조 이미지의 역할. 브라우저가 references[]에 role을 붙여 보내면, Gemini에 실제 이미지 블록으로 넘기면서
// "몇 번째 이미지가 무엇인지"를 글로 알려 준다(이미지 주소나 경로를 프롬프트에 글자로 넣지 않는다).
// 순서는 서버가 정한다: 스토리보드(장면) → 캐릭터 기준 → 그림체 기준. 기존 /api/image 한도(최대 4장) 그대로.
export type RefRole = 'storyboard' | 'character' | 'style'
export const REF_ORDER: RefRole[] = ['storyboard', 'character', 'style']
export const REF_LIMIT = 4
export const isRefRole = (r: unknown): r is RefRole => typeof r === 'string' && (REF_ORDER as string[]).includes(r)

const LINE: Record<RefRole, string> = {
  storyboard: '[스토리보드] 이 장의 확정 스토리보드 칸입니다. 장면의 상황·구도·인물 배치·포즈·카메라 위치·화면 속 크기를 그대로 따릅니다. 스케치 선, 칸 테두리, 번호, 말풍선, 손글씨는 그리지 않습니다. 스토리보드에 없는 인물·소품·사건을 새로 만들지 않습니다.',
  character: '[캐릭터 기준] 등장인물의 외형 기준입니다. 얼굴·체형·비율·머리·옷·색을 바꾸지 않습니다. 이 이미지의 구도나 배경은 따르지 않습니다.',
  style: '[그림체 기준] 그림체 기준입니다. 선·색감·질감·조명만 따르고, 이 이미지의 구도나 인물은 따르지 않습니다.',
}

// 역할이 붙은 참조를 정해진 순서로 정렬하고 한도로 자른다. 역할이 없는 참조(예전 요청)는 null을 돌려 기존 경로를 쓴다.
export function orderRoleReferences<T extends { role?: unknown }>(refs: T[]): T[] | null {
  if (!refs.length || !refs.every((r) => isRefRole(r.role))) return null
  const sorted = REF_ORDER.flatMap((role) => refs.filter((r) => r.role === role))
  return sorted.filter((r, i) => r.role !== 'storyboard' || sorted.findIndex((x) => x.role === 'storyboard') === i).slice(0, REF_LIMIT) // 스토리보드는 장당 1장
}
export function roleReferenceInstruction(roles: RefRole[]): string {
  return [
    `아래 ${roles.length}장의 첨부 이미지는 참고 자료입니다. 각 이미지의 역할:`,
    ...roles.map((r, i) => `이미지 ${i + 1}: ${LINE[r]}`),
    '여러 기준이 충돌하면 텍스트 지시의 금지사항 > 스토리보드의 장면·구도 > 캐릭터 기준 > 그림체 기준 순서로 따릅니다.',
  ].join('\n')
}
