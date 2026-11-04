# ProductionPlan 계약 1차 코드 감사 (2026-11-04)

## 검증 범위
- Backend `lib/productionPlan.ts` 및 `lib/cardnews/productionPlan.ts` (main)
- Frontend `js_v420a12/productionPlan.js` (main)
- 정적 코드 대조만 수행. 호출 경로 및 Production E2E는 아직 검증하지 않음.

## 확정된 계약 차이

| 항목 | Backend `lib/productionPlan.ts` | Frontend `productionPlan.js` | 영향 |
| --- | --- | --- | --- |
| 식별자 | `id` 필수 | `episodeId` | 같은 객체로 전달하면 식별자 검증 실패 |
| 버전 | `version` 없음 | `version: 1` 필수 | Frontend 검증기에 Backend 객체를 넣으면 버전 오류 |
| 형식 | `format: video\|carousel` | `cuts`, `stages` 기반 | 데이터 표현이 서로 다름 |
| 실행 단위 | `steps[]`, `kind`, `dependsOn` | `cuts[]`, 단계별 상태 | Backend validator는 Frontend 계획의 `steps` 부재로 실패 |
| 승인 | `executeProductionPlan(..., approvedStepIds)` | `locked`, QC 및 단계 상태 | 승인 의미와 실행 게이트가 다름 |
| 장면 제약 | `sceneId`, `constraints.maxScenes` | `referenceRef`, `visibilityRules`, `monochrome` | 직접 변환 시 제약 손실 위험 |

## 별도 확인
- Backend 카드뉴스는 같은 Backend 타입을 사용해 9개 패널을 `script → image×9 → package` DAG로 만든다.
- Frontend `normalizeProductionCut`은 `referenceRef`, `visibilityRules`, `monochrome`를 보존하도록 작성되어 있다.
- 양쪽이 현재 같은 API payload로 실제 교환되는지는 확인하지 않았다. 따라서 **이 차이만으로 Production 장애라고 단정할 수 없다**.

## 수정 우선순위
1. 실제 API 호출자/수신자 및 저장 경로를 추적해 두 모델이 교차하는지 확인한다.
2. 교차하는 경우에만 명시적 adapter 또는 버전 계약을 설계한다. 어느 한쪽 타입을 무작정 덮어쓰지 않는다.
3. 확정 스토리보드의 `referenceRef`/제약 및 panel·cut ID가 저장→이미지 프롬프트→재생성까지 보존되는지 회귀 테스트한다.
4. 전체 테스트·유료 Gemini 호출 전에 작은 단위의 무료 계약 테스트를 추가한다.

## 완료 판정
현재는 **계약 차이 식별 완료 / 실제 호출 경로 미검증 / 수정 미착수**.
