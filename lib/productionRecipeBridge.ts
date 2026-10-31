/** Pure adapter: validates a flexible creative plan against Tracker's existing block recipe.
 * This does not run work or bypass persisted approval, billing or reuse gates.
 */
import { recipeErrors, type ContentRecipe, type BlockId } from './jobs/recipe.js';
import { validateProductionPlan, type ProductionPlan, type ProductionStepKind } from './productionPlan.js';

const mapping: Partial<Record<ProductionStepKind, BlockId>> = {
  research: 'RESEARCH', script: 'SCRIPT', review: 'REVIEW',
  image: 'ASSETS', voice: 'ASSETS', render: 'RENDER', package: 'FINAL_REVIEW',
};
export type ProductionRecipeBridge = Readonly<{
  planId: string;
  recipeId: string;
  sceneIds: readonly string[];
  stepToBlock: Readonly<Record<string, BlockId>>;
  /** All scene work is delegated to the single existing ASSETS stage. */
  assetStepIds: readonly string[];
}>;
export function bridgeProductionPlan(plan: ProductionPlan, recipe: ContentRecipe): ProductionRecipeBridge {
  const errors = recipeErrors(recipe);
  if (errors.length) throw new Error('invalid existing recipe: ' + errors.join('; '));
  const ordered = validateProductionPlan(plan);
  const active = new Set(recipe.steps.filter(s => s.skipReason === undefined).map(s => s.block));
  const mapped: Record<string, BlockId> = {};
  const assetStepIds: string[] = [];
  for (const step of ordered) {
    const block = mapping[step.kind];
    if (!block) throw new Error('unsupported existing block mapping: ' + step.kind);
    if (!active.has(block)) throw new Error('recipe does not execute block: ' + block);
    mapped[step.id] = block;
    if (block === 'ASSETS') assetStepIds.push(step.id);
  }
  const order = new Map(recipe.steps.map((step, index) => [step.block, index]));
  for (const step of ordered) {
    for (const dep of step.dependsOn) {
      if ((order.get(mapped[dep]) ?? -1) > (order.get(mapped[step.id]) ?? -1))
        throw new Error('plan dependency contradicts existing recipe order');
    }
  }
  return {
    planId: plan.id, recipeId: recipe.id,
    sceneIds: [...new Set(ordered.flatMap(step => step.sceneId ? [step.sceneId] : []))],
    stepToBlock: mapped, assetStepIds
  };
}
