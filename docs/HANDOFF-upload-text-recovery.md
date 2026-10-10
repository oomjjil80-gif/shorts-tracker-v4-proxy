# 인수인계 — 두 번째 파생 쇼츠 업로드 정보 복구

## 대상 Job
- `job_4e8e5d26-62bf-427f-a740-9e32a2d6a688` — 「쇼펜하우어와 사다리 우화 — 친절이 당연해지는 순간」 (profile `wisdom`, COMPLETE, 상위 롱폼 `job_4ba6f801-73d3-4124-8cd0-36c7242c8cbf`)
- PACKAGE 확인 결과: `metadata = { title: null, description: null, tags: [], pinnedComment: null }`. 복원할 업로드 정보가 저장돼 있지 않습니다.
- 영상(`finalRenderRef`)과 썸네일(`thumbnailRef`)은 정상이고, 아무것도 변경하지 않았습니다.

## 원인
- PACKAGE의 업로드 문구 생성 결과가 검증에서 2회 거부되자 metadata를 null로 저장했습니다. 거부 사유는 화면에 보이지 않는 단계 기록에만 남았습니다.
- 수정 요청에 코드(`title.missing_named_thinker`)만 보내, 필요한 사상가 이름("쇼펜하우어")이 전달되지 않았습니다.

## 수정 (PR #185, 브랜치 `wisdom/upload-text-recovery`)
- `lib/generative/wisdomUploadText.ts`: 업로드 문구 공통 모듈.
  - 정확한 수정 요청(사상가 이름 명시)을 보냅니다.
  - 업로드 문구가 거부되면 최대 3회까지 시도합니다. 썸네일 문구는 기존처럼 수정 1회입니다.
- `worker/stages/wisdomThumbnail.ts`: PACKAGE가 위 모듈을 사용합니다. 최종 거부 시 package에 `uploadError`를 기록합니다.
- `lib/jobs/http.ts`:
  - `job_upload_text`: 완료된 지혜 쇼츠 중 업로드 정보가 없는 Job만 대상입니다. 대본 기반 텍스트 호출만 하고, 이미지·음성·렌더는 0회입니다. 결과는 `upload-text/<job>.json`에 1회 저장됩니다.
  - `job_package`: package에 업로드 정보가 없으면 위 파일을 반환합니다.
- `.github/workflows/verify.yml`: 새 파일을 CI 집중 범위에 추가했습니다.

## 테스트 결과
- `tools/wisdom-derived-shorts.test.ts` 5/5 통과 (복구 시나리오 포함: 텍스트 호출 1회, 단계 재실행 0, 영상·썸네일 동일, 다섯 필드 채움).
- `pipeline-features`·`wisdom-thumbnail` 20/20, `jobs-api`·`wisdom-output` 통과.
- 전체 스위트(수정 전 1회): 실패 2건.
  - `THUMBNAIL excluded`: 이후 수정했고, 해당 파일 재검증 통과.
  - `orphan recovery`: main에서도 실패하는 기존 문제입니다.
- PR #185 CI(verify): 통과 (커밋 `4a102b4`).

## 미완료 (이 순서로 진행)
1. PR #185 병합 (CI 통과 상태).
2. Railway API 배포 확인. `job_upload_text`에 jobId 없이 요청해 "jobId is required"가 오면 배포된 것입니다.
3. 복구 1회 실행. 텍스트 호출 1회이며 비용은 미확인 추정 약 $0.05 이하입니다.
   - `taskType=job_upload_text`, `jobId=job_4e8e5d26-62bf-427f-a740-9e32a2d6a688` (POST, `X-Sync-Key` 필요)
   - GitHub Actions secret `TRACKER_SYNC_KEY`를 쓰는 워크플로로 실행합니다. 이전 브랜치 `production/derived-upload-inspect`의 워크플로를 참고하세요.
4. 확인: `job_package`의 `upload`에 title·description·tags·hashtags·pinnedComment가 모두 있는지 봅니다. 앱 Job 화면(모바일)에서 다섯 입력란이 채워졌는지 확인합니다.
