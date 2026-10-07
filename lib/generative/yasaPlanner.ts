// The 숨은야담 Longform planner: the same checkpointed steps and LongformPlanner interface as Senior Longform, written
// from the YASA STORY DNA. Step 0 (dna) makes the DNA with the same schema, rules and check as the yasa_story_plan task;
// the outline puts the Character Bible and each act's visual scenes on the DNA's six acts; an act's sentences each name
// their scene. The upload text step is the Wisdom Longform one (same rules).
import { ACCENTS, type LongformBrief } from './longform.js'
import { openAiLongformPlanner, respond, repairNote, str, CARD_COLORS, CARD_RULES, type LongformPlanner } from './longformPlanner.js'
import { YASA_ACTS, COLD_OPEN, yasaScenesFor } from './yasaLongform.js'
import { YASA_STORY_DNA_SCHEMA, yasaPlanInstructions, yasaScriptBrief } from '../story/yasaStoryDna.js'

export type YasaColdOpenInput = { brief: LongformBrief; outline: any; sections: Array<{ id: string; heading: string; scenes: any[]; sentences: any[] }>; candidates?: Array<{ id: string; at: number; act: number; preferred: boolean }>; targetChars: number; repair?: string[] }
export type YasaPlanner = LongformPlanner & {
  dna: (brief: LongformBrief, apiKey: string, repair?: string[]) => Promise<any>
  coldOpen: (i: YasaColdOpenInput, apiKey: string) => Promise<{ sentences: any[] }>
}
const VOICE = 'Gripping spoken Korean drama narration for YouTube (야담 storytelling: an old tale told to the listener): concrete people, actions and objects; natural dialogue inside the narration; no stage directions, no headings read aloud, never a history lecture.'
const CHARACTER = { type: 'object', additionalProperties: false, required: ['id', 'name', 'role', 'gender', 'age', 'face', 'hair', 'build', 'outfit', 'colors'], properties: { id: str, name: str, role: str, gender: str, age: str, face: str, hair: str, build: str, outfit: str, colors: str } }
const SCENE = { type: 'object', additionalProperties: false, required: ['id', 'place', 'time', 'characters', 'action', 'mood', 'visual'], properties: { id: str, place: str, time: str, characters: { type: 'array', items: str }, action: str, mood: str, visual: str } }
const dnaOf = (brief: any) => brief?.yasaStoryDNA

export const openAiYasaPlanner = (f: typeof fetch = fetch): YasaPlanner => ({
  async dna(brief, apiKey, repair) {
    return respond(apiKey, 'yasa_story_dna', YASA_STORY_DNA_SCHEMA, yasaPlanInstructions('longform', brief.targetSeconds), `[소재]\n${brief.text}${repair?.length ? `\n\n[수정 필요 — 이전 PLAN이 구조 검사에서 실패]\n- ${repair.join('\n- ')}` : ''}`, f)
  },
  async outline(brief, sections, apiKey, repair) {
    const dna = dnaOf(brief), perAct = yasaScenesFor(brief.targetSeconds)
    const schema = { type: 'object', additionalProperties: false, required: ['title', 'hook', 'figure', 'thumbnail', 'characters', 'sections'], properties: {
      title: str, hook: str,
      figure: { type: 'object', additionalProperties: false, required: ['name', 'imagePrompt'], properties: { name: str, imagePrompt: str } },
      thumbnail: { type: 'object', additionalProperties: false, required: ['lines'], properties: { lines: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['text', 'color'], properties: { text: str, color: { type: 'string', enum: Object.keys(ACCENTS) } } } } } },
      characters: { type: 'array', minItems: 1, maxItems: 6, items: CHARACTER },
      sections: { type: 'array', minItems: sections, maxItems: sections, items: { type: 'object', additionalProperties: false, required: ['id', 'heading', 'points', 'scenes'], properties: { id: str, heading: str, points: { type: 'array', minItems: 2, maxItems: 5, items: str }, scenes: { type: 'array', minItems: 2, maxItems: 7, items: SCENE } } } }
    } }
    const instructions = [
      `You plan a Korean 숨은야담 LONGFORM drama video of about ${Math.round(brief.targetSeconds / 60)} minutes, built ONLY from the STORY DNA below (keep its people, setting, prop, questions and reveal). ${VOICE}`,
      `Exactly ${sections} acts in this order: ${YASA_ACTS.map((a, i) => `${i + 1}) ${a.role}`).join(' ')}`,
      'title: keep the DNA title (or a sharper version with the same person, prop and unanswered WHY). hook: the DNA openingLine.',
      'characters (Character Bible): every person who appears, each with a short id, name fitting the DNA setting, role, gender, approximate age, face, hair, build, signature outfit and colors of THAT country and era; the same description is reused in every picture.',
      `scenes: per act about ${perAct.map((r, i) => `${i + 1}) ${r.min}-${r.max}`).join(', ')} VISUAL scenes in story order (a guide, never padding). A new scene ONLY when the place, time, people present, key action or a big emotional turn changes. Each scene: id (unique, e.g. "a1s1"), place (in the DNA region/era), time, characters (ids), action, mood, visual (one or two sentences; period-accurate costume, architecture and objects; show the concreteProp where it matters; no text in the picture).`,
      'figure: the hero (name + appearance). thumbnail.lines: 2-3 separate meaning units (<=8 Korean characters each) that make a viewer NEED to click; never the title; colour the key word red, purple or green.',
      yasaScriptBrief(dna, 'longform')
    ].join('\n')
    return respond(apiKey, 'yasa_longform_outline', schema, instructions, `Story topic: ${brief.text}${repairNote(repair)}`, f)
  },
  async section({ brief, outline, index, previousTail, targetChars, repair }, apiKey) {
    const act: any = outline.sections[index], last = index === outline.sections.length - 1, dna = dnaOf(brief)
    const schema = { type: 'object', additionalProperties: false, required: ['sentences'], properties: { sentences: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['scene', 'say', 'show', 'accent', 'color'], properties: { scene: { type: 'string', enum: (act?.scenes ?? []).map((s: any) => s.id) }, say: str, show: { type: 'array', minItems: 2, maxItems: 3, items: str }, accent: str, color: { type: 'string', enum: CARD_COLORS } } } } } }
    const instructions = [
      `You write act ${index + 1} of ${outline.sections.length} of the 숨은야담 drama "${outline.title}". ${VOICE}`,
      `THIS act's job: ${YASA_ACTS[index]?.role ?? ''}`,
      `Its narration ("say" fields joined) should be about ${targetChars} Korean characters.`,
      index === 0 ? 'The main story starts right after a separate cold open (a later moment of the story): begin naturally from the real beginning of the story (the people and the strange event), never with background ("옛날 ○○시대에는…"), never a recap of the cold open. If it helps, the first sentence may carry a short natural time cue back to before that moment (e.g. 사흘 전 / 며칠 전 / 그 일이 있기 전 — your own words, not a fixed phrase).' : 'Continue naturally from the previous act (no greeting, no recap).',
      'Length comes only from real story progress (relationship, misunderstanding, small kindness, pressure, worsening, proof, crisis, false ending, truth, further results, reframe). Never repeat a hardship, an explanation or a conflict; no empty dialogue; no padding with background.',
      last ? 'This is the LAST act: close with the emotional reward and a short afterglow.' : 'Do not end the story here and do not reveal more than this act allows.',
      'Every sentence has "scene": the id of the scene it is told over. Use the scenes in their order (never go back) and use every scene.',
      'Subtitles: "show" are the 2-3 short lines shown at the bottom of the screen for that sentence.', CARD_RULES,
      yasaScriptBrief(dna, 'longform')
    ].join('\n')
    const cast = ((outline as any).characters ?? []).map((c: any) => `${c.id} = ${c.name} (${c.role})`).join('; ')
    const input = [`Story: ${brief.text}`, `Characters: ${cast}`, `All acts: ${outline.sections.map((s, k) => `${k + 1}. ${s.heading}`).join(' / ')}`, `THIS act: ${act.heading} — ${act.points.join('; ')}`, `Scenes of this act: ${(act.scenes ?? []).map((s: any) => `${s.id}: ${s.place}, ${s.time}, ${s.action} (${s.mood})`).join(' | ')}`, previousTail.length ? `The previous act ended with: ${previousTail.join(' ')}` : ''].filter(Boolean).join('\n')
    return respond(apiKey, 'yasa_longform_act', schema, instructions, input + repairNote(repair), f)
  },
  // the COLD OPEN: written after the main story, over the main story's own pictures (no new image), never the answer
  async coldOpen({ brief, outline, sections, candidates, targetChars, repair }, apiKey) {
    const dna = dnaOf(brief), all = sections.flatMap((s) => s.scenes)
    // only the allowed scenes (past the first 10%, before the reveal), the story's middle (15~65%) listed first
    const ok = candidates?.length ? candidates : all.map((x: any) => ({ id: String(x.id), at: 0, act: 0, preferred: false }))
    const byId = new Map(all.map((x: any) => [String(x.id), x]))
    const scenes = [...ok.filter((c) => c.preferred), ...ok.filter((c) => !c.preferred)].map((c) => ({ ...byId.get(c.id), id: c.id, preferred: c.preferred, at: c.at })).filter((x: any) => x.place !== undefined)
    const schema = { type: 'object', additionalProperties: false, required: ['sentences'], properties: { sentences: { type: 'array', minItems: COLD_OPEN.beats.min, maxItems: COLD_OPEN.beats.max, items: { type: 'object', additionalProperties: false, required: ['scene', 'say', 'show', 'accent', 'color'], properties: { scene: { type: 'string', enum: scenes.map((x: any) => x.id) }, say: str, show: { type: 'array', minItems: 2, maxItems: 3, items: str }, accent: str, color: { type: 'string', enum: CARD_COLORS } } } } } }
    const instructions = [
      `You write the COLD OPEN of the 숨은야담 drama "${outline.title}": the first ${COLD_OPEN.seconds.min}~${COLD_OPEN.seconds.max} seconds, BEFORE the main story starts. ${VOICE}`,
      `${COLD_OPEN.beats.min}~${COLD_OPEN.beats.max} sentences; each sentence is one visual beat on a DIFFERENT picture than the previous one (scene = one of the main story's scene ids). The narration ("say" joined) is about ${targetChars} Korean characters.`,
      'Pick the moments a viewer would be MOST curious about from the middle of the story (the strangeAction, the worst crisis without its outcome, the concreteProp, the mystery): most beats on the scenes marked [middle]. Never the story\'s opening scenes (the main story starts there right after this) and never anything from the reveal or the ending. The first sentence is the strange event itself (never background). End on the open question so the viewer must know WHY.',
      'NEVER reveal: the majorReveal, the trueMeaning, the firstResolution, the emotionalReframe, the payoff, how anything is solved or ends. Never copy or closely paraphrase a sentence of the main story; say it anew.',
      'Subtitles: "show" are the 2-3 short lines shown at the bottom of the screen for that sentence.', CARD_RULES,
      yasaScriptBrief(dna, 'longform')
    ].join('\n')
    const input = [`Story: ${brief.text}`, `Main story scenes you may use (pick from these only): ${scenes.map((x: any) => `${x.id}${x.preferred ? ' [middle]' : ''}: ${x.place}, ${x.time}, ${x.action} (${x.mood})`).join(' | ')}`, `Main story acts: ${sections.map((x) => x.heading).join(' / ')}`].join('\n')
    return respond(apiKey, 'yasa_longform_cold_open', schema, instructions, input + repairNote(repair), f)
  },
  metadata: (i, apiKey) => openAiLongformPlanner(f).metadata(i, apiKey)
})
