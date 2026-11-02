import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeriesMaster, createEpisode, approveScript, approveScene, replaceScene, lockEpisode, buildProductionContext } from '../lib/seriesProduction.js';

const master = createSeriesMaster({ id: 'ordinary-monsters', title: '그들도 평범한 하루를 살았다', visualStyle: 'cinematic 3D', narrationProfile: 'Korean female 40s', globalRules: ['No reveal before scene 9'], reusableAssetKeys: [] });
const make = () => createEpisode(master, { id: 'ep01', number: 1, title: '누가 내 치즈를 갉아먹었나?', script: 'original script', scenes: [{ id: '01', order: 1, narration: 'Morning' }] });
test('series settings inherit without inheriting episode characters', () => {
 const context = buildProductionContext(master, make());
 assert.equal(context.style, 'cinematic 3D'); assert.deepEqual(context.rules, ['No reveal before scene 9']);
 assert.equal(context.scenes.length, 1);
});
test('approved scenes cannot be silently regenerated', () => {
 const ep = approveScene(make(), '01', { version: 1, checksum: 'sha256:a', approvedAt: '2026-10-30' });
 assert.throws(() => replaceScene(ep, '01', { imagePrompt: 'change character' }), /immutable/);
});
test('locked episodes require approved script and image', () => {
 assert.throws(() => lockEpisode(make()), /approved/);
 let ep = approveScript(make(), { version: 1, checksum: 'sha256:s', approvedAt: '2026-10-30' });
 ep = replaceScene(ep, '01', { imageAssetKey: 'r2/scene01.png' });
 ep = approveScene(ep, '01', { version: ep.version, checksum: 'sha256:i', approvedAt: '2026-10-30' });
 assert.equal(lockEpisode(ep).status, 'locked');
});
test('rejects mismatched series and duplicate scene orders', () => {
 assert.throws(() => buildProductionContext({ ...master, id: 'other' }, make()), /mismatch/);
 assert.throws(() => createEpisode(master, { id: 'ep2', number: 2, title: 'Test', script: '', scenes: [{id:'1',order:1,narration:''},{id:'2',order:1,narration:''}] }), /unique/);
});
