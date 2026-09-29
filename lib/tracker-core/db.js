// 아주 가벼운 IndexedDB 래퍼 — 외부 라이브러리 없이 브라우저 네이티브 API만 사용.
// 서버 전송 없음: 모든 데이터는 이 기기 브라우저 안에만 저장됨.
//
// v2: DB_VERSION 1→2. 기존 "episodes" 스토어는 그대로 두고 "assets" 스토어를 신규 추가한다.
// 이미지·오디오 Blob은 episode 레코드에 직접 넣지 않고 여기 별도 저장한다
// (레코드에 직접 넣으면 저장할 때마다 전체 Blob을 다시 쓰게 되어 무거워짐).
//
// migration.js의 migrateEpisode()는 여기서 읽어올 때마다 호출된다 — 즉 이 파일이
// "load-time migration"이 실제로 걸리는 지점이다. 절대 여기서 IndexedDB에 즉시
// 다시 쓰지(rewrite) 않는다 — 실제 저장은 사용자가 saveEpisode()를 호출할 때만 일어난다.

import { migrateEpisode } from "./migration.js";
import { APP_VERSION, DB_VERSION_DISPLAY, BACKUP_FORMAT_VERSION_LIGHT } from "./version.js";

const DB_NAME = "shorts_pipeline_db";
const DB_VERSION = 2;
const STORE = "episodes";
const ASSET_STORE = "assets";
const ASSET_BY_EPISODE_INDEX = "byEpisode";

// 파일 1개당 경고 임계값 — 이미지/오디오 등 모든 asset 첨부가 이 상수 하나만 참조한다
// (여러 파일에 50MB를 따로 하드코딩하지 않는다 — 나중에 설정 가능하게 만들 때도 여기만 고치면 된다).
// 초과해도 업로드를 막지는 않는다 — 호출부가 isOversizedAsset()으로 확인 후 사용자에게 물어보고 진행한다.
export const ASSET_SIZE_WARN_BYTES = 50 * 1024 * 1024; // 50MB

export function isOversizedAsset(fileOrBlob) {
  return !!(fileOrBlob && typeof fileOrBlob.size === "number" && fileOrBlob.size > ASSET_SIZE_WARN_BYTES);
}

// IndexedDB 저장 실패가 "저장공간 부족"인지 판별한다 — 화면에서 사용자에게 명확한 메시지를
// 보여줄지(quota) 아니면 일반 오류로 보여줄지 나누기 위함.
export function isQuotaError(err) {
  if (!err) return false;
  if (err.name === "QuotaExceededError") return true;
  return /quota/i.test(err.message || "");
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        const assetStore = db.createObjectStore(ASSET_STORE, { keyPath: "id" });
        assetStore.createIndex(ASSET_BY_EPISODE_INDEX, "episodeId", { unique: false });
      }
      // 향후 스토어 버전이 더 올라가도 기존 데이터는 여기서 손대지 않는다 —
      // non-destructive 마이그레이션 원칙.
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Phase 7 — 커넥션 누수 수정. openDB()는 호출될 때마다 새 IDBDatabase 연결을 만드는데,
// 예전 코드는 트랜잭션이 끝난 뒤에도 그 연결을 한 번도 닫지 않았다(db.close() 없음). 앱을
// 실제로 오래 쓰면(=db.js 함수가 수백~수천 번 호출되면) 열린 커넥션이 계속 쌓이기만 하고,
// 결국 새 indexedDB.open() 호출이 지연/멈추는 문제로 이어질 수 있다(장시간 자동 테스트에서
// 실제로 재현됨 — Phase 7 발견 버그, 완료 보고서 참고). 모든 저수준 호출은 이제 트랜잭션
// 완료 직후 연결을 닫는다 — 각 호출이 자기 것만 여는 독립 연결이므로 안전하다.
async function withStore(mode, fn) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const result = fn(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function withAssetStore(mode, fn) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(ASSET_STORE, mode);
      const store = tx.objectStore(ASSET_STORE);
      const result = fn(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// episodes
// ---------------------------------------------------------------------------

export async function getAllEpisodes() {
  const db = await openDB();
  let episodes;
  try {
    episodes = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.updatedAt - a.updatedAt));
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
  return episodes.filter((record) => record?.recordType !== "idea").map(migrateEpisode);
}

// Alpha 18 — 소재는 기존 episodes object store를 공유하되 recordType으로 완전히 분리한다.
// 새 object store가 필요 없으므로 DB_VERSION=2를 유지한다.
export async function getAllIdeas() {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result || []).filter((record) => record?.recordType === "idea").sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

// Alpha 22 — 홈 화면은 같은 object store를 Episode용/소재용으로 두 번 읽지 않는다.
export async function getHomeData() {
  const db = await openDB();
  try {
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const ideas = records.filter((record) => record?.recordType === "idea").sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const episodes = records.filter((record) => record?.recordType !== "idea").sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(migrateEpisode);
    return { episodes, ideas };
  } finally { db.close(); }
}

export async function saveIdea(idea) {
  if (!idea || idea.recordType !== "idea") throw new Error("잘못된 소재 데이터입니다.");
  idea.updatedAt = Date.now();
  await withStore("readwrite", (store) => store.put(idea));
  return idea;
}

export async function deleteIdea(id) {
  const db = await openDB();
  try {
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!record || record.recordType !== "idea") throw new Error("소재 데이터만 삭제할 수 있습니다.");
  } finally { db.close(); }
  await withStore("readwrite", (store) => store.delete(id));
}

export async function getEpisode(id) {
  const db = await openDB();
  let ep;
  try {
    ep = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
  return ep ? migrateEpisode(ep) : null;
}

export async function saveEpisode(episode) {
  episode.updatedAt = Date.now();
  await withStore("readwrite", (store) => store.put(episode));
  return episode;
}

// Phase 7 — Backup/Restore 전용 저수준 저장 함수. saveEpisode()와 달리 updatedAt을 "지금"으로
// 덮어쓰지 않는다: 백업에서 복원하는 레코드는 원래 만들어진/마지막으로 저장된 시각을 그대로
// 보존해야 복원 전후 데이터가 "동일"하다고 말할 수 있기 때문이다(조건 30번, Backup/Restore E2E).
// 일반 화면 코드에서는 이 함수를 쓰지 않는다 — 오직 backup.js의 restore 흐름에서만 쓴다.
export async function putEpisodeRaw(episode) {
  await withStore("readwrite", (store) => store.put(episode));
  return episode;
}

export async function deleteEpisode(id) {
  // cascade: 에피소드에 연결된 asset(Blob)도 함께 정리 — 고아 Blob이 남지 않도록.
  await deleteAssetsByEpisode(id);
  return withStore("readwrite", (store) => store.delete(id));
}

// ---------------------------------------------------------------------------
// assets (이미지 / 오디오 Blob)
// asset shape: { id, episodeId, kind: "image"|"audio", role, mimeType, sizeBytes,
//                originalFileName, blob, createdAt }
// ---------------------------------------------------------------------------

function assetUid() {
  return "asset_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function putAsset(asset) {
  const record = {
    id: asset.id || assetUid(),
    episodeId: asset.episodeId,
    kind: asset.kind, // "image" | "audio"
    role: asset.role || "",
    mimeType: asset.mimeType || asset.blob?.type || "",
    sizeBytes: asset.sizeBytes ?? asset.blob?.size ?? 0,
    originalFileName: asset.originalFileName || "",
    blob: asset.blob,
    createdAt: asset.createdAt || Date.now(),
  };
  await withAssetStore("readwrite", (store) => store.put(record));
  return record;
}

export async function getAsset(id) {
  return withAssetStore("readonly", (store) => {
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  });
}

export async function getAssetsByEpisode(episodeId) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(ASSET_STORE, "readonly");
      const idx = tx.objectStore(ASSET_STORE).index(ASSET_BY_EPISODE_INDEX);
      const req = idx.getAll(episodeId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function getAllAssets() {
  return withAssetStore("readonly", (store) => {
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  });
}

// 내부용 — Blob 레코드만 지운다. 참조 정리는 하지 않는다.
// 바깥에서는 deleteAssetSafely()를 쓰는 게 기본이고, 이 함수는
// cascade delete(에피소드 자체가 사라질 때)처럼 참조를 신경 쓸 필요가 없는
// 경우에만 직접 호출한다.
async function deleteAssetRaw(id) {
  return withAssetStore("readwrite", (store) => store.delete(id));
}

export async function deleteAssetsByEpisode(episodeId) {
  const assets = await getAssetsByEpisode(episodeId);
  for (const a of assets) await deleteAssetRaw(a.id);
  return assets.length;
}

// ---------------------------------------------------------------------------
// 참조 무결성 — asset을 참조할 수 있는 모든 필드를 한 곳에서 관리한다.
// (CUT 이미지 / 스타일·캐릭터 레퍼런스 / BGM / CUT의 audioEvents)
// ---------------------------------------------------------------------------

export function findAssetReferences(episode, assetId) {
  const refs = [];
  if (!episode || !assetId) return refs;

  if (episode.thumbnail && episode.thumbnail.assetId === assetId) {
    refs.push({ type: "thumbnail" });
  }
  if (episode.styleReferenceAssetId === assetId) {
    refs.push({ type: "styleReference" });
  }
  if (episode.characterReferenceAssetId === assetId) {
    refs.push({ type: "characterReference" });
  }
  if (episode.bgm && episode.bgm.assetId === assetId) {
    refs.push({ type: "bgm" });
  }
  // rc.3(Master Narration Mode) — 다른 asset 참조 필드(스타일/캐릭터 레퍼런스, BGM)와 동일한
  // 원칙으로 등록한다. 이걸 빼먹으면 findOrphanAssets()가 이 파일을 "아무도 참조하지 않는
  // 고아 asset"으로 잘못 판단하고, deleteAssetSafely()도 이 참조를 못 찾아 정리하지 못한다.
  if (episode.masterNarration && episode.masterNarration.assetId === assetId) {
    refs.push({ type: "masterNarration" });
  }
  (episode.cuts || []).forEach((cut, i) => {
    if (cut.image && cut.image.assetId === assetId) {
      refs.push({ type: "cutImage", cutId: cut.id, cutIndex: i });
    }
    (cut.audioEvents || []).forEach((evt, j) => {
      if (evt.assetId === assetId) {
        refs.push({ type: "cutAudioEvent", cutId: cut.id, cutIndex: i, eventIndex: j });
      }
    });
  });
  return refs;
}

function clearAssetReferences(episode, assetId) {
  if (episode.thumbnail && episode.thumbnail.assetId === assetId) { episode.thumbnail.assetId = null; episode.thumbnail.status = episode.thumbnail.prompt ? "prompt_ready" : "planned"; }
  if (episode.styleReferenceAssetId === assetId) episode.styleReferenceAssetId = null;
  if (episode.characterReferenceAssetId === assetId) episode.characterReferenceAssetId = null;
  if (episode.bgm && episode.bgm.assetId === assetId) episode.bgm.assetId = null;
  if (episode.masterNarration && episode.masterNarration.assetId === assetId) episode.masterNarration.assetId = null;
  (episode.cuts || []).forEach((cut) => {
    if (cut.image && cut.image.assetId === assetId) {
      cut.image.assetId = null;
      cut.image.status = "미생성";
    }
    if (cut.video && cut.video.assetId === assetId) {
      cut.video.assetId = null;
      cut.video.duration = null;
      cut.video.trimStart = 0;
      cut.video.trimEnd = null;
      cut.mediaType = "image";
    }
    if (Array.isArray(cut.audioEvents)) {
      // 이벤트 자체(대사/나레이션 슬롯)는 남겨두고 assetId만 비운다 — 그래야 STEP2의 대사와의
      // 연결(sourceDialogueId)이나 SFX 이름 같은 메타데이터가 asset 삭제만으로 함께 사라지지 않는다.
      cut.audioEvents.forEach((evt) => {
        if (evt.assetId === assetId) evt.assetId = null;
      });
    }
  });
}

// 안전한 asset 삭제 서비스 함수 — 참조 확인 → 참조 해제 → asset 삭제 순으로
// 하나의 함수 안에서 처리한다. dangling reference가 남지 않도록 보장한다.
export async function deleteAssetSafely(assetId, episodeId) {
  const ep = await getEpisode(episodeId);
  if (!ep) throw new Error("에피소드를 찾을 수 없습니다.");

  const refs = findAssetReferences(ep, assetId);
  if (refs.length) {
    clearAssetReferences(ep, assetId);
    await saveEpisode(ep);
  }
  await deleteAssetRaw(assetId);
  return { clearedReferences: refs, episode: ep };
}

// 고아 Blob(어느 에피소드에서도 참조되지 않는 asset) 탐지.
// 자동으로 지우지 않는다 — 설정 화면에서 사용자가 목록을 보고 직접 정리한다.
export async function findOrphanAssets() {
  const [episodes, assets] = await Promise.all([getAllEpisodes(), getAllAssets()]);
  const episodeById = new Map(episodes.map((e) => [e.id, e]));
  const orphans = [];
  for (const asset of assets) {
    const ep = episodeById.get(asset.episodeId);
    if (!ep) {
      orphans.push(asset); // 에피소드 자체가 이미 삭제된 경우
      continue;
    }
    const refs = findAssetReferences(ep, asset.id);
    if (refs.length === 0) orphans.push(asset);
  }
  return orphans;
}

// 사용자가 확인한 assetId 목록만 지운다 — 절대 자동/암묵적으로 전체를 쓸어버리지 않는다.
export async function sweepOrphanAssets(assetIds) {
  let count = 0;
  for (const id of assetIds || []) {
    await deleteAssetRaw(id);
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 저장 용량 조회
// ---------------------------------------------------------------------------

export async function getEpisodeStorageUsage(episodeId) {
  const assets = await getAssetsByEpisode(episodeId);
  return assets.reduce((sum, a) => sum + (a.sizeBytes || 0), 0);
}

export async function getTotalStorageUsage() {
  const assets = await getAllAssets();
  return assets.reduce((sum, a) => sum + (a.sizeBytes || 0), 0);
}

// 브라우저가 지원하면 기기 전체 저장공간 추정치도 함께 제공(가능하면 추가 요구사항).
// Phase 7: navigator.storage.estimate()는 실제 디스크 사용량을 조회하는 브라우저 API라
// 기기/브라우저 상태에 따라 드물게 응답이 크게 늦어질 수 있다(자동 테스트 중 실제로 관찰됨).
// 이 값은 어디까지나 참고 정보이므로, 일정 시간 안에 응답이 없으면 포기하고 null을 반환한다 —
// Settings 화면의 다른 정보(저장 용량 합계, 앱 정보 등)가 이 호출 하나 때문에 멈추지 않는다.
const STORAGE_ESTIMATE_TIMEOUT_MS = 4000;
export async function getStorageEstimate() {
  if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.estimate) {
    try {
      return await Promise.race([
        navigator.storage.estimate(), // { usage, quota }
        new Promise((resolve) => setTimeout(() => resolve(null), STORAGE_ESTIMATE_TIMEOUT_MS)),
      ]);
    } catch (e) {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 백업 — Light(episodes 정보만) / Full(이미지·오디오 Blob 포함, Phase 7에서 실제 구현 — js/backup.js)
// ---------------------------------------------------------------------------

// Light 백업("빠른 백업 — 프로젝트 정보만") — episodes(JSON)만 포함, 빠르고 가볍다.
// Phase 7: 향후 어떤 버전에서 만든 백업인지 구분할 수 있도록 최소 metadata를 함께 넣는다
// (exportedAt은 기존 필드명을 그대로 유지 — 예전 백업 파일과의 하위호환을 위해 남겨둔다).
export async function exportAll() {
  const episodes = await getAllEpisodes();
  return {
    backupFormatVersion: BACKUP_FORMAT_VERSION_LIGHT,
    kind: "light",
    appVersion: APP_VERSION,
    dbVersion: DB_VERSION_DISPLAY,
    createdAt: Date.now(),
    exportedAt: Date.now(),
    episodeCount: episodes.length,
    episodes,
  };
}

// 하위호환 유지 — payload에 backupFormatVersion이 없어도(구버전 라이트 백업) episodes 배열만
// 있으면 그대로 가져온다. 충돌 정책은 이제 backup.js의 restoreLightBackup()이 담당하고,
// 이 함수는 "무조건 덮어쓰며 저장"하는 저수준 동작만 제공한다(호출부는 이제 이 함수를 직접
// 쓰지 않고 backup.js를 거친다 — 다만 예전 호출부/테스트 호환을 위해 그대로 남겨둔다).
export async function importAll(payload) {
  if (!payload || !Array.isArray(payload.episodes)) throw new Error("잘못된 백업 파일입니다.");
  for (const ep of payload.episodes) {
    await withStore("readwrite", (store) => store.put(ep));
  }
  return payload.episodes.length;
}

// Full 백업 예상 용량 계산 — js/backup.js의 Full 백업 컨테이너 포맷(SPB1)은 Blob을 base64로
// 바꾸지 않고 원본 바이트 그대로 이어붙이므로(조건 4번 "portable container" 방식 채택 —
// docs/RELEASE_NOTES.md 참고), 인코딩 오버헤드가 없다. 예상 용량 = asset 원본 바이트 총합 +
// episodes/asset manifest용 JSON 헤더 크기.
export async function estimateFullBackupSize() {
  const [episodes, assets] = await Promise.all([getAllEpisodes(), getAllAssets()]);
  const assetBytes = assets.reduce((sum, a) => sum + (a.sizeBytes || 0), 0);
  const headerJsonBytes = new Blob([
    JSON.stringify({ episodes, assets: assets.map((a) => ({ id: a.id, episodeId: a.episodeId, kind: a.kind })) }),
  ]).size;
  const estimatedBytes = headerJsonBytes + assetBytes;
  return { headerJsonBytes, assetBytes, assetCount: assets.length, episodeCount: episodes.length, estimatedBytes };
}
