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
  assert.match(source, /await put\(episodePath\(key, id\), buffer/);
  assert.match(source, /await put\(manifestFile, JSON\.stringify\(manifest\)/);
  assert.doesNotMatch(source.slice(source.indexOf("if (parts[0] === 'episode'"), source.indexOf("if (req.method === 'GET' && op === 'manifest')")), /put\(manifestPath\(key\)/);
});

test('episode ID is constrained and full snapshot routes remain available', () => {
  assert.match(source, /\^ep_\[a-z0-9\]\{8,40\}\$/i);
  for (const op of ['manifest','start','chunk','commit']) assert.ok(source.includes("op === '"+op+"'"));
});
