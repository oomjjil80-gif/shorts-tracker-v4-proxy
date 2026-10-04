import type { LongformBrief, LongformScript } from './longform.js'
import { LONGFORM, ACCENTS } from './longform.js'
import { UPLOAD_METADATA_RULES } from './uploadPackage.js'

// One structured call: title, hook, the whole narration as sentences, the card shown for each sentence, the single image
// subject, the thumbnail phrase and the upload text. The renderer never invents text; it only lays out these fields.
export async function openAiLongformPlan(brief: LongformBrief, apiKey: string, model = process.env.OPENAI_PLAN_MODEL || 'gpt-6-luna', f: typeof fetch = fetch): Promise<LongformScript> {
  if (!apiKey) throw new Error('OPENAI_API_KEY missing')
  const colors = Object.keys(ACCENTS)
  const str = { type: 'string' }
  const cardColors = ['red', 'purple', 'green', 'yellow']
  const schema = { type: 'object', additionalProperties: false, required: ['schema', 'title', 'hook', 'figure', 'thumbnail', 'metadata', 'sections'], properties: {
    schema: { type: 'string', const: 'wisdom-longform-script/1' }, title: str, hook: str,
    figure: { type: 'object', additionalProperties: false, required: ['name', 'imagePrompt'], properties: { name: str, imagePrompt: str } },
    thumbnail: { type: 'object', additionalProperties: false, required: ['lines'], properties: { lines: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['text', 'color'], properties: { text: str, color: { type: 'string', enum: colors } } } } } },
    metadata: { type: 'object', additionalProperties: false, required: ['description', 'tags', 'hashtags', 'pinnedComment'], properties: { description: str, tags: { type: 'array', items: str }, hashtags: { type: 'array', items: str }, pinnedComment: str } },
    sections: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'sentences'], properties: { id: str, sentences: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['say', 'show', 'accent', 'color'], properties: { say: str, show: { type: 'array', minItems: 2, maxItems: 3, items: str }, accent: str, color: { type: 'string', enum: cardColors } } } } } } }
  } }
  const chars = Math.round(brief.targetSeconds * LONGFORM.charsPerSecond)
  const instructions = [
    'You write complete Korean wisdom/life-lesson LONGFORM narration for YouTube (calm, warm, clear spoken Korean, no stage directions).',
    `Length: the narration ("say" fields joined) must be ${Math.round(chars * 0.9)}-${Math.round(chars * 1.1)} Korean characters (~${Math.round(brief.targetSeconds / 60)} minutes); shorter or longer drafts are rejected. Structure: strong hook, 4-8 sections that each develop one idea with concrete everyday examples, a clear turn, and a memorable ending.`,
    'Each sentence object: "say" = exactly what is spoken (one or two natural sentences). "show" = the KEY phrase of that moment for the screen, EXACTLY 2 or 3 short lines (each <=14 Korean characters including spaces), condensed, never the full sentence and never a single line. "accent" = the exact word or phrase that appears inside one "show" line and carries the meaning (it is coloured); REQUIRED on every card. "color" = one of red, purple, green, yellow (never white). Vary colors; never colour a whole card.',
    'figure.imagePrompt: the ONE representative person for the whole video (a philosopher, historical sage or wise elder fitting the topic; if the topic names a person, depict that person recognizably). Describe only the person, clothing and mood; composition is added later.',
    'thumbnail.lines: 2-3 separate meaning units (<=8 Korean characters each, spaces not counted) that make a viewer NEED to click (curiosity/warning/benefit/contrast). NEVER the title or a trimmed title. Colour by meaning: the key word/phrase red, purple or green; do not use only white/yellow; not every line the same colour. Example shape: ["절대"(red),"만만하게"(purple),"보이지 마라"(green)].',
    'title + metadata = the YouTube upload text for THIS video, written from its actual content:', UPLOAD_METADATA_RULES
  ].join('\n')
  const input = `Input kind: ${brief.kind}\nTopic or source: ${brief.text}`
  const res = await f('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, instructions, input, text: { format: { type: 'json_schema', name: 'wisdom_longform_plan', strict: true, schema } } }) })
  if (!res.ok) throw new Error(`OpenAI longform PLAN HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const j: any = await res.json(); const raw = j.output_text ?? j.output?.flatMap((x: any) => x.content ?? []).find((x: any) => x.type === 'output_text')?.text
  if (!raw) throw new Error('OpenAI longform PLAN returned no output_text')
  return JSON.parse(raw)
}
