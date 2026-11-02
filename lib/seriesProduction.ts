/**
 * Series production domain module.
 * No external AI calls. Does not modify existing Shorts/Longform flows.
 */
export type Approval = { version: number; approvedAt: string; checksum: string };
export type SeriesMaster = {
  id: string; title: string; visualStyle: string; narrationProfile: string;
  globalRules: string[]; reusableAssetKeys: string[]; version: number;
};
export type Scene = {
  id: string; order: number; narration: string; imageAssetKey?: string;
  imagePrompt?: string; approval?: Approval;
};
export type Episode = {
  id: string; seriesId: string; number: number; title: string;
  script: string; scenes: Scene[]; status: 'draft' | 'locked' | 'rendered';
  scriptApproval?: Approval; version: number;
};
export type EpisodeProductionContext = {
  seriesId: string; episodeId: string; style: string; voice: string;
  rules: string[]; scenes: Scene[];
};
function assertText(value: string, field: string) {
  if (!value?.trim()) throw new Error(field + ' is required');
}
export function createSeriesMaster(input: Omit<SeriesMaster, 'version'>): SeriesMaster {
  assertText(input.id, 'series id'); assertText(input.title, 'series title');
  return { ...input, globalRules: [...input.globalRules], reusableAssetKeys: [...input.reusableAssetKeys], version: 1 };
}
export function createEpisode(series: SeriesMaster, input: Pick<Episode, 'id' | 'number' | 'title' | 'script' | 'scenes'>): Episode {
  assertText(input.id, 'episode id'); assertText(input.title, 'episode title');
  if (!Number.isInteger(input.number) || input.number < 1) throw new Error('invalid episode number');
  const orders = input.scenes.map(s => s.order);
  if (new Set(orders).size !== orders.length || orders.some(n => !Number.isInteger(n) || n < 1))
    throw new Error('scene order must be unique positive integers');
  return { ...input, seriesId: series.id, scenes: input.scenes.map(s => ({ ...s })), status: 'draft', version: 1 };
}
export function approveScript(episode: Episode, approval: Approval): Episode {
  if (episode.status !== 'draft') throw new Error('locked episode cannot change');
  if (!approval.checksum || approval.version !== episode.version) throw new Error('approval version mismatch');
  return { ...episode, scriptApproval: { ...approval }, version: episode.version + 1 };
}
export function replaceScene(episode: Episode, sceneId: string, patch: Partial<Pick<Scene, 'narration' | 'imageAssetKey' | 'imagePrompt'>>): Episode {
  if (episode.status !== 'draft') throw new Error('locked episode cannot change');
  const target = episode.scenes.find(s => s.id === sceneId);
  if (!target) throw new Error('scene not found');
  if (target.approval) throw new Error('approved scene is immutable');
  return { ...episode, scenes: episode.scenes.map(s => s.id === sceneId ? { ...s, ...patch } : { ...s }), version: episode.version + 1 };
}
export function approveScene(episode: Episode, sceneId: string, approval: Approval): Episode {
  if (episode.status !== 'draft') throw new Error('locked episode cannot change');
  if (approval.version !== episode.version || !approval.checksum) throw new Error('approval version mismatch');
  if (!episode.scenes.some(s => s.id === sceneId)) throw new Error('scene not found');
  return { ...episode, scenes: episode.scenes.map(s => s.id === sceneId ? { ...s, approval: { ...approval } } : { ...s }), version: episode.version + 1 };
}
export function lockEpisode(episode: Episode): Episode {
  if (!episode.scriptApproval || !episode.scenes.length || episode.scenes.some(s => !s.approval || !s.imageAssetKey))
    throw new Error('script and all scene images must be approved');
  return { ...episode, status: 'locked', version: episode.version + 1 };
}
export function buildProductionContext(series: SeriesMaster, episode: Episode): EpisodeProductionContext {
  if (episode.seriesId !== series.id) throw new Error('series mismatch');
  return { seriesId: series.id, episodeId: episode.id, style: series.visualStyle, voice: series.narrationProfile,
    rules: [...series.globalRules], scenes: episode.scenes.map(s => ({ ...s })) };
}
