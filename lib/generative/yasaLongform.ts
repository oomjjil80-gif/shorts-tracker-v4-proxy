// 숨은야담 Longform (profile yasa_longform): the STORY DNA drama on the Longform engine in its story "scenes" mode — the
// same PLAN checkpoints, scene pictures with a Character Bible, sentence TTS + timing, bottom subtitle cards, gentle
// motion, render, thumbnail and upload package as Senior Longform. What is yadam's own:
//   - the PLAN starts with the YASA STORY DNA (lib/story/yasaStoryDna.ts), made once and checkpointed (or sent in, checked)
//   - eight acts that ARE the DNA structure: the major reveal starts at ~82% of the main story, then a first resolution and
//     at least two further layers before the reframe and the afterglow
//   - a separate COLD OPEN (45~60 s, 5~8 visual beats) before the main story, made from the main story's own pictures,
//     that shows the strangest act, the worst danger, the prop and the question — never the answer
//   - deterministic checks of every act, the cold open and the whole script against the DNA (no AI QC)
//   - scene pictures keep the story's own country / era (costume, architecture, props) and the concrete prop's look
import { composeImagePrompt, type VisualStyleProfile } from './visualStyle.js'
import { characterLine, type SeniorScene, type SeniorScript } from './seniorLongform.js'
import { checkYasaScript, propKeyword, validateYasaStoryDna } from '../story/yasaStoryDna.js'

// the eight acts (shares of the MAIN story narration; the cold open is not counted). The reveal act starts at 0.82.
export const YASA_ACTS = [
  { key: 'hook', share: 0.10, beats: ['mystery.strangeAction', 'mystery.concreteProp', 'pressure.immediateLoss', 'mystery.mainQuestion'], role: 'The main story begins (after the cold open): the people, the strangeAction and the concreteProp in their real order, the immediate loss and the WHY question. Natural storytelling start, no recap of the cold open, no background lecture.' },
  { key: 'relation', share: 0.14, beats: ['hero', 'mystery.apparentMeaning', 'pressure.humiliationOrMisunderstanding'], role: 'The people and their relationship, the hero\'s ONE wound, a small kindness or choice; what everyone believes the act/prop means (apparentMeaning); humiliation or misunderstanding.' },
  { key: 'pressure', share: 0.22, beats: ['pressure.worseningEvents', 'pressure.antagonistOrPressure'], role: 'The worseningEvents step by step, each one worse and DIFFERENT (never the same hardship twice); doubt grows. Do not reveal the answer.' },
  { key: 'proof', share: 0.14, beats: ['reveal.partialProof'], role: 'A small proof (partialProof) that the prop/act is not ordinary. Only a hint: the true meaning stays hidden.' },
  { key: 'crisis', share: 0.22, beats: ['reveal.majorCrisis'], role: 'The major crisis (majorCrisis): life, wealth, family or honour truly at stake; the highest pressure. The true meaning is still hidden.' },
  { key: 'reveal', share: 0.07, beats: ['reveal.majorReveal', 'mystery.trueMeaning', 'aftermath.firstResolution'], role: 'The MAJOR REVEAL: the true meaning (trueMeaning) of the strangeAction and the concreteProp (name the prop); the opening scenes now mean something else. Then the FIRST RESOLUTION: the problem in front of them is solved and it looks like the end.' },
  { key: 'aftermath', share: 0.07, beats: ['aftermath.postRevealLayers'], role: 'The story goes further: the postRevealLayers, IN ORDER, each a real further event, relationship change or consequence (e.g. what it means for the other person or the people around them). Never a repeat of earlier conflict, never added only to preach.' },
  { key: 'payoff', share: 0.04, beats: ['reveal.emotionalReframe', 'payoff'], role: 'The emotional reframe of the past act and the reward or price (payoff); a short afterglow. At most one short line of wisdom that comes from THIS story\'s actions and choices; no lecture, no famous quote, no "그러므로 우리는".' }
] as const
export const YASA_REVEAL_ACT = YASA_ACTS.findIndex((a) => a.key === 'reveal')
export const YASA_AFTERMATH_ACT = YASA_ACTS.findIndex((a) => a.key === 'aftermath')
// the reveal act must start inside this share of the main story narration
export const YASA_REVEAL_WINDOW = { min: 0.8, max: 0.92 } as const
// the cold open: before the main story, from the main story's own pictures
export const COLD_OPEN = { seconds: { min: 45, max: 60, target: 52 }, beats: { min: 5, max: 8 } } as const
// AUTO voice of 숨은야담 (defined with the other voices, lib/generative/voiceProfile.ts)
export { YADAM_VOICE, YADAM_STORYTELLER } from './voiceProfile.js'
import { YADAM_VOICE } from './voiceProfile.js'

export const yasaActChars = (totalChars: number) => YASA_ACTS.map((a) => Math.max(1, Math.round(totalChars * a.share)))
// how many pictures an act is likely to need: about one per 100 s of the whole story, spread by the act's share; a guide
// for the planner (a new picture only when place / time / people / key action / a big emotional turn really change)
export function yasaScenesFor(targetSeconds: number): Array<{ min: number; max: number }> {
  const total = Math.max(YASA_ACTS.length * 2, Math.round(targetSeconds / 100))
  // (2..6 per act, +1 room; the outline takes at most 7 scenes per act)
  return YASA_ACTS.map((a) => { const n = Math.max(2, Math.min(6, Math.round(total * a.share))); return { min: n, max: n + 1 } })
}
const textOf = (sents: any[]) => (Array.isArray(sents) ? sents : []).map((x) => String(x?.say || '').trim()).filter(Boolean).join(' ')
const charsOf = (t: string) => [...t.replace(/\s+/g, '')].length
const squash = (t: unknown) => String(t ?? '').replace(/[\s"'“”‘’.,!?…·\-]/g, '')
const hasProp = (t: string, dna: any) => t.replace(/\s+/g, '').includes(String(propKeyword(dna)).replace(/\s+/g, ''))
const LECTURE = /그러므로\s*우리는|우리는\s*이\s*이야기(?:를|에서)\s*통해|명언이\s*있습니다|교훈은\s*(?:다음과|이렇습니다)|여러분도\s*꼭|잊지\s*마십시오/

// one act, before it is stored (a failure gets the step's one repair with these exact errors)
export function yasaActErrors(index: number, sentences: any[], dna: any, targetChars: number): string[] {
  const t = textOf(sentences), e: string[] = []
  if (index === 0) e.push(...checkYasaScript(t, dna).errors.map((x) => `yasa.${x}`))
  if (index === YASA_REVEAL_ACT && !hasProp(t, dna)) e.push(`yasa.reveal: the concreteProp "${String(dna?.mystery?.concreteProp || '')}" must be named in the reveal`)
  if (index === YASA_ACTS.length - 1 && LECTURE.test(t)) e.push('yasa.lesson: a lecture ending ("그러므로 우리는…", a quote, a sermon) instead of a short line from the story')
  if (t && charsOf(t) < targetChars * 0.5) e.push(`yasa.act_too_short ${charsOf(t)}/${targetChars}`)
  return e
}
// where the reveal act starts, as a share of the MAIN story narration (the cold open is not part of it)
export function yasaRevealAt(sections: Array<{ sentences: any[] }>): number {
  const sizes = sections.map((s) => charsOf(textOf(s.sentences))), total = sizes.reduce((a, b) => a + b, 0)
  return total ? sizes.slice(0, YASA_REVEAL_ACT).reduce((a, b) => a + b, 0) / total : 0
}

// the words of the answer: what the reveal / true meaning / resolution / payoff name that the question side does not
// (so the cold open can show the mystery but never these)
const PARTICLE = /(으로부터|에게서|에서는|으로는|이라는|라는|에서|에게|으로|부터|까지|처럼|보다|이나|와|과|을|를|이|가|은|는|의|에|로|도|만)$/
const words = (t: unknown) => (String(t ?? '').match(/[가-힣A-Za-z0-9]{2,}/g) ?? []).map((w) => w.replace(PARTICLE, '')).filter((w) => [...w].length >= 2)
export function revealWords(dna: any): string[] {
  const answer = new Set([dna?.reveal?.majorReveal, dna?.mystery?.trueMeaning, dna?.aftermath?.firstResolution, dna?.payoff?.externalRewardOrResolution, dna?.payoff?.emotionalReward].flatMap(words))
  const question = new Set([dna?.mystery?.strangeAction, dna?.mystery?.concreteProp, dna?.mystery?.apparentMeaning, dna?.mystery?.mainQuestion, dna?.mystery?.secondaryQuestion, dna?.openingLine, dna?.title, dna?.reveal?.majorCrisis, dna?.reveal?.partialProof, dna?.pressure?.immediateLoss, dna?.pressure?.antagonistOrPressure, ...(dna?.pressure?.worseningEvents ?? []), dna?.setting?.region, dna?.setting?.era, ...Object.values(dna?.hero ?? {})].flatMap(words))
  return [...answer].filter((w) => !question.has(w) && [...w].length >= 2)
}
// the cold open, before it is stored: 5~8 beats, 45~60 s at the voice's speed, no background start, the prop, a beat change
// on every sentence, only main-story pictures, never the answer, never a main-story sentence repeated
export function coldOpenErrors(sentences: any[], o: { dna: any; sceneIds: Set<string>; mainSentences: string[]; speed: number; charsPerSecond: number }): string[] {
  const list = Array.isArray(sentences) ? sentences : [], e: string[] = [], t = textOf(list)
  if (list.length < COLD_OPEN.beats.min || list.length > COLD_OPEN.beats.max) e.push(`cold_open.beats ${list.length} (${COLD_OPEN.beats.min}~${COLD_OPEN.beats.max})`)
  const seconds = [...t].length / (o.charsPerSecond * o.speed)
  if (seconds < COLD_OPEN.seconds.min || seconds > COLD_OPEN.seconds.max) e.push(`cold_open.length about ${Math.round(seconds)}s (${COLD_OPEN.seconds.min}~${COLD_OPEN.seconds.max}s)`)
  e.push(...checkYasaScript(t, o.dna).errors.map((x) => `cold_open.${x}`))
  for (const [i, x] of list.entries()) {
    if (!o.sceneIds.has(String(x?.scene || ''))) e.push(`cold_open[${i}].scene: must be one of the main story's scenes`)
    if (i && String(x?.scene) === String(list[i - 1]?.scene)) e.push(`cold_open[${i}].scene: every beat shows a different picture`)
  }
  const leak = revealWords(o.dna).filter((w) => t.includes(w))
  if (leak.length) e.push(`cold_open.reveals_answer: ${leak.slice(0, 5).join(', ')}`)
  const main = o.mainSentences.map(squash).filter((x) => x.length >= 12)
  for (const [i, x] of list.entries()) { const q = squash(x?.say); if (q.length >= 12 && main.some((m) => m === q || m.includes(q) || q.includes(m))) e.push(`cold_open[${i}].repeats_main_story`) }
  return e
}
// the finished script against its DNA (deterministic, no AI): DNA valid, eight acts, opening + prop, prop in the reveal,
// the reveal in 80~92% of the main story, a quiet ending, the cold open
export function yasaScriptErrors(script: any, o: { speed?: number; charsPerSecond?: number } = {}): string[] {
  const dna = script?.yasaStoryDNA, sections = Array.isArray(script?.sections) ? script.sections : []
  const e = validateYasaStoryDna(dna, 'longform', { layers: true }).errors.map((x) => `yasa.dna.${x}`)
  if (sections.length !== YASA_ACTS.length) return [...e, `yasa.acts ${sections.length}/${YASA_ACTS.length}`]
  e.push(...checkYasaScript(sections.map((s: any) => textOf(s.sentences)).join(' '), dna).errors.map((x) => `yasa.${x}`))
  if (!hasProp(textOf(sections[YASA_REVEAL_ACT].sentences), dna)) e.push('yasa.reveal: concreteProp not named in the reveal')
  if (LECTURE.test(textOf(sections[YASA_ACTS.length - 1].sentences))) e.push('yasa.lesson: lecture ending')
  const at = yasaRevealAt(sections)
  if (at < YASA_REVEAL_WINDOW.min || at > YASA_REVEAL_WINDOW.max) e.push(`yasa.reveal_at ${Math.round(at * 100)}% (window ${YASA_REVEAL_WINDOW.min * 100}~${YASA_REVEAL_WINDOW.max * 100}%)`)
  const sceneIds = new Set<string>(sections.flatMap((s: any) => (s.scenes ?? []).map((x: any) => String(x.id))))
  e.push(...coldOpenErrors(script?.coldOpen?.sentences, { dna, sceneIds, mainSentences: sections.flatMap((s: any) => s.sentences.map((x: any) => String(x.say || ''))), speed: o.speed ?? YADAM_VOICE.speed, charsPerSecond: o.charsPerSecond ?? 6.2 }))
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
