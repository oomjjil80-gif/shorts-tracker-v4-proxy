// 야담 V5 — STYLE FIDELITY. Same 3 user captures, same crop (yadamReferenceStyle.ts, V4 kept as it is). What changes,
// from the V4 request and result (flat fills, thin even outlines, small eyes without highlights, beige cast R-B +27 vs
// the references' 0..+15, lower contrast):
//  1. input_fidelity=high on the image edit (gpt-image-1 only; the API default is low): the reference images' detail
//     and rendering are kept instead of being re-drawn in the model's default illustration look.
//  2. The face close-up first (with high fidelity the FIRST image is reproduced with the richest detail): eyes, line
//     weight and shadow shapes are what V4 lost.
//  3. A short prompt (V4 was 2.4k characters of mostly generic words): the contract, then only the traits that make
//     this style (bold black ink line with strong weight variation, hard-edged cel shadows, deep contrast, detailed eyes
//     with catchlights, solid black glossy hair masses, saturated deep blues, crisp detailed backgrounds), the scene and
//     the framing. The words that pulled V4 toward a plain soft history illustration are gone (painterly, soft overcast,
//     earth brown, harmonious palette, subtle gradients, muted, watercolor, storybook, folk, sepia).
import { V4_CONTRACT, V4_FRAMING, V4_REFERENCES, buildV4Request } from './yadamReferenceStyle.js'

export const V5_ORDER = ['capture-2.jpg', 'capture-1.jpg', 'capture-3.jpg'] as const // face close-up first
export const V5_INPUT_FIDELITY = 'high'
export const V5_TRAITS = 'Match these traits of the reference frames exactly: Korean historical webtoon (manhwa) art; bold black ink contour lines with strong line-weight variation (thick outer contours, fine inner lines); hard-edged two-tone cel shadows with crisp shapes on faces, necks and clothing; deep value contrast; detailed eyes with dark lash lines, defined irises and catchlights; sharp defined brows, nose shadow and lips; solid glossy black hair masses with sharp strand lines and highlights; saturated deep indigo and slate-blue fabrics with ink-drawn folds; crisp, highly detailed backgrounds (stone walls, wood grain, roof tiles) at the same finish as the people; neutral, clean colour (no yellow or beige cast).'
export const V5_SCENE = 'New scene with new people: Joseon hanok courtyard (tiled roofs). A beautiful young woman (about 20, chignon with wooden binyeo, pale blue-grey jeogori, deep indigo chima) and a dignified older woman (about 60, silver-streaked chignon, dark plum jeogori, charcoal chima) pass a small bojagi bundle between their hands. Slightly low camera, medium shot, both faces large and clearly lit: the young woman moved, eyes wet; the older woman resolute. No text, subtitles, borders, panels, speech bubbles or watermark; Joseon clothing and buildings only.'
export const V5_PROMPT = [V4_CONTRACT, V5_TRAITS, V5_SCENE, V4_FRAMING].join('\n\n')

// the V5 request as sent: V4's cropped frames re-ordered (face first), high input fidelity, the V5 prompt
export async function buildV5Request(dir?: string) {
  const r = await buildV4Request(dir)
  const byName = new Map((r.form.getAll('image[]') as any[]).map((b) => [b.name, b]))
  const form = new FormData()
  form.append('model', r.model); form.append('prompt', V5_PROMPT); form.append('size', r.size); form.append('quality', r.quality)
  form.append('input_fidelity', V5_INPUT_FIDELITY); form.append('output_format', 'jpeg'); form.append('n', '1')
  for (const f of V5_ORDER) { const png = f.replace(/\.jpg$/, '.png'), b = byName.get(png); if (!b) throw new Error(`${png} missing`); form.append('image[]', b, png) }
  const inputs = V5_ORDER.map((f) => r.inputs.find((x) => x.file === f)!)
  return { ...r, form, inputs, inputFidelity: V5_INPUT_FIDELITY, prompt: V5_PROMPT }
}
export const V5_REFERENCES = V5_ORDER.map((f) => V4_REFERENCES.find((r) => r.file === f)!)
