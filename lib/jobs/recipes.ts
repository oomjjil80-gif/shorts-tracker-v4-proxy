// Recipe registry for the block engine. A content type = a Profile (stages/modules that already exist) + a Recipe (which blocks
// run, in what order, where the user must approve) + a binding of the Profile's stages to the Recipe's blocks. Adding a content
// type is adding an entry here — there is no per-content engine.
import { BLOCK_IDS, BLOCKS, recipeErrors, type BlockId, type ContentRecipe } from './recipe.js'
import { PROFILES } from './profiles.js'
import type { JobStage } from './types.js'

export type RecipeBinding = Readonly<{
  recipe: ContentRecipe
  // which Profile stage runs which block (a stage without a block runs as before, ungated)
  stageBlocks: Readonly<Partial<Record<JobStage, BlockId>>>
  // enforced = the engine gates paid blocks on the recipe's approvals; compat = labels a legacy job only
  enforced: boolean
  profiles: readonly string[]
}>

const COMPAT_REASON = '기존 프로필의 단계 흐름이 처리합니다(호환 모드)'
const compat = (profile: string): [string, RecipeBinding] => [`legacy_${profile}`, {
  recipe: { id: `legacy_${profile}`, provides: [], steps: BLOCK_IDS.map((block) => ({ block, skipReason: COMPAT_REASON })) },
  stageBlocks: {}, enforced: false, profiles: [profile]
}]

export const RECIPES: Readonly<Record<string, RecipeBinding>> = Object.freeze({
  // the six existing profiles keep their stage flow (no new gate): the recipe only records that they are legacy
  ...Object.fromEntries(Object.keys(PROFILES).map(compat)),
  // 지혜/야담 쇼츠 with a script check: the script (PLAN) is written first, then NOTHING paid (images, voice, render) runs
  // until the user approves exactly that script. Same Profile, same modules.
  wisdom_shorts_script_approval: {
    recipe: {
      id: 'wisdom_shorts_script_approval',
      provides: ['brief', 'research', 'packaging', 'reviewedScript', 'approvedStyle'],
      steps: [
        { block: 'RESEARCH', skipReason: '주제/대본 입력을 그대로 사용합니다' },
        { block: 'PACKAGING', skipReason: '제목·썸네일은 기존 업로드 정보 단계가 만듭니다' },
        { block: 'SCRIPT' },
        { block: 'REVIEW', skipReason: '대본 확인은 사용자 승인으로 대신합니다' },
        { block: 'SCRIPT_APPROVAL' },
        { block: 'STYLE_APPROVAL', skipReason: '그림체는 제작 설정으로 이미 정해져 있습니다' },
        { block: 'ASSETS' },
        { block: 'RENDER' },
        { block: 'FINAL_REVIEW', skipReason: '기존 최종 결정 단계가 처리합니다' }
      ]
    },
    stageBlocks: { PLAN: 'SCRIPT', ASSET: 'ASSETS', RENDER: 'RENDER' },
    enforced: true, profiles: ['wisdom', 'yasa_shorts']
  }
})

export const recipeFor = (id: string): RecipeBinding | null => (Object.prototype.hasOwnProperty.call(RECIPES, id) ? RECIPES[id] : null)

// Wiring checks (run in tests and before a job is bound): a valid recipe, bound stages that exist in the Profile and in
// the recipe, bound blocks that are not approvals, every active non-approval block reachable through a stage.
export function bindingErrors(b: RecipeBinding, profileId: string): string[] {
  const errors = recipeErrors(b.recipe)
  const profile = (PROFILES as Record<string, (typeof PROFILES)[keyof typeof PROFILES]>)[profileId]
  if (!profile) return [...errors, `unknown profile ${profileId}`]
  if (!b.profiles.includes(profileId)) errors.push(`${b.recipe.id}: not meant for profile ${profileId}`)
  const active = new Set(b.recipe.steps.filter((s) => s.skipReason === undefined).map((s) => s.block))
  const bound = new Set<BlockId>()
  for (const [stage, block] of Object.entries(b.stageBlocks) as [JobStage, BlockId][]) {
    if (!profile.stages.includes(stage)) errors.push(`${b.recipe.id}: stage ${stage} is not in profile ${profileId}`)
    if (!active.has(block)) errors.push(`${b.recipe.id}: stage ${stage} is bound to inactive block ${block}`)
    else if (BLOCKS[block].approval) errors.push(`${b.recipe.id}: approval block ${block} cannot be bound to a stage`)
    if (bound.has(block)) errors.push(`${b.recipe.id}: block ${block} is bound to two stages`)
    bound.add(block)
  }
  // blocks must run in the order of the profile's stages
  let last = -1
  for (const step of b.recipe.steps) {
    if (!bound.has(step.block)) continue
    const stage = (Object.entries(b.stageBlocks).find(([, v]) => v === step.block)?.[0]) as JobStage
    const at = profile.stages.indexOf(stage)
    if (at < last) errors.push(`${b.recipe.id}: block ${step.block} runs out of stage order`)
    last = at
  }
  for (const block of active) if (!BLOCKS[block].approval && !bound.has(block)) errors.push(`${b.recipe.id}: active block ${block} has no stage`)
  return errors
}
