/** Pure nine-panel Instagram plan: no providers, storage writes or billing. */
import { validateProductionPlan, type ProductionPlan } from '../productionPlan.js'

export type NinePanel = Readonly<{ id: string; headline: string; body: string; imageRef?: string }>
export function createCardnewsProductionPlan(input: { id: string; title: string; panels: readonly NinePanel[] }): ProductionPlan {
  if (!Array.isArray(input.panels) || input.panels.length !== 9) throw new Error('Instagram carousel requires exactly nine panels')
  const ids = new Set<string>()
  for (const [index, panel] of input.panels.entries()) {
    if (!panel || !panel.id?.trim() || ids.has(panel.id) || !panel.headline?.trim()) throw new Error('invalid or duplicate panel')
    if (index === 8 && !panel.body?.trim()) throw new Error('final reveal panel requires approved text')
    ids.add(panel.id)
  }
  const plan: ProductionPlan = {
    id: input.id, title: input.title, format: 'carousel', constraints: { maxScenes: 9 },
    steps: [
      { id: 'approved-script', kind: 'script', dependsOn: [], config: { panels: input.panels.map(p => ({ id:p.id, headline:p.headline, body:p.body })) } },
      ...input.panels.map((p,i) => ({ id: 'panel-'+(i+1), kind: 'image' as const, sceneId: p.id, dependsOn: ['approved-script'], config: { panelIndex:i+1, aspectRatio:'4:5', ...(p.imageRef ? { existingImageRef:p.imageRef } : {}) } })),
      { id:'carousel-package', kind:'package', dependsOn:input.panels.map((_,i)=>'panel-'+(i+1)), config:{ format:'zip', panelCount:9, aspectRatio:'4:5' } }
    ]
  }
  validateProductionPlan(plan)
  return plan
}

/** Derived from the existing saved deck; never rewrites approved text or treats storyboard crops as finals. */
export function planForCardnewsState(state: any, id = 'cardnews'): ProductionPlan | null {
  if (!state?.cover || state?.cards?.length !== 8 || !state.scriptConfirmedAt || state.review?.ok !== true) return null
  const panels = [{ id: 'cover', headline: state.cover.title, body: state.cover.coverLine || '' }, ...state.cards]
  const plan = createCardnewsProductionPlan({ id, title: state.cover.title, panels })
  for (const step of plan.steps.filter(s => s.kind === 'image')) {
    const card = panels.find(c => c.id === step.sceneId)
    step.config = { ...step.config, visualPlan: card.visualPlan || null, storyboardRef: state.refs?.storyboard?.[step.sceneId!]?.ref || null }
  }
  return plan
}
