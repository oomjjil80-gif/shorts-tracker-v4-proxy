# ProductionPlan 호출 경로 2차 추적 (2026-11-04)

## 확인한 소스 (main)
- Frontend: `js_v420a12/productionPlan.js`, `productionPlanEpisode.js`, `storyboardGate.js`
- Backend: `lib/productionPlan.ts`, `lib/cardnews/productionPlan.ts`, `tools/approved-storyboard-e2e.test.ts`

## 서로 다른 두 계약
**Frontend 롱폼**: `newProductionPlan()` → `cuts[]` / `stages` → `createEpisodeFromProductionPlan()` → `episodeCutFromPlanCut()` → `saveEpisode(ep)`. 이 경로는 `lib/productionPlan.ts`의 `steps[]` DAG를 사용하지 않는다.

**Backend 카드뉴스**: `createCardnewsProductionPlan()` → 9패널 `script → image×9 → package` DAG → `validateProductionPlan()` / `executeProductionPlan()` (실제 executor 연결은 별도 추적 필요).

**Backend 승인 스토리보드 롱폼 Job**: `tools/approved-storyboard-e2e.test.ts`는 `job_create` 요청의 `input.productionPlan`을 이용해 Job API → PLAN → 승인 → ASSET → RENDER → PACKAGE 경로를 모의 검증한다. 여기서 사용한 구조는 `steps[0].config.script.sections[].scenes[]`이다. 이 또한 Frontend `cuts[]` 계약과 직접 동일하지 않다.

## 확인된 위험과 보존 장치
- `episodeCutFromPlanCut`는 CUT ID, assetId, 잠금, `productionConstraints`(referenceRef/visibilityRules/monochrome), patternIds, visualPlan을 보존하도록 구현되어 있다.
- `storyboardGate.buildStoryboardSheet`는 전체 CUT이 16개 초과 시 대표 12~16개만 선택한다. 따라서 이 시트는 **전체 확정 12장 패널을 전달하는 Job 계획과 동일한 개념이 아니다**.
- `compareStoryboardToCuts`는 QC 상태와 장면 목적/이해 목표/patternIds 일치를 확인하지만, 이미지 생성 프롬프트와 바이너리 참조의 동일성을 검증하지 않는다.
- Backend 무료 E2E 소스에는 승인된 12개 장면의 순서·패널 바이트 전달, 5번 장면만 재생성, 나머지 재사용, ffmpeg MP4/패키지 검증을 위한 단언이 있다. **테스트 코드를 읽은 것이며 이 감사에서 테스트를 새로 실행한 것은 아니다.**
- 따라서 두 `ProductionPlan` 구조의 차이만으로 직접적인 API 계약 장애를 단정할 수 없다. 실제 UI Job Adapter에서 `input.productionPlan`을 만드는 호출자를 찾아야 한다.

## 다음 구현 순서
1. Frontend의 `jobRequestFor` / Job API Adapter가 어떤 `productionPlan` 구조를 전송하는지 찾아 명시한다.
2. Backend `job_create`의 `productionPlan` 파싱·저장·검증을 대조한다.
3. **직접 교차하는 필드만** 수정하고, 승인된 panel ref 및 제약 보존 무료 회귀 테스트를 추가한다.
4. 최소 회귀 통과 후 Production 검증 여부를 판단한다. 유료 Gemini/TTS 호출은 별도 승인 전 금지.

상태: 정적 경로 추적 완료(일부) / 실제 UI→API 호출자 미확인 / Production E2E 미실행.
