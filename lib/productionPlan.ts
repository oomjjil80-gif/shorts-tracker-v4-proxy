/** Declarative, format-neutral production planning. No paid calls or side effects. */
export type ProductionStepKind = 'research' | 'outline' | 'script' | 'review' | 'image' | 'voice' | 'render' | 'package';
export type ProductionStep = { id: string; kind: ProductionStepKind; dependsOn: string[]; sceneId?: string; config?: Record<string, unknown> };
export type ProductionPlan = { id: string; title: string; format: 'video' | 'carousel'; steps: ProductionStep[]; constraints?: { maxScenes?: number; maxCostUsd?: number } };
export type StepExecutor = (step: ProductionStep, prior: ReadonlyMap<string, unknown>) => Promise<unknown>;
export type ExecutionResult = { outputs: Map<string, unknown>; completed: string[] };
const kinds = new Set<ProductionStepKind>(['research','outline','script','review','image','voice','render','package']);
export function validateProductionPlan(plan: ProductionPlan): ProductionStep[] {
  if (!plan.id?.trim() || !plan.title?.trim()) throw new Error('plan identity required');
  if (!['video','carousel'].includes(plan.format)) throw new Error('invalid format');
  if (!plan.steps.length) throw new Error('empty plan');
  if (plan.constraints?.maxScenes !== undefined && (!Number.isInteger(plan.constraints.maxScenes) || plan.constraints.maxScenes < 1)) throw new Error('invalid maxScenes');
  if (plan.constraints?.maxCostUsd !== undefined && (!Number.isFinite(plan.constraints.maxCostUsd) || plan.constraints.maxCostUsd < 0)) throw new Error('invalid maxCostUsd');
  const byId = new Map<string, ProductionStep>();
  for (const step of plan.steps) {
    if (!step.id?.trim() || !kinds.has(step.kind) || byId.has(step.id)) throw new Error('invalid or duplicate step');
    byId.set(step.id, step);
  }
  const scenes = new Set(plan.steps.filter(s => s.sceneId).map(s => s.sceneId));
  if (plan.constraints?.maxScenes !== undefined && scenes.size > plan.constraints.maxScenes) throw new Error('scene limit exceeded');
  const ordered: ProductionStep[] = [], visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) {
    const step = byId.get(id);
    if (!step) throw new Error('unknown dependency: ' + id);
    if (visiting.has(id)) throw new Error('dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of step.dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id); ordered.push(step);
  }
  for (const step of plan.steps) visit(step.id);
  return ordered;
}
/** Caller supplies existing Tracker adapters. No adapter is invoked until explicitly executed. */
export async function executeProductionPlan(plan: ProductionPlan, executors: Partial<Record<ProductionStepKind, StepExecutor>>, approvedStepIds: ReadonlySet<string>, seed?: ReadonlyMap<string, unknown>): Promise<ExecutionResult> {
  const ordered = validateProductionPlan(plan);
  const outputs = new Map(seed ?? []), completed: string[] = [];
  for (const step of ordered) {
    if (outputs.has(step.id)) { completed.push(step.id); continue; }
    if (!approvedStepIds.has(step.id)) throw new Error('step not approved: ' + step.id);
    const executor = executors[step.kind];
    if (!executor) throw new Error('missing executor: ' + step.kind);
    const result = await executor(step, new Map(outputs));
    outputs.set(step.id, result);
    completed.push(step.id);
  }
  return { outputs, completed };
}
