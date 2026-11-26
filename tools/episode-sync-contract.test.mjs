import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../api/sync/[...path].ts', import.meta.url), 'utf8');

test('episode-scoped backup is isolated from the full workspace manifest', () => {
  assert.match(source, /function episodePath\(key: string, id: string\)/);
  assert.match(source, /function episodeManifestPath\(key: string, id: string\)/);
  assert.match(source, /parts\[0\] === 'episode' && parts\.length === 2/);
  assert.match(source, /backupHeader\.episodeCount !== 1/);
  assert.match(source, /backupHeader\.episodes\[0\]\?\.id !== id/);
  assert.match(source, /current\?\.revision \|\| ''\) !== previousRevision/);
  assert.match(source, /return res\.status\(409\)/);
  assert.match(source, /await put\(object, buffer/);                      // 이 요청 전용 새 경로
  assert.match(source, /putIfMatch\(manifestFile, JSON\.stringify\(manifest\)/); // manifest는 조건부 확정(CAS)만
  assert.doesNotMatch(source.slice(source.indexOf("if (parts[0] === 'episode'"), source.indexOf("if (req.method === 'GET' && op === 'manifest')")), /put\(manifestPath\(key\)/);
});

test('episode ID is constrained and full snapshot routes remain available', () => {
  assert.match(source, /\^ep_\[a-z0-9\]\{8,40\}\$/i);
  for (const op of ['manifest','start','chunk','commit']) assert.ok(source.includes("op === '"+op+"'"));
});

test('episode listing is read-only, workspace-scoped and lists only episode manifests', () => {
  const block = source.slice(source.indexOf("req.method === 'GET' && op === 'episodes'"), source.indexOf("if (req.method === 'GET' && op === 'manifest')"));
  assert.match(block, /req\.method === 'GET'/);
  assert.match(block, /syncBase\(key\)\}\/episodes\//);
  assert.match(block, /\\\.json\$/);
  assert.doesNotMatch(block, /put\(|del\(/);
});

test('이전 제작물을 훼손하는 자동 용량 회수가 없다(정리 기능 없음)', () => {
  assert.doesNotMatch(source, /reclaimOldChunks|tombstone/);
  assert.match(source, /uploadPath\(key, scopeId, slot\)/); // 요청 기준 revision 고정 기록
});
