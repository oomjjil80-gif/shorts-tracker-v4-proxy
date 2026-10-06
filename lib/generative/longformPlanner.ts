import type { LongformBrief, LongformSentence } from './longform.js'
import { ACCENTS, sectionPlan } from './longform.js'
import { UPLOAD_METADATA_RULES } from './uploadPackage.js'

// The Longform script is written in small, separately stored steps so a 60-120+ minute script never depends on one
// giant model response: (1) the outline (title, hook, figure, thumbnail, one heading + points per section),
// (2) each section's narration + cards, (3) the upload text from the finished narration. The PLAN stage checkpoints
// every step; a retry continues from the first missing step. The renderer never invents text.
export type LongformOutline = {
  title: string; hook: string
  figure: { name: string; imagePrompt: string }
  thumbnail: { lines: Array<{ text: string; color: keyof typeof ACCENTS }> }
  sections: Array<{ id: string; heading: string; points: string[] }>
}
export type LongformSectionDraft = { sentences: LongformSentence[] }
export type LongformMetadataDraft = { title: string; description: string; tags: string[]; hashtags: string[]; pinnedComment: string }
export type LongformPlanner = {
  outline: (brief: LongformBrief, sections: number, apiKey: string, repair?: string[]) => Promise<LongformOutline>
  section: (i: { brief: LongformBrief; outline: LongformOutline; index: number; previousTail: string[]; targetChars: number; repair?: string[] }, apiKey: string) => Promise<LongformSectionDraft>
  metadata: (i: { brief: LongformBrief; title: string; headings: string[]; narration: string; repair?: string[] }, apiKey: string) => Promise<LongformMetadataDraft>
}

const str = { type: 'string' }
const CARD_COLORS = ['red', 'purple', 'green', 'yellow']
const CARD_RULES = 'Each sentence object: "say" = exactly what is spoken (one or two natural sentences). "show" = the KEY phrase of that moment for the screen, EXACTLY 2 or 3 short lines (each <=14 Korean characters including spaces), condensed, never the full sentence and never a single line. "accent" = the exact word or phrase that appears inside one "show" line and carries the meaning (it is coloured); REQUIRED on every card. "color" = one of red, purple, green, yellow (never white). Vary colors; never colour a whole card.'
const VOICE = 'Calm, warm, clear spoken Korean for a long YouTube talk; no stage directions, no headings read aloud.'
const repairNote = (r?: string[]) => (r?.length ? `\n\n[REPAIR] The previous draft was rejected: ${r.join(', ')}. Fix exactly these points.` : '')

async function respond(apiKey: string, name: string, schema: any, instructions: string, input: string, f: typeof fetch = fetch, model = process.env.OPENAI_PLAN_MODEL || 'gpt-6-luna'): Promise<any> {
  if (!apiKey) throw new Error('OPENAI_API_KEY missing')
  const res = await f('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, instructions, input, text: { format: { type: 'json_schema', name, strict: true, schema } } }) })
  if (!res.ok) throw new Error(`OpenAI longform ${name} HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const j: any = await res.json(); const raw = j.output_text ?? j.output?.flatMap((x: any) => x.content ?? []).find((x: any) => x.type === 'output_text')?.text
  if (!raw) throw new Error(`OpenAI longform ${name} returned no output_text`)
  return JSON.parse(raw)
}

export const openAiLongformPlanner = (f: typeof fetch = fetch): LongformPlanner => ({
  async outline(brief, sections, apiKey, repair) {
    const schema = { type: 'object', additionalProperties: false, required: ['title', 'hook', 'figure', 'thumbnail', 'sections'], properties: {
      title: str, hook: str,
      figure: { type: 'object', additionalProperties: false, required: ['name', 'imagePrompt'], properties: { name: str, imagePrompt: str } },
      thumbnail: { type: 'object', additionalProperties: false, required: ['lines'], properties: { lines: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['text', 'color'], properties: { text: str, color: { type: 'string', enum: Object.keys(ACCENTS) } } } } } },
      sections: { type: 'array', minItems: sections, maxItems: sections, items: { type: 'object', additionalProperties: false, required: ['id', 'heading', 'points'], properties: { id: str, heading: str, points: { type: 'array', minItems: 2, maxItems: 5, items: str } } } }
    } }
    const instructions = [
      `You plan a Korean wisdom/life-lesson LONGFORM YouTube talk of about ${Math.round(brief.targetSeconds / 60)} minutes. ${VOICE}`,
      `Write ONLY the outline: a strong title and spoken hook, and exactly ${sections} sections in order (opening, development with concrete everyday examples, a clear turn, a memorable ending). Each section: a short heading and 2-5 points it will develop. Sections must not repeat each other.`,
      'figure.imagePrompt: the ONE representative person for the whole video. If the topic names a person (e.g. the Buddha, a philosopher), it is THAT person, depicted recognizably; never replace a named figure. Describe only the person, clothing and mood; composition is added later.',
      'thumbnail.lines: 2-3 separate meaning units (<=8 Korean characters each, spaces not counted) that make a viewer NEED to click. NEVER the title or a trimmed title. Colour by meaning: the key word/phrase red, purple or green; not every line the same colour.'
    ].join('\n')
    return respond(apiKey, 'wisdom_longform_outline', schema, instructions, `Input kind: ${brief.kind}\nTopic or source: ${brief.text}${repairNote(repair)}`, f)
  },
  async section({ brief, outline, index, previousTail, targetChars, repair }, apiKey) {
    const schema = { type: 'object', additionalProperties: false, required: ['sentences'], properties: { sentences: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['say', 'show', 'accent', 'color'], properties: { say: str, show: { type: 'array', minItems: 2, maxItems: 3, items: str }, accent: str, color: { type: 'string', enum: CARD_COLORS } } } } } }
    const sec = outline.sections[index], last = index === outline.sections.length - 1
    const instructions = [
      `You write ONE section of a Korean wisdom LONGFORM talk titled "${outline.title}". ${VOICE}`,
      `This is section ${index + 1} of ${outline.sections.length}. Its narration ("say" fields joined) should be about ${targetChars} Korean characters.`,
      index === 0 ? `Open with this hook, spoken naturally: "${outline.hook}".` : 'Continue naturally from the previous section (do not greet again, do not repeat earlier points).',
      last ? 'This is the LAST section: bring the talk to a calm, memorable close.' : 'Do not conclude the whole talk here.',
      CARD_RULES
    ].join('\n')
    const input = [`Topic or source: ${brief.text}`, `All sections: ${outline.sections.map((s, k) => `${k + 1}. ${s.heading}`).join(' / ')}`, `THIS section: ${sec.heading} — ${sec.points.join('; ')}`, previousTail.length ? `The previous section ended with: ${previousTail.join(' ')}` : ''].filter(Boolean).join('\n')
    return respond(apiKey, 'wisdom_longform_section', schema, instructions, input + repairNote(repair), f)
  },
  async metadata({ brief, title, headings, narration, repair }, apiKey) {
    const schema = { type: 'object', additionalProperties: false, required: ['title', 'description', 'tags', 'hashtags', 'pinnedComment'], properties: { title: str, description: str, tags: { type: 'array', items: str }, hashtags: { type: 'array', items: str }, pinnedComment: str } }
    const instructions = ['Write the YouTube upload text for THIS finished Korean longform video, from its actual content (keep the title unless it breaks a rule):', UPLOAD_METADATA_RULES].join('\n')
    // the opening, the section plan and the closing are enough context; the full narration of a 2-hour talk is not sent
    const excerpt = narration.length > 6000 ? `${narration.slice(0, 3000)} … ${narration.slice(-2000)}` : narration
    return respond(apiKey, 'wisdom_longform_metadata', schema, instructions, `Topic: ${brief.text}\nTitle: ${title}\nSections: ${headings.join(' / ')}\nNarration: ${excerpt}${repairNote(repair)}`, f)
  }
})

// How many sections and how long each is, for a brief (the running time only sizes the script).
export const outlineSize = (brief: LongformBrief) => sectionPlan(brief.targetSeconds)
