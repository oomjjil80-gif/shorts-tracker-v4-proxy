// The Senior Longform planner: the same three checkpointed steps as Wisdom Longform (outline -> each section -> upload
// text) and the same LongformPlanner interface, written for a STORY: the outline holds the Character Bible and six acts,
// each with its visual scenes; an act's sentences each name the scene they are told over. The upload text step is the
// Wisdom Longform one (same rules).
import { ACCENTS } from './longform.js'
import { openAiLongformPlanner, respond, repairNote, str, CARD_COLORS, CARD_RULES, type LongformPlanner } from './longformPlanner.js'
import { SENIOR, seniorScenePlan } from './seniorLongform.js'

const VOICE = 'Warm, clear spoken Korean storytelling for older viewers on YouTube: natural, unhurried, easy to follow; no stage directions, no headings read aloud.'
const CHARACTER = { type: 'object', additionalProperties: false, required: ['id', 'name', 'role', 'gender', 'age', 'face', 'hair', 'build', 'outfit', 'colors'], properties: { id: str, name: str, role: str, gender: str, age: str, face: str, hair: str, build: str, outfit: str, colors: str } }
const SCENE = { type: 'object', additionalProperties: false, required: ['id', 'place', 'time', 'characters', 'action', 'mood', 'visual'], properties: { id: str, place: str, time: str, characters: { type: 'array', items: str }, action: str, mood: str, visual: str } }

export const openAiSeniorPlanner = (f: typeof fetch = fetch): LongformPlanner => ({
  async outline(brief, sections, apiKey, repair) {
    const plan = seniorScenePlan(brief.targetSeconds), { min, max } = plan.scenesPerAct
    const schema = { type: 'object', additionalProperties: false, required: ['title', 'hook', 'figure', 'thumbnail', 'characters', 'sections'], properties: {
      title: str, hook: str,
      figure: { type: 'object', additionalProperties: false, required: ['name', 'imagePrompt'], properties: { name: str, imagePrompt: str } },
      thumbnail: { type: 'object', additionalProperties: false, required: ['lines'], properties: { lines: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['text', 'color'], properties: { text: str, color: { type: 'string', enum: Object.keys(ACCENTS) } } } } } },
      characters: { type: 'array', minItems: 1, maxItems: 6, items: CHARACTER },
      sections: { type: 'array', minItems: sections, maxItems: sections, items: { type: 'object', additionalProperties: false, required: ['id', 'heading', 'points', 'scenes'], properties: { id: str, heading: str, points: { type: 'array', minItems: 2, maxItems: 5, items: str }, scenes: { type: 'array', minItems: 2, maxItems: 7, items: SCENE } } } }
    } }
    const instructions = [
      `You plan a Korean STORY video for older viewers (senior YouTube), about ${Math.round(brief.targetSeconds / 60)} minutes. ${VOICE} It is a moving, believable life story told like a drama, never an explainer or a list.`,
      `Exactly ${sections} acts in this order (adapt naturally to the story): ${SENIOR.actRoles.map((r, i) => `${i + 1}) ${r}`).join('; ')}.`,
      'characters (Character Bible): every person who appears, each with a short id (e.g. "mother"), Korean name, role, gender, approximate age, face features, hair, build, signature outfit and colors. Realistic Korean people; the same description is reused in every picture so they always look the same.',
      `scenes: for each act ${min}-${max} VISUAL scenes in story order. A new scene ONLY when the place, the time, the people present, the key action or a big emotional turn changes; never one scene per sentence. Each scene: id (unique in the act, e.g. "a1s1"), place (a real Korean everyday place: home, market, hospital, street, restaurant...), time, characters (ids from the bible), action, mood, visual (what the picture shows, one or two sentences, no text in the picture).`,
      'figure: the main character (name + appearance) for reference. thumbnail.lines: 2-3 separate meaning units (<=8 Korean characters each) that make a viewer NEED to click; never the title; colour the key word red, purple or green.'
    ].join('\n')
    return respond(apiKey, 'senior_longform_outline', schema, instructions, `Input kind: ${brief.kind}\nStory topic or source: ${brief.text}${repairNote(repair)}`, f)
  },
  async section({ brief, outline, index, previousTail, targetChars, repair }, apiKey) {
    const act: any = outline.sections[index], last = index === outline.sections.length - 1
    const schema = { type: 'object', additionalProperties: false, required: ['sentences'], properties: { sentences: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['scene', 'say', 'show', 'accent', 'color'], properties: { scene: { type: 'string', enum: (act?.scenes ?? []).map((s: any) => s.id) }, say: str, show: { type: 'array', minItems: 2, maxItems: 3, items: str }, accent: str, color: { type: 'string', enum: CARD_COLORS } } } } } }
    const instructions = [
      `You write act ${index + 1} of ${outline.sections.length} of the Korean story "${outline.title}". ${VOICE}`,
      `Its narration ("say" fields joined) should be about ${targetChars} Korean characters. Tell it as a story: what people do, say and feel, concrete details, natural dialogue in narration.`,
      index === 0 ? `Open with this hook, spoken naturally: "${outline.hook}".` : 'Continue naturally from the previous act (no greeting, no recap).',
      last ? 'This is the LAST act: close the story with a quiet aftertaste and what it means for a life.' : 'Do not end the story here.',
      'Every sentence has "scene": the id of the scene it is told over. Use the scenes in their order (never go back to an earlier scene) and use every scene.',
      'Subtitles: "show" are the 2-3 short lines shown at the bottom of the screen for that sentence.', CARD_RULES
    ].join('\n')
    const cast = ((outline as any).characters ?? []).map((c: any) => `${c.id} = ${c.name} (${c.role})`).join('; ')
    const input = [`Story: ${brief.text}`, `Characters: ${cast}`, `All acts: ${outline.sections.map((s, k) => `${k + 1}. ${s.heading}`).join(' / ')}`, `THIS act: ${act.heading} — ${act.points.join('; ')}`, `Scenes of this act: ${(act.scenes ?? []).map((s: any) => `${s.id}: ${s.place}, ${s.time}, ${s.action} (${s.mood})`).join(' | ')}`, previousTail.length ? `The previous act ended with: ${previousTail.join(' ')}` : ''].filter(Boolean).join('\n')
    return respond(apiKey, 'senior_longform_act', schema, instructions, input + repairNote(repair), f)
  },
  metadata: (i, apiKey) => openAiLongformPlanner(f).metadata(i, apiKey)
})
