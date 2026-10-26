# Tracker 무료 인프라 운영 설계 (AI API 사용료 외 구독 0원)

상태: **설계 초안 / 읽기 전용 조사 결과**. 이 문서만으로 어떤 운영 변경도 실행하지 않는다.
선행 문서: `origin/chore/free-infra-m0-inventory:docs/free-infra-m0-audit.md` (M0 감사, 백업 미검증 상태).
조사 범위: 백엔드 `shorts-tracker-v4-proxy`(main), 프론트 `shorts-production-tracker-web`(cardnews-auto 브랜치, `js_v420a12/`).
요금·한도 수치는 모두 **확인 필요**(각 공급사 현행 약관/가격표로 재확인할 것).

---

## 0. 승인 게이트 (모든 단계 공통)

| 게이트 | 내용 | 승인 없이 금지 |
|---|---|---|
| G0 | 운영 DB 스키마/데이터 변경 (`npm run db:migrate` 포함 — 쓰기 작업임) | 금지 |
| G1 | 데이터 이전(DB restore to 신규 운영, 오브젝트 대량 복사) | 금지 |
| G2 | 기존 서비스 해지·삭제·플랜 다운그레이드 (Railway, Vercel Blob, DB) | 금지 |
| G3 | 신규 유료 가입, 카드 등록이 필요한 플랜 활성화 | 금지 |
| G4 | 운영 env var 변경, 프론트 API 주소 변경 배포 | 금지 |

각 게이트는 **소유자의 명시적 승인 + 직전 단계 증거(체크섬/카운트/복원 로그)** 가 있어야 통과한다.

---

## 1. 코드가 실제로 쓰는 외부 서비스 인벤토리

### 1.1 호스팅 / 런타임

| 서비스 | 용도 | 근거 (파일:줄) | 리소스 특성 |
|---|---|---|---|
| **Vercel (백엔드 프록시)** `shorts-tracker-v4-proxy.vercel.app` | `api/*.ts` 서버리스 함수: story(소스 수집·프레임·Job API 디스패치), image(Gemini), claude-*, gpt-*-qc, sync(클라우드 동기화), health | `vercel.json:1-12`, `api/story.ts:191-201`, `tools/function-count.test.ts:6-8` | 함수 11개+`src/index.ts`=12 → **Hobby 함수 한도(12)에 이미 도달**. `api/story.ts` maxDuration 180s, Chromium·ffmpeg·mediainfo 바이너리 번들 |
| **Vercel (프론트)** | 정적 사이트 + 함수 2개(`api/thumbnail-download.js`, `api/economy-benchmark-preview.js`) | 프론트 `api/` 디렉터리 | 경량. 썸네일 프록시는 R2/Blob 호스트만 허용 (`api/thumbnail-download.js:6-8`) |
| **Railway – continuity API** `tracker-api-continuity-production.up.railway.app` | Express 상주 서버: `/api/story`, `/api/materials(/intake)`, `/api/sync`, health | `server/railwayApi.ts:13-38,274-276`, `package.json` `api:railway` | 상주 프로세스. **`/api/materials*` 는 Railway에만 존재** (Vercel `api/`에 없음) |
| **Railway – Worker** (`npm start` = `npm run worker`) | Job 파이프라인(analyze→plan→asset→compile→render→QC→package), 롱폼 렌더, 급상승 수집 | `worker/index.ts:1-3,59,75,98-133`, `package.json` scripts | **상주 Node 프로세스 + ffmpeg + 대용량 임시 디스크**(2시간 내레이션 ~150MB, 세그먼트 렌더: `worker/stages/longform.ts:617,677,702`). 인바운드 포트 불필요(DB 폴링만) |
| Railway 서비스 구성(서비스가 1개인지 2개인지) | — | 저장소에 Dockerfile/railway.json 없음 → Nixpacks 추정, `.railway-deploy-trigger` | **확인 필요** (Railway 대시보드) |

프론트가 호출하는 주소(하드코딩):
- `js_v420a12/jobsClient.js:4` `JOBS_API_BASE` = Railway (Job·카드뉴스·소재·타이틀약속이 모두 import: `cardnewsServer.js:3`, `materialsClient.js:6`, `titlePromise.js:3`)
- `js_v420a12/cloudSync.js:3`, `aiProvider.js:9`, `imageProvider.js:14`, `sourceAssets.js:1` 등 = Vercel 프록시

### 1.2 Postgres

| 항목 | 내용 | 근거 |
|---|---|---|
| 연결 | `DATABASE_URL` 하나 (node-postgres, 공급사 SDK 없음) | `lib/jobs/db.ts:1-16` |
| 옵션 | `DATABASE_POOL_MAX`(기본 5), `DATABASE_SSL=disable` 아니면 SSL(`rejectUnauthorized:false`) | `lib/jobs/db.ts:16` |
| 사용처 | Worker(`worker/index.ts:59`), Job API(`lib/jobs/http.ts:747,751`), 급상승 API(`lib/trending/http.ts:20`) | — |
| 테이블 | `production_jobs`, `job_stage_runs`(001), 002 컬럼 추가, `trend_observations`, `trend_state`(003), `job_recipes`, `job_blocks`(004) | `db/*.sql` |
| 공급사 | 코드상 미지정. M0 문서는 **Neon(쿼터 제한)** 으로 기술 → **확인 필요** | M0 audit |
| 부하 특성 | Worker 유휴 시 2s→최대 60s 지수 백오프 폴링(`WORKER_POLL_MS`, `WORKER_IDLE_POLL_MAX_MS`), 리스 60s(`lib/jobs/store.ts:9`), 급상승 수집 1분마다 claim 확인 | `worker/index.ts:34-35,99,128-133` |

### 1.3 오브젝트 스토리지 (선택 로직)

`lib/objectStorage.ts` 가 단일 진입점:
- `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` **4개 모두** 있으면 R2 (`:17-22`).
- 쓰기(`put`/`putFile`, `:219,225`)·`list`(`:256`): R2 설정 시 R2만, 아니면 Vercel Blob(`BLOB_READ_WRITE_TOKEN`).
- 읽기(`get`/`head`/`presign`, `:230,…,261`): **R2 먼저, 없으면 Vercel Blob 폴백** → 과거 객체가 아직 Vercel Blob에 남아 있다는 전제.
- `createVercelJobBlobStore()`(`lib/jobs/blobs.ts`)는 이름과 달리 `objectStorage` 경유라 R2 사용. Worker·Job API·소재함이 사용.
- **우회 지점**: `lib/benchmarkCloneDiagnostic.ts:2`, `lib/benchmarkRef01Diagnostic.ts:2` 가 `@vercel/blob`을 직접 import (진단용, `api/image.ts`에서 호출).
- 저장물: 소스 영상, 레퍼런스 프로필 JSON, 생성 이미지, 렌더 MP4(롱폼 60–120분 포함), 썸네일, 클라우드 동기화 청크(`api/sync`), 소재함 JSON.
- 프론트 썸네일 다운로드 함수는 `*.r2.cloudflarestorage.com`, `*.blob.vercel-storage.com` 만 허용.

### 1.4 스케줄 작업

| 작업 | 실행 위치 | 근거 |
|---|---|---|
| 급상승(YouTube 조회수) 수집, 시간당 1회 | **Worker 루프 내부** (별도 cron 없음), `TRENDING_COLLECT=off`로 중지 | `worker/index.ts:95-103` |
| 소재 자동 입고 | 외부(예약된 GPT 작업)가 `POST /api/materials/intake` (Bearer `MATERIALS_INTAKE_TOKEN`) | `server/railwayApi.ts:32-34`, `lib/materials/intake.ts:3,109` |
| Vercel cron / GitHub Actions schedule | **없음** (vercel.json에 crons 없음, 워크플로는 push/dispatch/PR 트리거만) | `vercel.json`, `.github/workflows/*.yml` |

### 1.5 ffmpeg / 렌더 / 브라우저

- `ffmpeg-static` 번들, `FFMPEG_PATH`로 대체 가능 (`lib/media/ffmpeg.ts:6`). Vercel에선 /tmp로 복사 후 실행(`lib/sourceFrames.ts:24-56`).
- `@sparticuz/chromium` + `puppeteer-core`: Douyin 링크 해석 (`lib/douyinResolver.ts:42-50`), Vercel 함수 내.
- `mediainfo.js` wasm: 소스 메타데이터.

### 1.6 AI 외 서드파티 API

| 서비스 | env | 근거 | 비용 관점 |
|---|---|---|---|
| YouTube Data API v3 | `YOUTUBE_API_KEY` | `lib/trending/trending.ts:47`, `worker/index.ts:99` | 일일 쿼터 무료(초과 시 거부, 과금 아님 — 확인 필요) |
| Cobalt(소셜 영상 다운로드) | `COBALT_API_URL` | `lib/sourceCollector.ts:57-59` | 자체/공개 인스턴스 여부 **확인 필요**. 유료 호스팅이면 인벤토리 대상 |
| Douyin 웹 | (없음, 헤드리스 Chromium) | `lib/sourceCollector.ts:41-46` | 비용 없음, Vercel 함수 시간 소모 |
| GitHub Actions | `secrets` 없음, 운영 URL 호출 일부 | `cloud-sync-production-selftest.yml`, `source-analysis-request.yml` | 공개/비공개 저장소 무료 분 한도 확인 필요 |

AI(별도 예산 관리 대상, 이 문서 범위 밖): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (사용량 원장 `lib/generative/usageLedger.ts`).

---

## 2. 서비스별 무료 가능성 / 초과 위험

| 서비스 | 무료 옵션(일반 지식, 전부 **확인 필요**) | 위험 | 판정 |
|---|---|---|---|
| Vercel Hobby (백엔드·프론트) | 무료. **비상업적 용도 한정** 약관 | 수익화 채널 운영은 "상업적" 해석 가능 → 약관 위반 위험. 함수 실행시간 상한(180s 설정이 Hobby에서 허용되는지 확인 필요), 함수 12개 한도 도달 | 단기 유지, 약관 확인 필요. 대안: Cloudflare Pages/Workers 무료(상업 허용 여부 확인 필요) |
| Railway | **상시 무료 플랜 없음**(체험 크레딧 후 유료) | 이 프로젝트의 유일한 확정 구독비 원천 | **제거 대상** |
| Postgres (Neon 추정) | Neon/Supabase 무료 티어: 저장 용량 제한, 유휴 시 일시중지(Supabase 무료 프로젝트는 장기 비활성 시 정지), 컴퓨트 시간 제한 | Worker 폴링이 컴퓨트를 계속 깨움 → 무료 컴퓨트 시간 소진 위험. 데이터량은 Job 메타데이터 위주라 작음(실측 필요) | **유지 가능**(폴링 최적화 필요) |
| Cloudflare R2 | 무료 티어 약 10GB 저장 + 월 요청 수 한도, **egress 0원** | 롱폼 MP4(수백 MB~GB)·소스 영상 누적 시 10GB 초과 → 유료 전환. 결제수단 등록 필요 여부 확인 필요 | **유지**(보존 정책 필요) |
| Vercel Blob | Hobby 포함 소량 무료 한도 | 신규 쓰기는 R2로 가지만 읽기 폴백 대상. 한도/과금 확인 필요 | R2로 복사 검증 후 **읽기 전용 유지 → 추후 정리(G2)** |
| Worker 대체 런타임 | ① 소유자 PC/미니PC/NAS에서 `npm run worker`(0원, 인바운드 불필요) ② Oracle Cloud Always Free VM(약관·가용성 확인 필요) ③ GitHub Actions 수동/주기 실행(장시간 렌더엔 부적합) | ①은 PC 꺼지면 Job 정지(리스 만료 후 재개되므로 데이터 손상은 없음) ②는 계정 회수 위험 | **①을 1순위**, ②는 백업안 |
| Continuity API 대체 | Vercel 프록시가 이미 `api/story.ts`로 `job_*`, `cardnews_*`, `trending_get` 처리 | `/api/materials*` 만 Railway 전용, 함수 개수 한도로 새 파일 추가 불가 | 소재 라우트를 `api/story.ts` taskType으로 흡수 |
| YouTube Data API | 무료 쿼터 | 쿼터 초과 시 수집 실패만 | 유지 |
| Cobalt | 자체 호스팅 위치 확인 필요 | 유료 호스팅이면 구독비 | **확인 필요** |

---

## 3. 권고안

### 3.1 목표 구조
```
[브라우저] ──> Vercel 프록시(api/story.ts: job_*/cardnews_*/trending_get/materials_*) ──> Postgres(무료 티어)
                                                                        └──> R2(무료 티어, egress 0)
[소유자 PC 또는 무료 VM의 Worker(npm run worker)] ──폴링──> Postgres / R2 / AI API
```
- 유지: Vercel(약관 확인 전제), Postgres 현 공급사(무료 티어면), R2, YouTube API.
- 제거(승인 후): Railway API + Worker. Vercel Blob은 복사·검증 후 읽기 폴백만 남겼다가 정리.

### 3.2 최소 변경 목록
1. Worker 실행 위치를 Railway → 소유자 PC(또는 무료 VM)로. 코드 변경 불필요(env만: `DATABASE_URL`, R2 4종, AI 키, `YOUTUBE_API_KEY`, `WORKER_ID`). ffmpeg는 `ffmpeg-static` 또는 `FFMPEG_PATH`.
2. `/api/materials*` 를 `api/story.ts` taskType 디스패치로 추가(함수 수 유지). 외부 예약 GPT 작업의 POST 주소 변경 필요.
3. 프론트 `JOBS_API_BASE`를 Vercel 프록시로 전환(또는 설정값으로 오버라이드 가능하게).
4. Vercel 프록시에 `DATABASE_URL`, R2 env 존재 확인(Job API가 Vercel에서도 돌기 위해).
5. Postgres 무료 컴퓨트 보호: `WORKER_IDLE_POLL_MAX_MS` 상향(예: 300000), 필요 시 `TRENDING_COLLECT=off`.
6. R2 보존 정책: 최종본 외 중간 산출물(세그먼트, 후보 이미지) 정리 기준 수립(삭제는 G1/G2 승인 후).

---

## 4. 백업 우선 / 복원 검증 컷오버 계획

| 단계 | 작업 | 검증 증거 | 게이트 |
|---|---|---|---|
| P0 | 현 상태 기록: 서비스 목록, env 이름(값 제외), Railway 서비스 수, DB 공급사·플랜, 월 청구액 | 스크린샷/메모(비밀값 제외) | — |
| P1 | **DB 백업**: 읽기 전용 접속으로 `pg_dump -Fc --no-owner` → 암호화된 비공개 위치 | 파일 sha256, 테이블별 `count(*)` 목록 | 읽기 전용 자격만 |
| P2 | **복원 테스트**: 로컬/일회성 Postgres(또는 PGlite 아닌 실제 PG)에 `pg_restore` → 카운트·PK·최신 `updated_at` 비교, `npm test` 중 DB 테스트를 복원본으로 스모크 | 원본 vs 복원 카운트 일치표 | 운영 DB 무변경 |
| P3 | **오브젝트 인벤토리**: Vercel Blob `list` 전체 + R2 `list` 전체 → 키/크기 CSV | 키 수, 총 바이트 | — |
| P4 | **Blob→R2 복사**(Vercel에만 있는 키만, create-once): 복사 후 양쪽 sha256 비교(R2 ETag는 멀티파트 시 MD5 아님 주의 → 직접 다운로드 해시) | 불일치 0건 리포트 | **G1** |
| P5 | 병행 운영: 소유자 PC Worker를 `WORKER_ID` 구분해 기동(리스 펜싱으로 중복 처리 방지, `lib/jobs/store.ts:63-66`), Railway Worker는 그대로 | 테스트 Job 1건 완료(AI 비용 최소 프로필) | **G4** + AI 비용 승인 |
| P6 | 전환: 소재 라우트 배포 → 프론트 `JOBS_API_BASE` 변경 배포 → 예약 GPT 주소 변경 → Railway Worker 정지(삭제 아님) | 헬스체크, Job 생성·조회·패키지, 소재 목록, 썸네일 다운로드 | **G4** |
| P7 | 관찰 기간(예: 2주): DB 컴퓨트·R2 용량 사용량 확인 | 사용량 캡처 | — |
| P8 | 정리: Railway 해지, Vercel Blob 정리 | 최종 백업 재확인 | **G2** |

**롤백**: P6 이후 문제 시 ① 프론트 `JOBS_API_BASE` 이전 커밋으로 재배포 ② Railway 서비스 재시작(P8 전까지 삭제하지 않으므로 가능) ③ 로컬 Worker 정지. DB는 공급사를 바꾸지 않으므로 롤백 대상 아님. DB 공급사를 바꾸는 경우엔 P1–P2를 컷오버 직전 재수행하고, 전환 중 쓰기 중지(Worker 정지 + 프론트 Job 생성 차단) 후 최종 덤프로 이전, 구 DB는 G2 전까지 보존.

---

## 5. 안전한 전환을 위한 코드 준비 (미구현, 제안만)

이미 갖춰진 것:
- DB 이식성: `DATABASE_URL` 단일, 공급사 SDK 없음, 테스트는 PGlite (`lib/jobs/db.ts:1-2`).
- 스토리지 env 선택 + 읽기 폴백 (`lib/objectStorage.ts:217-276`), 스트리밍 업로드/다운로드, create-once.
- Worker 폴링 백오프 env (`worker/index.ts:34-35`), 리스 펜싱, 급상승 끄기 스위치.
- 함수 개수 한도 테스트 (`tools/function-count.test.ts`).

권장 소규모 변경:

| # | 파일 | 변경 | 이유 |
|---|---|---|---|
| C1 | `js_v420a12/jobsClient.js:4` (프론트) | `JOBS_API_BASE`를 설정/localStorage 오버라이드 가능하게, 기본값은 승인 후 교체 | 재배포 없이 롤백 가능 |
| C2 | `api/story.ts:191-201` + `lib/materials/intake.ts` | `materials_list`, `materials_intake` taskType 추가(새 함수 파일 금지) | Railway 의존 제거, 함수 12개 한도 유지 |
| C3 | `lib/objectStorage.ts` | `STORAGE_BACKEND=r2|vercel-blob` 명시 스위치 + `STORAGE_READ_FALLBACK=vercel-blob|off` | R2 env 하나 누락 시 조용히 Vercel Blob으로 쓰는 위험 제거, 폴백 종료 시점 제어 |
| C4 | `lib/benchmarkCloneDiagnostic.ts:2`, `lib/benchmarkRef01Diagnostic.ts:2` | `@vercel/blob` 직접 import → `lib/objectStorage.js` 경유 | Blob 정리 후 깨짐 방지 |
| C5 | `tools/` 신규 스크립트(읽기 전용) | `storage-inventory.ts`(양쪽 list→CSV), `storage-copy-verify.ts`(dry-run 기본, sha256 비교) | P3/P4 재현성 |
| C6 | `worker/index.ts:1-3` 주석, `docs/production-jobs.md:28` | `BLOB_READ_WRITE_TOKEN` 대신 R2 env 안내 | 로컬 Worker 설정 실수 방지 |
| C7 | `lib/jobs/db.ts:16` | `DATABASE_SSL=verify` 옵션(인증서 검증) 추가, 기본 동작 유지 | 공급사 변경 시 보안 선택지 |
| C8 | `api/sync-health.ts:6-13`, `server/railwayApi.ts` CORS | 허용 origin을 `TRACKER_WEB_ORIGIN` 목록으로 일원화 | 프론트 호스트 변경(Cloudflare Pages 등) 대비 |

---

## 6. 미확인 항목 (소유자 확인 필요)
- Postgres 실제 공급사·플랜·현재 용량/컴퓨트 사용량
- Railway 서비스 수(API/Worker 분리 여부)와 월 청구액
- R2·Vercel Blob 현재 총 용량과 객체 수
- Vercel Hobby 상업적 이용 해당 여부, Hobby 함수 최대 실행시간
- `COBALT_API_URL` 인스턴스 호스팅 주체/비용
- 예약 GPT 소재 입고 작업의 설정 위치
