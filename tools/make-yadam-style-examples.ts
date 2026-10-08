// One-time maker of the 숨은야담 그림체 EXAMPLE pictures (the app shows them; the first thumbnail of a job is drawn from
// the chosen one). Quality first: gpt-image-1, quality high, 1536x1024 landscape — the same size as every picture of the
// video. Every style draws the SAME Joseon scene with the production prompt (yasaScenePrompt: scene -> Joseon LOCK ->
// Character Bible -> style -> negatives), so only the style differs. A file that already exists is never made again.
// Writes <out>/<style>.jpg and <out>/report.json (measured colour / light numbers — advisory, people judge the look).
//   OPENAI_API_KEY from the environment (never printed): npx tsx tools/make-yadam-style-examples.ts <out dir>
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { VISUAL_STYLE_PROFILES, YADAM_STYLE_KEYS } from '../lib/generative/visualStyle.js'
import { yasaScenePrompt } from '../lib/generative/yasaLongform.js'
import { imageStyleFeatures, imageTextureFeatures } from '../lib/generative/styleApproval.js'
import { runOk } from '../lib/media/ffmpeg.js'

const out = process.argv[2]
if (!out) throw new Error('usage: make-yadam-style-examples.ts <output dir>')
const key = process.env.OPENAI_API_KEY || ''
const script: any = {
  characters: [
    { id: 'bride', name: '며느리', role: 'young daughter-in-law', age: 22, gender: 'female', appearance: 'a beautiful young Korean woman, gentle oval face, natural warm skin, serious but kind eyes', hair: 'neat Joseon married-woman chignon with a wooden binyeo', outfit: 'pale yellow jeogori, deep blue chima, white apron cloth', props: '' },
    { id: 'mother', name: '시어머니', role: 'old mother-in-law', age: 65, gender: 'female', appearance: 'a dignified elderly Korean woman, graceful wrinkles, calm firm gaze', hair: 'grey hair in a low chignon with a silver binyeo', outfit: 'jade green jeogori and charcoal chima', props: '' }
  ],
  yasaStoryDNA: { setting: { region: '조선', era: '후기 (18세기)', culturalNotes: '시골 마을' }, mystery: { concreteProp: '메주' } }
}
const scene: any = {
  id: 'example', place: 'the sunny yard in front of the kitchen of a thatched-roof choga house, a jangdokdae crock terrace behind, a persimmon tree', time: 'clear late morning, soft natural daylight',
  characters: ['bride', 'mother'], action: 'the mother-in-law hands the young daughter-in-law a block of 메주 wrapped in straw; both look at each other seriously',
  mood: 'warm, lyrical, quietly serious', visual: 'a Joseon countryside village yard; blocks of meju hang from straw ropes under the eaves'
}
async function draw(prompt: string): Promise<Buffer> {
  const r = await fetch('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1536x1024', quality: 'high', output_format: 'jpeg', n: 1 }) })
  if (!r.ok) throw new Error(`image generation failed ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const j: any = await r.json(); const b64 = j?.data?.[0]?.b64_json
  if (!b64) throw new Error('no image returned')
  return Buffer.from(b64, 'base64')
}
// advisory numbers only (people decide the look): warm cast of the bright areas, brightness, saturation, contrast, texture
async function measure(file: string) {
  const f = await imageStyleFeatures(file), t = await imageTextureFeatures(file)
  const raw = (await runOk(['-i', file, '-vf', 'scale=256:-2,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'])).stdout as Buffer
  let rb = 0, n = 0; for (let i = 0; i < raw.length; i += 3) { const l = 0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2]; if (l > 150) { rb += raw[i] - raw[i + 2]; n++ } }
  return { brightness: f.brightness, saturation: f.saturation, contrast: f.contrast, warmCastBrightAreas: n ? Math.round(rb / n) : null, palette: f.palette, texture: t }
}
await mkdir(out, { recursive: true })
const report: Record<string, unknown> = {}
for (const k of YADAM_STYLE_KEYS) {
  const file = join(out, `${k}.jpg`)
  if (!(await stat(file).then(() => true, () => false))) {
    if (!key) throw new Error('OPENAI_API_KEY is not set')
    await writeFile(file, await draw(yasaScenePrompt(script, scene, VISUAL_STYLE_PROFILES[k])))
    console.log(`made ${k}`)
  } else console.log(`kept ${k}`)
  report[k] = { label: VISUAL_STYLE_PROFILES[k].label, ...(await measure(file)) }
}
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 1))
// side-by-side sheet for people: new (top row, 1536x1024 each) vs the old example of the same style when there is one
const legacy = process.argv[3]
if (legacy) {
  const keys = [...YADAM_STYLE_KEYS], tiles: string[] = [], inputs: string[] = []
  keys.forEach((k, i) => { inputs.push('-i', join(out, `${k}.jpg`)); tiles.push(`[${i}:v]scale=768:512,drawbox=x=0:y=0:w=768:h=512:color=white@0:t=0[n${i}]`) })
  const old = await Promise.all(keys.map(async (k) => (await stat(join(legacy, `${k}.jpg`)).then(() => join(legacy, `${k}.jpg`), () => null))))
  old.forEach((f, i) => { inputs.push(...(f ? ['-i', f] : ['-f', 'lavfi', '-i', 'color=c=0xdddddd:s=768x512'])); tiles.push(`[${keys.length + i}:v]scale=768:512:force_original_aspect_ratio=decrease,pad=768:512:(ow-iw)/2:(oh-ih)/2:color=0xdddddd[o${i}]`) })
  const row = (p: string) => keys.map((_, i) => `[${p}${i}]`).join('') + `hstack=inputs=${keys.length}`
  await runOk(['-y', ...inputs, '-filter_complex', `${tiles.join(';')};${row('n')}[top];${row('o')}[bottom];[top][bottom]vstack[v]`, '-map', '[v]', '-frames:v', '1', '-q:v', '3', join(out, 'compare-new-top-old-bottom.jpg')])
  console.log('compare sheet written')
}
