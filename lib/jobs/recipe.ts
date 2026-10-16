/** Declarative content recipe contract. No paid execution or legacy stage migration in this module. */
export const BLOCK_IDS = ['RESEARCH', 'PACKAGING', 'SCRIPT', 'REVIEW', 'SCRIPT_APPROVAL', 'STYLE_APPROVAL', 'ASSETS', 'RENDER', 'FINAL_REVIEW'] as const
export type BlockId = typeof BLOCK_IDS[number]
export type BlockSpec = Readonly<{
  id: BlockId
  requires: readonly string[]
  produces: readonly string[]
  approval?: boolean
  paid?: boolean
}>
export type RecipeStep = Readonly<{ block: BlockId; skipReason?: string }>
export type ContentRecipe = Readonly<{
  id: string
  provides: readonly string[]
  steps: readonly RecipeStep[]
}>
export const BLOCKS: Readonly<Record<BlockId, BlockSpec>> = {
  RESEARCH: { id: 'RESEARCH', requires: ['brief'], produces: ['research'] },
  PACKAGING: { id: 'PACKAGING', requires: ['research'], produces: ['packaging'], approval: true },
  SCRIPT: { id: 'SCRIPT', requires: ['packaging'], produces: ['script'], paid: true },
  REVIEW: { id: 'REVIEW', requires: ['script'], produces: ['reviewedScript'], paid: true },
  SCRIPT_APPROVAL: { id: 'SCRIPT_APPROVAL', requires: ['reviewedScript'], produces: ['approvedScript'], approval: true },
  STYLE_APPROVAL: { id: 'STYLE_APPROVAL', requires: ['approvedScript'], produces: ['approvedStyle'], approval: true },
  ASSETS: { id: 'ASSETS', requires: ['approvedScript', 'approvedStyle'], produces: ['assets'], paid: true },
  RENDER: { id: 'RENDER', requires: ['assets'], produces: ['video'], paid: true },
  FINAL_REVIEW: { id: 'FINAL_REVIEW', requires: ['video'], produces: ['finalVideo'], approval: true }
}
export function recipeErrors(recipe: ContentRecipe, blocks: Readonly<Record<BlockId, BlockSpec>> = BLOCKS): string[] {
  const errors: string[] = []
  const available = new Set(recipe.provides)
  const seen = new Set<BlockId>()
  for (const step of recipe.steps) {
    const spec = Object.prototype.hasOwnProperty.call(blocks, step.block) ? blocks[step.block] : undefined
    if (!spec) { errors.push(`${recipe.id}: unknown block ${step.block}`); continue }
    if (seen.has(step.block)) errors.push(`${recipe.id}: duplicate block ${step.block}`)
    seen.add(step.block)
    if (step.skipReason !== undefined) {
      if (!step.skipReason.trim()) errors.push(`${recipe.id}: empty skip reason for ${step.block}`)
      continue
    }
    for (const requirement of spec.requires) {
      if (!available.has(requirement)) errors.push(`${recipe.id}.${step.block}: missing ${requirement}`)
    }
    for (const output of spec.produces) available.add(output)
  }
  return errors
}
export type BlockProgress = Readonly<{ block: BlockId; status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'APPROVED' | 'SKIPPED'; inputHash?: string; artifactRef?: string }>
/** Reject paid work until all earlier approvals are explicitly recorded. */
export function canExecuteBlock(recipe: ContentRecipe, progress: readonly BlockProgress[], target: BlockId): boolean {
  if (recipeErrors(recipe).length) return false
  const index = recipe.steps.findIndex(s => s.block === target && s.skipReason === undefined)
  if (index < 0) return false
  const byBlock = new Map(progress.map(p => [p.block, p]))
  for (const step of recipe.steps.slice(0, index)) {
    if (step.skipReason !== undefined) continue
    const spec = BLOCKS[step.block]
    const state = byBlock.get(step.block)?.status
    if (spec.approval ? state !== 'APPROVED' : state !== 'SUCCEEDED' && state !== 'APPROVED') return false
  }
  return true
}
