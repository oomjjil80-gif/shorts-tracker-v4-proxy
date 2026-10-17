import { BLOCKS, recipeErrors, type BlockId, type BlockProgress, type ContentRecipe } from './recipe.js'

export type BlockDecision =
  | Readonly<{ state: 'INVALID'; errors: readonly string[] }>
  | Readonly<{ state: 'COMPLETE' }>
  | Readonly<{ state: 'WAITING_APPROVAL'; block: BlockId }>
  | Readonly<{ state: 'READY'; block: BlockId; paid: boolean }>
  | Readonly<{ state: 'IN_PROGRESS'; block: BlockId }>

/** Pure scheduler for a persisted recipe snapshot; never triggers paid calls. */
export function nextBlockDecision(recipe: ContentRecipe, progress: readonly BlockProgress[]): BlockDecision {
  const errors = recipeErrors(recipe)
  if (errors.length) return { state: 'INVALID', errors }
  const byBlock = new Map<BlockId, BlockProgress>()
  for (const item of progress) {
    if (byBlock.has(item.block)) return { state: 'INVALID', errors: [`duplicate progress for ${item.block}`] }
    if (!recipe.steps.some(s => s.block === item.block && s.skipReason === undefined)) {
      return { state: 'INVALID', errors: [`unexpected progress for ${item.block}`] }
    }
    if (item.status === 'SKIPPED') return { state: 'INVALID', errors: [`unexpected SKIPPED progress for ${item.block}`] }
    byBlock.set(item.block, item)
  }
  for (const step of recipe.steps) {
    if (step.skipReason !== undefined) continue
    const spec = BLOCKS[step.block]
    const status = byBlock.get(step.block)?.status
    if (status === 'RUNNING') return { state: 'IN_PROGRESS', block: step.block }
    if (spec.approval) {
      if (status === 'APPROVED') continue
      if (status === 'SUCCEEDED') return { state: 'WAITING_APPROVAL', block: step.block }
      return { state: 'READY', block: step.block, paid: !!spec.paid }
    }
    if (status === 'SUCCEEDED' || status === 'APPROVED') continue
    return { state: 'READY', block: step.block, paid: !!spec.paid }
  }
  return { state: 'COMPLETE' }
}
