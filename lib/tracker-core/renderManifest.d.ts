// Hand-written types for the verbatim-synced compiler (do not edit the .js copies).
export type ManifestIssue = { severity: 'error' | 'warning'; code: string; message: string }
export type RenderManifest = {
  schema: string
  compilerVersion: string
  manifestHash: string
  ok: boolean
  issues: ManifestIssue[]
  payload: any
  runtime: any
}
export function canonicalize(value: unknown): string
export function sha256Hex(text: string): string
export function compileRenderManifest(input: { episode: any; assetManifestResult?: any; variantPlan?: any; now?: number }): RenderManifest
export function sourceRangeToOutputRanges(segments: Array<{ start: number; duration: number; trimStart: number; trimEnd: number; speed?: number }>, srcStart: number, srcEnd: number): Array<{ start: number; end: number }>
