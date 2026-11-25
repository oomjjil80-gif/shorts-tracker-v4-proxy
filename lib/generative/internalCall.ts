// 서버 내부 호출 표시(JSON 본문으로는 만들 수 없는 Symbol). 서버 승인 경로(카드뉴스 라우터)가 1회용 승인·기록을 거친 뒤에만 붙인다.
// 이 표시가 없는 유료 AI 엔드포인트 POST는 공급자를 호출하기 전에 403으로 끝난다(인증·승인 없는 직접 호출 차단).
export const INTERNAL_AI_CALL = Symbol.for('tracker.internalImageCall')
export const isInternalAiCall = (req: any): boolean => req?.[INTERNAL_AI_CALL] === true
export const aiDirectBlocked = () => ({ ok: false, error: { code: 'AI_APPROVAL_REQUIRED', message: 'AI 호출은 서버 비용 승인 경로로만 실행할 수 있습니다. 앱을 새로고침한 뒤 다시 시도해 주세요.' } })
