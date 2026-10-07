// 숨은야사 Longform (profile yasa_longform): the STORY DNA drama on the Longform engine in its story "scenes" mode — the
// same PLAN checkpoints, scene pictures with a Character Bible, sentence TTS + timing, bottom subtitle cards, gentle
// motion, render, thumbnail and upload package as Senior Longform. What is yasa's own:
//   - the PLAN starts with the YASA STORY DNA (lib/story/yasaStoryDna.ts), made once and checkpointed (or sent in, checked)
//   - six acts that ARE the DNA structure, sized so the major reveal starts at ~80% of the narration
//   - deterministic checks of every act and of the whole script against the DNA (no AI QC)
//   - scene pictures keep the story's own country / era (costume, architecture, props) and the concrete prop's look
import { composeImagePrompt, type VisualStyleProfile } from './visualStyle.js'
import { characterLine, type SeniorScene, type SeniorScript } from './seniorLongform.js'
import { checkYasaScript, propKeyword, validateYasaStoryDna } from '../story/yasaStoryDna.js'

// the six acts = the DNA structure (shares of the narration; the reveal act starts at 0.80)
export const YASA_ACTS = [
  { key: 'hook', share: 0.12, beats: ['openingLine', 'mystery.strangeAction', 'mystery.concreteProp', 'pressure.immediateLoss', 'mystery.mainQuestion'], role: 'Start INSIDE the strange event with the openingLine: the strangeAction and the concreteProp are on screen from the first sentence; the immediate loss and the WHY question (mainQuestion). No background lecture.' },
  { key: 'relation', share: 0.18, beats: ['hero', 'mystery.apparentMeaning', 'pressure.humiliationOrMisunderstanding'], role: 'The people and their relationship, the hero\'s ONE wound; what everyone believes the act/prop means (apparentMeaning); humiliation or misunderstanding.' },
  { key: 'pressure', share: 0.22, beats: ['pressure.worseningEvents', 'pressure.antagonistOrPressure'], role: 'The worseningEvents step by step (each one worse, never the same hardship twice); doubt grows. Do not reveal the answer.' },
  { key: 'proof_crisis', share: 0.28, beats: ['reveal.partialProof', 'reveal.majorCrisis'], role: 'A small proof (partialProof) that the prop/act is not ordinary, then the major crisis (majorCrisis): life, wealth, family or honour truly at stake. The true meaning is still hidden.' },
  { key: 'reveal', share: 0.12, beats: ['reveal.majorReveal', 'mystery.trueMeaning'], role: 'The MAJOR REVEAL: the true meaning (trueMeaning) of the strangeAction and the concreteProp; the opening scenes now mean something else. Name the prop.' },
  { key: 'payoff', share: 0.08, beats: ['reveal.emotionalReframe', 'payoff'], role: 'The emotional reframe and the reward or price (payoff); a short afterglow. Do not explain at length.' }
] as const
export const YASA_REVEAL_ACT = 4
// the reveal act must start inside this share of the narration (target 0.80; the 80~92% window with room for drift)
export const YASA_REVEAL_WINDOW = { min: 0.7, max: 0.93 } as const

export const yasaActChars = (totalChars: number) => YASA_ACTS.map((a) => Math.max(1, Math.round(totalChars * a.share)))
const textOf = (sents: any[]) => (Array.isArray(sents) ? sents : []).map((x) => String(x?.say || '').trim()).filter(Boolean).join(' ')
const charsOf = (t: string) => [...t.replace(/\s+/g, '')].length
const hasProp = (t: string, dna: any) => t.replace(/\s+/g, '').includes(String(propKeyword(dna)).replace(/\s+/g, ''))

// one act, before it is stored (a failure gets the step's one repair with these exact errors)
export function yasaActErrors(index: number, sentences: any[], dna: any, targetChars: number): string[] {
  const t = textOf(sentences), e: string[] = []
  if (index === 0) e.push(...checkYasaScript(t, dna).errors.map((x) => `yasa.${x}`))
  if (index === YASA_REVEAL_ACT && !hasProp(t, dna)) e.push(`yasa.reveal: the concreteProp "${String(dna?.mystery?.concreteProp || '')}" must be named in the reveal`)
  if (t && charsOf(t) < targetChars * 0.5) e.push(`yasa.act_too_short ${charsOf(t)}/${targetChars}`)
  return e
}
// where the reveal act starts, as a share of the whole narration
export function yasaRevealAt(sections: Array<{ sentences: any[] }>): number {
  const sizes = sections.map((s) => charsOf(textOf(s.sentences))), total = sizes.reduce((a, b) => a + b, 0)
  return total ? sizes.slice(0, YASA_REVEAL_ACT).reduce((a, b) => a + b, 0) / total : 0
}
// the finished script against its DNA (deterministic, no AI): DNA valid, six acts, opening + prop, prop in the reveal,
// the reveal in its window
export function yasaScriptErrors(script: any): string[] {
  const dna = script?.yasaStoryDNA, sections = Array.isArray(script?.sections) ? script.sections : []
  const e = validateYasaStoryDna(dna, 'longform').errors.map((x) => `yasa.dna.${x}`)
  if (sections.length !== YASA_ACTS.length) return [...e, `yasa.acts ${sections.length}/${YASA_ACTS.length}`]
  e.push(...checkYasaScript(sections.map((s: any) => textOf(s.sentences)).join(' '), dna).errors.map((x) => `yasa.${x}`))
  if (!hasProp(textOf(sections[YASA_REVEAL_ACT].sentences), dna)) e.push('yasa.reveal: concreteProp not named in the reveal')
  const at = yasaRevealAt(sections)
  if (at < YASA_REVEAL_WINDOW.min || at > YASA_REVEAL_WINDOW.max) e.push(`yasa.reveal_at ${Math.round(at * 100)}% (window ${YASA_REVEAL_WINDOW.min * 100}~${YASA_REVEAL_WINDOW.max * 100}%)`)
  return e
}

// the scene picture: the story's own country/era, the Character Bible, the prop's one look, the ONE style
export function yasaScenePrompt(s: SeniorScript & { yasaStoryDNA?: any }, scene: SeniorScene, style: VisualStyleProfile): string {
  const dna = s.yasaStoryDNA ?? {}, set = dna.setting ?? {}, prop = String(dna.mystery?.concreteProp || '').trim()
  const people = scene.characters.map((id) => s.characters.find((c) => c.id === id)).filter(Boolean).map((c) => characterLine(c!))
  const showsProp = prop && hasProp(`${scene.visual} ${scene.action}`, dna)
  return composeImagePrompt({
    content: [
      `${scene.visual} Place: ${scene.place}. Time: ${scene.time}. Action: ${scene.action}. Mood: ${scene.mood}`,
      `Setting: ${set.region || ''}, ${set.era || ''}${set.culturalNotes ? ` (${set.culturalNotes})` : ''} — clothing, hairstyles, architecture and objects belong to exactly this place and time`,
      ...(showsProp ? [`The key object "${prop}" looks exactly the same in every picture`] : [])
    ].join('. '),
    style,
    composition: 'Wide 16:9 story frame. Faces and the key action in the upper two thirds; the bottom quarter calm and simple (subtitles are added later).',
    characters: people,
    negative: 'modern objects, costumes or buildings of another country or era'
  })
}
