// 서버 내부 호출 표시(JSON 본문으로는 만들 수 없는 Symbol). 서버 승인 경로(카드뉴스 라우터)가 1회용 승인·기록을 거친 뒤에만 붙인다.
// 이 표시가 없는 유료 AI 엔드포인트 POST는 공급자를 호출하기 전에 403으로 끝난다(인증·승인 없는 직접 호출 차단).
export const INTERNAL_AI_CALL = Symbol.for('tracker.internalImageCall')
export const isInternalAiCall = (req: any): boolean => req?.[INTERNAL_AI_CALL] === true
// 워크스페이스 키는 서버에 등록소가 없는 지참자 토큰이다(키의 해시가 곧 워크스페이스). 그래서 유료 승인 경로는 길이만 맞춘 추측하기 쉬운 키
// (같은 글자 반복 등)를 받지 않는다: 24자 이상이고 서로 다른 글자가 10종 이상이어야 한다(앱이 만드는 48자리 16진 키는 모두 통과).
export const isStrongWorkspaceKey = (key: unknown): boolean => { const k = String(key ?? '').trim(); return k.length >= 24 && new Set(k).size >= 10 }
export const aiDirectBlocked = () => ({ ok: false, error: { code: 'AI_APPROVAL_REQUIRED', message: 'AI 호출은 서버 비용 승인 경로로만 실행할 수 있습니다. 앱을 새로고침한 뒤 다시 시도해 주세요.' } })
