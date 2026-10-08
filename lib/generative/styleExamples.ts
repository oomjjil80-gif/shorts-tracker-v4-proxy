// 그림체 EXAMPLE pictures: the same files the app shows when the user picks a style (web app
// assets/style-previews/<family>/<style>.jpg), shipped with the server. The FIRST thumbnail of a job is drawn FROM the
// example of the style the user chose (image edit with the real file), so it already looks like what they picked;
// the scene itself is this story's. A style that has an example never silently falls back to text-only drawing:
// a missing / unreadable file stops with STYLE_EXAMPLE_MISSING.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { YADAM_STYLE_KEYS } from './visualStyle.js'

export const STYLE_EXAMPLES_DIR = process.env.TRACKER_STYLE_EXAMPLES_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'style-examples')
// style key -> its example file (relative to STYLE_EXAMPLES_DIR). Only styles the app shows an example for.
export const STYLE_EXAMPLES: Readonly<Record<string, string>> = Object.fromEntries(YADAM_STYLE_KEYS.map((k) => [k, `yadam/${k}.jpg`]))
export const styleExampleFor = (styleKey: string | null | undefined) => (styleKey && STYLE_EXAMPLES[styleKey] ? styleKey : null)
export type StyleExample = { style: string; file: string; bytes: Buffer; sha: string }
export class StyleExampleMissing extends Error { code = 'STYLE_EXAMPLE_MISSING' }
export async function loadStyleExample(styleKey: string, dir = STYLE_EXAMPLES_DIR): Promise<StyleExample> {
  const file = STYLE_EXAMPLES[styleKey]
  if (!file) throw new StyleExampleMissing(`no example picture is registered for the style ${styleKey}`)
  const bytes = await readFile(join(dir, file)).catch(() => null)
  if (!bytes || bytes.length < 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new StyleExampleMissing(`the example picture of the style ${styleKey} (${file}) is missing or not a JPEG`)
  return { style: styleKey, file, bytes, sha: createHash('sha256').update(bytes).digest('hex') }
}
// the example gives the LOOK only; the scene, people and objects come from this story
export const styleExamplePrompt = (scenePrompt: string) => [
  'STYLE EXAMPLE ATTACHED: the attached image is the art style the user chose. Draw a NEW picture in exactly that rendering: the same coloring method and palette, line work, brush / watercolor / paper texture, lighting, and the same way of drawing people (faces, proportions, expressions).',
  'Do NOT copy the example\'s scene, composition, people, clothing details or objects; the scene below replaces it entirely.',
  '',
  scenePrompt
].join('\n')
