/** Resolve a creative plan against the SAME recipe snapshot used by Tracker Jobs.
 * Read-only preflight: never creates jobs, triggers workers or approves paid work.
 */
import { bridgeProductionPlan } from './productionRecipeBridge.js';
import { recipeFor, bindingErrors } from './jobs/recipes.js';
import { PROFILES, type ProfileId } from './jobs/profiles.js';
import type { ProductionPlan } from './productionPlan.js';

export function prepareTrackerJobPlan(plan: ProductionPlan, profileId: ProfileId, recipeId: string) {
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
