// "Is this picture drawn in the SAME art style as the approved one?" — one small vision call with both pictures
// (shrunk to 512 px, low detail). Asked only after the free colour + texture checks passed, so a clearly different
// picture never costs a call. Colour and brightness alone never count as the same style.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOk } from '../media/ffmpeg.js'
import type { StyleJudge, StyleJudgement } from './styleApproval.js'

async function small(bytes: Buffer): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'style-judge-'))
  try { await writeFile(join(d, 'i'), bytes); await runOk(['-y', '-i', join(d, 'i'), '-vf', 'scale=512:-2', '-q:v', '4', join(d, 'o.jpg')]); return (await readFile(join(d, 'o.jpg'))).toString('base64') }
  finally { await rm(d, { recursive: true, force: true }) }
}
export const openAiStyleJudge = (f: typeof fetch = fetch, model = process.env.OPENAI_STYLE_JUDGE_MODEL || 'gpt-5-mini'): StyleJudge => async (reference, candidate, apiKey): Promise<StyleJudgement> => {
  const schema = { type: 'object', additionalProperties: false, required: ['same', 'score', 'differences'], properties: { same: { type: 'boolean' }, score: { type: 'integer' }, differences: { type: 'array', items: { type: 'string' } } } }
  const text = [
    'Image 1 is the APPROVED art style. Image 2 must be drawn in exactly the same art style (the scene and people may differ).',
    'Compare ONLY the rendering: medium (watercolor / ink wash / digital cel / painterly oil / storybook gouache), line work (outline thickness, presence of ink outlines), shading method (flat cel vs soft gradients vs brush texture), texture and paper grain, level of detail, how faces and bodies are drawn (proportions, eyes, realism level).',
    'Similar colours or similar brightness do NOT make it the same style. If the medium, line work or face rendering differs, it is NOT the same style.',
    'score 0-100 = how certain the art style is identical. differences: short phrases, empty when identical.'
  ].join('\n')
  const res = await f('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: `data:image/jpeg;base64,${await small(reference)}`, detail: 'low' }, { type: 'input_image', image_url: `data:image/jpeg;base64,${await small(candidate)}`, detail: 'low' }] }], text: { format: { type: 'json_schema', name: 'style_judgement', strict: true, schema } } }) })
  if (!res.ok) throw new Error(`OpenAI style judge: ${res.status}`)
  const j: any = await res.json(), raw = j.output_text ?? j.output?.flatMap((x: any) => x.content ?? []).find((x: any) => x.type === 'output_text')?.text
  if (!raw) throw new Error('OpenAI style judge returned no output_text')
  const r = JSON.parse(raw)
  return { same: r.same === true, score: Math.max(0, Math.min(100, Number(r.score) || 0)), differences: Array.isArray(r.differences) ? r.differences.slice(0, 6).map(String) : [] }
}
