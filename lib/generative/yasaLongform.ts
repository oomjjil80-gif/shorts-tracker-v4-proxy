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
import { YADAM_NO_PHOTO, YADAM_STYLE_KEYS, parseVisualStyle, type VisualStyleProfile } from './visualStyle.js'
import { YADAM_AUTO_STYLE } from './creativeProfile.js'
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
export const COLD_OPEN = { seconds: { min: 45, max: 60, target: 52 }, beats: { min: 5, max: 8 }, skipStart: 0.1, prefer: { min: 0.15, max: 0.65 } } as const
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
  const answer = new Set([dna?.reveal?.majorReveal, dna?.reveal?.emotionalReframe, dna?.mystery?.trueMeaning, dna?.aftermath?.firstResolution, dna?.payoff?.externalRewardOrResolution, dna?.payoff?.emotionalReward].flatMap(words))
  const question = new Set([dna?.mystery?.strangeAction, dna?.mystery?.concreteProp, dna?.mystery?.apparentMeaning, dna?.mystery?.mainQuestion, dna?.mystery?.secondaryQuestion, dna?.openingLine, dna?.title, dna?.reveal?.majorCrisis, dna?.reveal?.partialProof, dna?.pressure?.immediateLoss, dna?.pressure?.antagonistOrPressure, ...(dna?.pressure?.worseningEvents ?? []), dna?.setting?.region, dna?.setting?.era, ...Object.values(dna?.hero ?? {})].flatMap(words))
  return [...answer].filter((w) => !question.has(w) && [...w].length >= 2)
}
// Which main-story pictures the cold open may use. Its job is the most intriguing middle of the story, never the very
// start (the main story begins there anyway: told twice back to back) and never the answer:
//   - never a scene first shown in the first 10% of the main story narration (COLD_OPEN.skipStart)
//   - never a scene of the reveal act or after (majorReveal / trueMeaning / firstResolution / layers / reframe / payoff)
//   - preferred: scenes first shown between 15% and 65% (the strange act, the pressure, the proof, the crisis)
export function coldOpenCandidates(sections: Array<{ scenes?: any[]; sentences: any[] }>): { allowed: Set<string>; preferred: Set<string>; list: Array<{ id: string; at: number; act: number; preferred: boolean }> } {
  const total = sections.reduce((a, s) => a + charsOf(textOf(s.sentences)), 0) || 1
  const first = new Map<string, { at: number; act: number }>()
  let pos = 0
  for (const [act, s] of sections.entries()) for (const x of Array.isArray(s.sentences) ? s.sentences : []) {
    const id = String(x?.scene || ''); if (id && !first.has(id)) first.set(id, { at: pos / total, act })
    pos += charsOf(String(x?.say || ''))
  }
  const list = [...first.entries()].filter(([, v]) => v.at >= COLD_OPEN.skipStart && v.act < YASA_REVEAL_ACT)
    .map(([id, v]) => ({ id, at: Number(v.at.toFixed(3)), act: v.act, preferred: v.at >= COLD_OPEN.prefer.min && v.at <= COLD_OPEN.prefer.max }))
  return { allowed: new Set(list.map((x) => x.id)), preferred: new Set(list.filter((x) => x.preferred).map((x) => x.id)), list }
}
// near repeat: the same event told in almost the same words (character bigram overlap of the two sentences, no AI)
const bigrams = (t: string) => { const c = [...t], m = new Map<string, number>(); for (let i = 0; i + 1 < c.length; i++) { const b = c[i] + c[i + 1]; m.set(b, (m.get(b) ?? 0) + 1) } return m }
export function nearSame(a: string, b: string): number {
  const x = bigrams(squash(a)), y = bigrams(squash(b)); let both = 0, n = 0
  for (const [k, v] of x) { n += v; both += Math.min(v, y.get(k) ?? 0) }
  for (const v of y.values()) n += v
  return n ? (2 * both) / n : 0
}
export const NEAR_REPEAT = 0.6
// the cold open, before it is stored: 5~8 beats, 45~60 s at the voice's speed, no background start, the prop, a beat change
// on every sentence, only main-story pictures, never the answer, never a main-story sentence repeated
export function coldOpenErrors(sentences: any[], o: { dna: any; sceneIds: Set<string>; mainSentences: string[]; speed: number; charsPerSecond: number; candidates?: ReturnType<typeof coldOpenCandidates>; avoidScenes?: Set<string> }): string[] {
  const list = Array.isArray(sentences) ? sentences : [], e: string[] = [], t = textOf(list)
  if (list.length < COLD_OPEN.beats.min || list.length > COLD_OPEN.beats.max) e.push(`cold_open.beats ${list.length} (${COLD_OPEN.beats.min}~${COLD_OPEN.beats.max})`)
  const seconds = [...t].length / (o.charsPerSecond * o.speed)
  if (seconds < COLD_OPEN.seconds.min || seconds > COLD_OPEN.seconds.max) e.push(`cold_open.length about ${seconds.toFixed(1)}s (${COLD_OPEN.seconds.min}~${COLD_OPEN.seconds.max}s; aim for ${COLD_OPEN.seconds.target}s)`)
  e.push(...checkYasaScript(t, o.dna).errors.map((x) => `cold_open.${x}`))
  for (const [i, x] of list.entries()) {
    if (!o.sceneIds.has(String(x?.scene || ''))) e.push(`cold_open[${i}].scene: must be one of the main story's scenes`)
    if (i && String(x?.scene) === String(list[i - 1]?.scene)) e.push(`cold_open[${i}].scene: every beat shows a different picture`)
    if (o.avoidScenes?.has(String(x?.scene || ''))) e.push(`cold_open[${i}].scene ${String(x?.scene)}: rejected before (it led to the answer); pick another middle scene`)
    if (o.candidates && o.sceneIds.has(String(x?.scene || '')) && !o.candidates.allowed.has(String(x?.scene || ''))) e.push(`cold_open[${i}].scene ${String(x?.scene)}: not from the first 10% of the story nor from the reveal / ending`)
  }
  // most beats from the middle of the story (15~65%) when it has enough pictures there
  if (o.candidates && o.candidates.preferred.size >= 2) {
    const mid = list.filter((x) => o.candidates!.preferred.has(String(x?.scene || ''))).length
    if (mid < Math.ceil(list.length / 2)) e.push(`cold_open.middle ${mid}/${list.length}: most beats come from the story's 15~65% scenes`)
  }
  const leak = revealWords(o.dna).filter((w) => t.includes(w))
  if (leak.length) e.push(`cold_open.reveals_answer: ${leak.slice(0, 5).join(', ')}`)
  const main = o.mainSentences.map(squash).filter((x) => x.length >= 12)
  for (const [i, x] of list.entries()) {
    const q = squash(x?.say)
    if (q.length >= 12 && main.some((m) => m === q || m.includes(q) || q.includes(m))) e.push(`cold_open[${i}].repeats_main_story`)
    else if (q.length >= 12 && o.mainSentences.some((m) => squash(m).length >= 12 && nearSame(String(x?.say || ''), m) >= NEAR_REPEAT)) e.push(`cold_open[${i}].near_repeats_main_story`)
  }
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
  e.push(...coldOpenErrors(script?.coldOpen?.sentences, { dna, sceneIds, mainSentences: sections.flatMap((s: any) => s.sentences.map((x: any) => String(x.say || ''))), speed: o.speed ?? YADAM_VOICE.speed, charsPerSecond: o.charsPerSecond ?? 6.2, candidates: coldOpenCandidates(sections) }))
  return e
}

// 조선 고증 LOCK: whatever 그림체 is chosen, a Korean story keeps Korea / Joseon in every picture (style != country)
export const JOSEON_LOCK = 'Korea, Joseon dynasty: Joseon hanbok, gat (horsehair hats), sangtu topknots, Joseon women\'s hairstyles (braids, chignon with binyeo), Joseon soldiers\' uniforms, hanok, thatched-roof choga houses, tiled giwa houses, jangdokdae crock terraces, Joseon everyday tools, Joseon village and street layout'
export const JOSEON_FORBIDDEN = 'Chinese-style costumes, Qing queue hairstyle, Chinese official robes, Chinese palace architecture, Japanese kimono, Japanese chonmage topknot, torii gates, Japanese architecture'
const KOREAN_SETTING = /조선|한국|고려|신라|백제|한양|korea|joseon|goryeo/i
export const isKoreanSetting = (set: any) => { const t = `${set?.region || ''} ${set?.era || ''}`.trim(); return !t || KOREAN_SETTING.test(t) }

// the scene picture, always in this order: 1 the scene, 2 the country/era LOCK, 3 the Character Bible, 4 the chosen
// 그림체, 5 what never appears (style negatives + another country/era + never a photo)
export function yasaScenePrompt(s: SeniorScript & { yasaStoryDNA?: any }, scene: SeniorScene, style: VisualStyleProfile): string {
  const dna = s.yasaStoryDNA ?? {}, set = dna.setting ?? {}, prop = String(dna.mystery?.concreteProp || '').trim()
  const people = scene.characters.map((id) => s.characters.find((c) => c.id === id)).filter(Boolean).map((c) => characterLine(c!))
  const showsProp = prop && hasProp(`${scene.visual} ${scene.action}`, dna)
  const korean = isKoreanSetting(set)
  return [
    `Content: ${scene.visual} Place: ${scene.place}. Time: ${scene.time}. Action: ${scene.action}. Mood: ${scene.mood}${showsProp ? `. The key object "${prop}" looks exactly the same in every picture` : ''}.`,
    `Country and era (locked, the style never changes this): ${set.region || ''}, ${set.era || ''}${set.culturalNotes ? ` (${set.culturalNotes})` : ''} — clothing, hairstyles, architecture and objects belong to exactly this place and time${korean ? `; ${JOSEON_LOCK}` : ''}.`,
    ...(people.length ? [`Characters (keep exactly this look in every picture — face, age, hair, clothing colors and shape, build, key props): ${people.join(' | ')}.`] : []),
    `Style: ${style.promptPrefix}.`,
    `Composition: Wide 16:9 story frame. Faces and the key action in the upper two thirds; the bottom quarter calm and simple (subtitles are added later). ${style.compositionHints}.`,
    `Avoid: ${[style.negativePrompt, 'modern objects, costumes or buildings of another country or era', korean ? JOSEON_FORBIDDEN : '', YADAM_NO_PHOTO].filter(Boolean).join(', ')}.`
  ].join(' ')
}

// 숨은야담 REMASTER brief: the source job's brief (its story, length and voice: the main narration's TTS is reused from
// the cache because voice + text stay the same) with the new 그림체 and the link to the source job and its script.
// The source job and its files are never changed.
export function yadamRemasterBrief(source: any, o: { sourceJobId: string; scriptRef: string; visualStyleProfile?: unknown }): any {
  if (!source || source.schema !== 'generative-brief/1' || source.profile !== 'yasa_longform' || !source.creative?.resolved) throw new Error('the source job has no 숨은야담 brief')
  const style = parseVisualStyle(o.visualStyleProfile ?? 'auto')
  if (style !== 'auto' && !(YADAM_STYLE_KEYS as readonly string[]).includes(style)) throw new Error(`visualStyleProfile must be auto or one of ${YADAM_STYLE_KEYS.join(', ')}`)
  const resolvedStyle = style === 'auto' ? YADAM_AUTO_STYLE : style
  const c = source.creative
  return { ...source, creative: { ...c, requested: { ...c.requested, visualStyleProfile: style }, resolved: { ...c.resolved, visualStyleProfile: resolvedStyle } }, remaster: { sourceJobId: o.sourceJobId, parentJobId: o.sourceJobId, scriptRef: o.scriptRef } }
}

// What earlier cold-open attempts were rejected for, so the next attempt cannot make the same mistake (generic: any
// profile whose cold open is checked by coldOpenErrors). From every rejected attempt (kept across stage retries):
//   terms     the answer words it leaked ("cold_open.reveals_answer: …"), never to be used again
//   sentences what it said (never to be reused or lightly reworded)
//   scenes    the pictures of the beats that carried a leaked term
//   avoidScenes  those scenes once the SAME term leaked twice: then the scene itself is replaced, not just the wording
export type ColdOpenAttempt = { errors: string[]; sentences?: Array<{ scene?: string; say?: string }> }
export function coldOpenRejections(history: ColdOpenAttempt[] | null | undefined, o: { allowed?: Set<string>; keepAtLeast?: number } = {}) {
  const list = Array.isArray(history) ? history : []
  const termCount = new Map<string, number>(), sentences: string[] = [], scenes = new Set<string>(), repeatScenes = new Set<string>()
  const leaksOf = (a: ColdOpenAttempt) => (a.errors ?? []).flatMap((x) => { const m = /cold_open\.reveals_answer:\s*(.+)$/.exec(String(x)); return m ? m[1].split(',').map((w) => w.trim()).filter(Boolean) : [] })
  for (const a of list) for (const t of new Set(leaksOf(a))) termCount.set(t, (termCount.get(t) ?? 0) + 1)
  const repeated = new Set([...termCount].filter(([, n]) => n >= 2).map(([t]) => t))
  for (const a of list) {
    const leaks = leaksOf(a)
    for (const b of a.sentences ?? []) {
      const say = String(b?.say || '').trim(); if (say && !sentences.includes(say)) sentences.push(say)
      const hit = leaks.filter((t) => say.includes(t))
      if (hit.length && b?.scene) { scenes.add(String(b.scene)); if (hit.some((t) => repeated.has(t))) repeatScenes.add(String(b.scene)) }
    }
  }
  // never narrow the choice below what a cold open needs (then the wording rules alone apply)
  const left = o.allowed ? [...o.allowed].filter((x) => !repeatScenes.has(x)).length : Infinity
  const avoidScenes = left >= (o.keepAtLeast ?? 3) ? repeatScenes : new Set<string>()
  return { terms: [...termCount.keys()], repeatedTerms: [...repeated], sentences: sentences.slice(-24), scenes: [...scenes], avoidScenes }
}
