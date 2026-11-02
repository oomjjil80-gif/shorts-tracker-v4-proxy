/** Resolve a creative plan against the SAME recipe snapshot used by Tracker Jobs.
 * Read-only preflight: never creates jobs, triggers workers or approves paid work.
 */
import { bridgeProductionPlan } from './productionRecipeBridge.js';
import { recipeFor, bindingErrors } from './jobs/recipes.js';
import { PROFILES, type ProfileId } from './jobs/profiles.js';
import { validateProductionPlan, type ProductionPlan } from './productionPlan.js';

export function prepareTrackerJobPlan(plan: ProductionPlan, profileId: ProfileId, recipeId: string) {
  validateProductionPlan(plan);
  const profile = PROFILES[profileId];
  if (!profile) throw new Error('unknown Tracker profile');
  const binding = recipeFor(recipeId);
  if (!binding) throw new Error('unknown Tracker recipe');
  if (!binding.enforced) throw new Error('legacy recipe cannot enforce production approvals');
  const errors = bindingErrors(binding, profileId);
  if (errors.length) throw new Error('incompatible Tracker recipe: ' + errors.join('; '));
  if (plan.format === 'carousel') throw new Error('carousel requires a dedicated existing Job profile; no safe adapter available');
  const bridge = bridgeProductionPlan(plan, binding.recipe);
  for (const block of Object.values(bridge.stepToBlock)) {
    if (!Object.values(binding.stageBlocks).includes(block))
      throw new Error('no executable Job stage for production block: ' + block);
  }
  return { profileId, recipeId, bridge, stageBlocks: binding.stageBlocks };
}

// The executable v1 contract carries the finished script in the SCRIPT step.
// The existing server SCRIPT_APPROVAL still authorizes that exact stored output.
export function executableTrackerPlan(plan: ProductionPlan, brief: import('./generative/longform.js').LongformBrief, recipe: string) {
  prepareTrackerJobPlan(plan, brief.profile, recipe);
  if (!['senior_longform', 'yasa_longform'].includes(brief.profile)) throw new Error('scene production requires an existing scene Longform profile');
  const steps = validateProductionPlan(plan);
  if (JSON.stringify(plan).length > 256000) throw new Error('productionPlan is too large');
  if (steps.some(s => !['script','image','voice','render'].includes(s.kind))) throw new Error('unsupported executable production step');
  for (const kind of ['script','voice','render']) if (steps.filter(s => s.kind === kind).length !== 1) throw new Error('productionPlan requires exactly one ' + kind);
  const script: any = steps.find(s => s.kind === 'script')!.config?.script;
  const errors = validateLongformScript(script, brief);
  if (errors.length) throw new Error('productionPlan script: ' + errors.join(', '));
  const images = steps.filter(s => s.kind === 'image');
  const scenes = script.sections.flatMap((s: any) => s.scenes);
  if (!images.length || images.length !== scenes.length || new Set(scenes.map((s: any) => s.id)).size !== scenes.length || images.some((s,i) => s.sceneId !== scenes[i].id)) throw new Error('image steps must match script scenes in order');
  if (images.some(s => s.config && Object.keys(s.config).length)) throw new Error('image content must be in script scenes, not ignored config');
  if (steps.some(s => ['voice','render'].includes(s.kind) && s.config && Object.keys(s.config).length)) throw new Error('voice/render settings belong to the existing brief');
  // These modes generate additional reference pictures before the scene loop. Keep them
  // on the legacy path until they have the same durable provider-call protection.
  if ((brief as any).thumbnailFirst || creativeGolden(brief.creative)) throw new Error('productionPlan requires a non-reference visual style');
  if (brief.remaster || brief.sleepClassic) throw new Error('productionPlan cannot be combined with remaster or sleep preset')
  // storyboard panel references: Senior scene pictures only (the 야담 contract has its own fixed reference frames)
  if (scenes.some((s: any) => s.panel) && brief.profile !== 'senior_longform') throw new Error('storyboard panel references require senior_longform');
  return { plan: JSON.parse(JSON.stringify(plan)) as ProductionPlan, script, images };
}
import { validateLongformScript } from './generative/longform.js';
import { creativeGolden } from './generative/creativeProfile.js';
