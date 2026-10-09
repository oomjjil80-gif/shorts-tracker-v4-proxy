// 야담 V4 STYLE REFERENCE LOCK — the 3 captures the user chose (one YADAM video, consecutive scenes) are THE style
// reference. They go to the image model as real images (image edit), as the PRIMARY style reference; the text only
// says what to keep (the drawing) and what to change (people, clothes, place, action, camera). Not wired into the
// production pipeline (AUTO / visualStyle.ts unchanged) until the user approves a result.
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOk, probe } from '../media/ffmpeg.js'

export const V4_REFERENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'style-reference', 'yadam-v4')
// phone screenshots 2340x1080 of a 1920x1080 video: cut the black side bars (x 210..2130) and the burned subtitles
// (from y 800 down); the "본 영상은 AI를 활용한 창작물입니다" label (top-left) is blurred out. Aspect kept (no stretching).
export const V4_REFERENCES = [
  { file: 'capture-1.jpg', role: 'two people, full figures, low angle, Joseon gate, overcast light' },
  { file: 'capture-2.jpg', role: 'face close-up: eyes, brows, skin shading, line weight' },
  { file: 'capture-3.jpg', role: 'medium shot with hanok roofs and stone wall: background detail and depth' }
] as const
export const V4_CROP = 'crop=1920:800:210:0,delogo=x=8:y=18:w=650:h=70'

// The generation contract (user-given, verbatim first), then what to keep, what to change, the content and the scene.
export const V4_CONTRACT = 'Use the supplied reference image as the primary visual style reference. Preserve its illustration craftsmanship, facial rendering approach, line quality, skin shading, hair detail, lighting sophistication, color harmony, and overall visual polish. Change the characters, costumes, environment, and narrative action according to the new scene description. Do not copy the identities or exact composition of the reference image.'
export const V4_PRESERVE = 'All three attached images are frames of ONE illustrated video and share one art style; reproduce that art style exactly: Korean historical webtoon (manhwa) rendering with clean confident black ink outlines of varying weight; semi-realistic, attractive face proportions with sharp expressive eyes, defined brows and natural mouths; cel shading with crisp shadow shapes softened by subtle gradients; natural tan skin tones; individually drawn hair strands; fabric with real folds, seams and wear; a detailed, painterly-realistic background (stone, wood grain, roof tiles) with depth; soft overcast natural daylight; the same cool, natural, harmonious palette (slate blue, indigo, stone grey, earth brown, soft sage greens) and the same level of finish.'
export const V4_CHANGE = 'New people, new clothes and hairstyles, new place, new action and a new camera framing come only from the scene below — never the reference characters (no headband servant, no bound girl), never their poses or composition.'
export const V4_CONTENT = 'Content rules (separate from style): Joseon dynasty Korea — Joseon hanbok, Joseon women\'s hairstyles (chignon with binyeo for married women), hanok architecture and Joseon household objects; no modern or Western clothing or buildings, no Chinese or Japanese costume. One single illustration, wide 16:9, no text, letters, captions, subtitles, borders, frames, panel layout, speech bubbles, logos or watermark.'
export const V4_SCENE = 'Scene: in the courtyard of a Joseon tiled-roof hanok, a young woman (about 20, beautiful, gentle, in a pale blue-grey jeogori and indigo chima, hair in a neat chignon with a wooden binyeo) and a dignified older woman (about 60, calm and serious, silver-streaked hair in a low chignon, dark plum jeogori and charcoal chima) hand a small cloth bundle wrapped in a bojagi to each other; medium shot at eye level so both faces and emotions read clearly — the young woman moved and uncertain, the older woman quietly resolute. Two clearly different faces.'
export const V4_PROMPT = [V4_CONTRACT, V4_PRESERVE, V4_CHANGE, V4_CONTENT, V4_SCENE].join('\n\n')

export type V4Input = { file: string; source: { width: number; height: number; bytes: number; sha256: string }; input: { width: number; height: number; bytes: number; sha256: string; format: 'png' }; role: string }
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
// the request exactly as it is sent: model, size, quality, the prompt and the reference images (in this order)
export async function buildV4Request(dir = V4_REFERENCE_DIR): Promise<{ form: FormData; inputs: V4Input[]; model: string; size: string; quality: string; endpoint: string }> {
  const work = await mkdtemp(join(tmpdir(), 'style-v4-'))
  try {
    const model = 'gpt-image-1', size = '1536x1024', quality = 'high', endpoint = 'https://api.openai.com/v1/images/edits'
    const form = new FormData()
    form.append('model', model); form.append('prompt', V4_PROMPT); form.append('size', size); form.append('quality', quality); form.append('output_format', 'jpeg'); form.append('n', '1')
    const inputs: V4Input[] = []
    for (const r of V4_REFERENCES) {
      const src = join(dir, r.file), out = join(work, r.file.replace(/\.jpg$/, '.png'))
      const sb = await readFile(src), si = await probe(src)
      if (si.width !== 2340 || si.height !== 1080) throw new Error(`${r.file}: expected the 2340x1080 capture, got ${si.width}x${si.height}`)
      await runOk(['-y', '-i', src, '-vf', V4_CROP, '-frames:v', '1', out])
      const ib = await readFile(out), ii = await probe(out)
      form.append('image[]', new Blob([new Uint8Array(ib)], { type: 'image/png' }), r.file.replace(/\.jpg$/, '.png'))
      inputs.push({ file: r.file, role: r.role, source: { width: Number(si.width), height: Number(si.height), bytes: sb.length, sha256: sha(sb) }, input: { width: Number(ii.width), height: Number(ii.height), bytes: ib.length, sha256: sha(ib), format: 'png' } })
    }
    return { form, inputs, model, size, quality, endpoint }
  } finally { await rm(work, { recursive: true, force: true }) }
}
