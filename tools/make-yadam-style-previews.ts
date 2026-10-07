// One-time maker of the 숨은야담 그림체 preview pictures (one per style). They are STATIC files in the web app
// (assets/style-previews/yadam/<style>.jpg): the screen never calls an image API. Every style draws the same scene with
// the same production prompt (yasaScenePrompt: scene -> Joseon LOCK -> Character Bible -> style -> negatives), so only
// the style differs. A file that already exists is never made again (5 paid images in total, once).
//   OPENAI_API_KEY=... npx tsx tools/make-yadam-style-previews.ts <web-app>/assets/style-previews/yadam
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { VISUAL_STYLE_PROFILES, YADAM_STYLE_KEYS } from '../lib/generative/visualStyle.js'
import { yasaScenePrompt } from '../lib/generative/yasaLongform.js'
import { openAiLongformImage } from '../lib/generative/providers.js'

const out = process.argv[2]
if (!out) throw new Error('usage: make-yadam-style-previews.ts <output dir>')
const key = process.env.OPENAI_API_KEY || ''
// the common scene: a Joseon village yard, a young daughter-in-law and her old mother-in-law, meju and the crock terrace
const script: any = {
  characters: [
    { id: 'bride', name: '며느리', role: 'young daughter-in-law', age: 22, gender: 'female', appearance: 'a beautiful young Korean woman, gentle oval face, serious but kind eyes', hair: 'neat Joseon married-woman chignon with a wooden binyeo', outfit: 'pale yellow jeogori, deep blue chima, white apron cloth', props: '' },
    { id: 'mother', name: '시어머니', role: 'old mother-in-law', age: 65, gender: 'female', appearance: 'a dignified elderly Korean woman, graceful wrinkles, calm firm gaze', hair: 'grey hair in a low chignon with a silver binyeo', outfit: 'muted grey-green jeogori and charcoal chima', props: '' }
  ],
  yasaStoryDNA: { setting: { region: '조선', era: '후기 (18세기)', culturalNotes: '시골 마을' }, mystery: { concreteProp: '메주' } }
}
const scene: any = {
  id: 'preview', place: 'the yard in front of the kitchen of a thatched-roof choga house, a jangdokdae crock terrace behind', time: 'warm late afternoon',
  characters: ['bride', 'mother'], action: 'the mother-in-law hands the young daughter-in-law a block of 메주 wrapped in straw; both look at each other seriously',
  mood: 'warm, lyrical, quietly serious', visual: 'a Joseon countryside village yard; blocks of meju hang from straw ropes under the eaves'
}
await mkdir(out, { recursive: true })
for (const k of YADAM_STYLE_KEYS) {
  const file = join(out, `${k}.jpg`)
  if (await stat(file).then(() => true, () => false)) { console.log(`kept ${file}`); continue }
  if (!key) throw new Error('OPENAI_API_KEY is not set (needed once to make the missing previews)')
  const img = await openAiLongformImage(yasaScenePrompt(script, scene, VISUAL_STYLE_PROFILES[k]), key)
  await writeFile(file, img.bytes)
  console.log(`made ${file}`)
}
