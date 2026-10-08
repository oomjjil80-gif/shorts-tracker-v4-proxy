// The click copy rewritten ONCE when it fails the thumbnail checks (grammar / the title / broken Hangul / a spoiler /
// not about this story): one structured text call with the exact problems; the result is checked again by the caller.
import { respond, str } from './longformPlanner.js'
import { THUMB_COLORS, type ThumbLine } from './wisdomThumbnail.js'

export const openAiThumbnailCopyWriter = (f: typeof fetch = fetch) => async (script: any, issues: string[], apiKey: string): Promise<ThumbLine[]> => {
  const schema = { type: 'object', additionalProperties: false, required: ['lines'], properties: { lines: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['text', 'color'], properties: { text: str, color: { type: 'string', enum: Object.keys(THUMB_COLORS) } } } } } }
  const instructions = [
    'Rewrite the YouTube click thumbnail copy (Korean) for the video below: 2-3 separate meaning units, each at most 8 Korean characters, correct spelling and grammar, natural Korean.',
    'It must be about THIS story (its person, object or strange event), make a viewer need to click, and never reveal the ending, the answer or the true meaning. Never the title itself.',
    'Colour the key word red, purple or green; the other lines white or yellow.',
    `Fix exactly these problems of the current copy: ${issues.join('; ')}`
  ].join('\n')
  const input = [`Title: ${script?.title ?? ''}`, `Hook: ${script?.hook ?? ''}`, `Current copy: ${(script?.thumbnail?.lines ?? []).map((l: any) => l?.text).join(' / ')}`].join('\n')
  const r = await respond(apiKey, 'thumbnail_copy', schema, instructions, input, f)
  return r.lines
}
