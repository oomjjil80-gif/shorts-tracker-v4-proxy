// Senior Longform (profile senior_longform): a told STORY for older viewers on the Longform engine (same PLAN checkpoints,
// sentence TTS + timing, cards, loudness, render infrastructure, R2, package). What differs is the "scenes" image mode:
// six acts, each told over a few visual scenes; a new picture only when the place, time, people, key action or a big
// emotional turn changes (never per sentence), all in ONE picture style with a Character Bible so the same person
// always looks the same. Wisdom Longform keeps its one-image mode untouched.
import { composeImagePrompt, type VisualStyleProfile } from './visualStyle.js'
import { LONGFORM, sentencesOf, type LongformScript, type LongformSentence } from './longform.js'

export const SENIOR = {
  acts: 6,
  // the six acts of the story template (adapted to the story, never an explainer)
  actRoles: ['Hook: something goes wrong / a question that hurts', 'The people and their relationship', 'The conflict deepens', 'The decisive event or the reversal', 'The emotional aftermath', 'Closing: what it means for a life, a quiet aftertaste'],
  canvas: { w: 1920, h: 1080 },
  // bottom subtitle cards (the picture is the whole frame)
  text: { x: 960, bottom: 70, maxWidth: 1640, basePx: 78, minPx: 54 }
} as const

export type CharacterBible = { id: string; name: string; role: string; gender: string; age: string; face: string; hair: string; build: string; outfit: string; colors: string }
export type SeniorScene = { id: string; place: string; time: string; characters: string[]; action: string; mood: string; visual: string }
export type SeniorSentence = LongformSentence & { scene: string }
// sections = acts; each act has its scenes and its sentences (every sentence names the scene it is told over)
export type SeniorScript = Omit<LongformScript, 'schema' | 'sections'> & {
  schema: 'senior-longform-script/1'
  characters: CharacterBible[]
  sections: Array<{ id: string; heading: string; scenes: SeniorScene[]; sentences: SeniorSentence[] }>
}

// how many scenes each act gets: ~4-5 for an hour (24-30 pictures), fewer for a short story; a guide, not a gate
export function seniorScenePlan(targetSeconds: number): { acts: number; scenesPerAct: { min: number; max: number }; charsPerAct: number } {
  const min = Math.max(2, Math.min(5, Math.floor(targetSeconds / 900)))
  const totalChars = Math.max(1, Math.round(targetSeconds * LONGFORM.charsPerSecond))
  return { acts: SENIOR.acts, scenesPerAct: { min, max: min + 1 }, charsPerAct: Math.round(totalChars / SENIOR.acts) }
}

const norm = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
const sameScene = (a: SeniorScene, b: SeniorScene) =>
  norm(a.place) === norm(b.place) && norm(a.time) === norm(b.time) && norm(a.action) === norm(b.action) && [...a.characters].sort().join('|') === [...b.characters].sort().join('|')
// A new picture only when something visible changes: two scenes in a row with the same place, time, people and action
// are ONE scene (one picture held longer), however many sentences are told over it.
export function mergeSameScenes(act: { scenes: SeniorScene[]; sentences: SeniorSentence[] }): { scenes: SeniorScene[]; sentences: SeniorSentence[] } {
  const scenes: SeniorScene[] = [], alias = new Map<string, string>()
  for (const sc of act.scenes) {
    const prev = scenes[scenes.length - 1]
    if (prev && sameScene(prev, sc)) { alias.set(sc.id, prev.id); continue }
    scenes.push(sc); alias.set(sc.id, sc.id)
  }
  return { scenes, sentences: act.sentences.map((x) => ({ ...x, scene: alias.get(x.scene) ?? x.scene })) }
}

export function characterLine(c: CharacterBible): string {
  return `${c.name} (${c.role}): ${c.gender}, about ${c.age}, face ${c.face}, hair ${c.hair}, ${c.build} build, wears ${c.outfit}, colors ${c.colors}`
}
export function characterBibleErrors(cs: any): string[] {
  const list = Array.isArray(cs) ? cs : []
  if (!list.length) return ['characters']
  const e: string[] = []
  const ids = new Set<string>()
  for (const [i, c] of list.entries()) {
    for (const k of ['id', 'name', 'role', 'gender', 'age', 'face', 'hair', 'build', 'outfit', 'colors']) if (!String(c?.[k] || '').trim()) e.push(`characters[${i}].${k}`)
    if (ids.has(c?.id)) e.push(`characters[${i}].id.duplicate`)
    ids.add(c?.id)
  }
  return e
}
// the act's own checks: known scene ids, known characters, scenes used in order (a scene once left is not returned to,
// so each picture is one continuous stretch of the video)
export function seniorActErrors(act: any, characterIds: Set<string>): string[] {
  const e: string[] = []
  const scenes: SeniorScene[] = Array.isArray(act?.scenes) ? act.scenes : []
  if (!scenes.length) e.push('scenes')
  const ids = scenes.map((s) => String(s?.id || ''))
  if (new Set(ids).size !== ids.length) e.push('scenes.id.duplicate')
  for (const [i, s] of scenes.entries()) {
    for (const k of ['id', 'place', 'time', 'action', 'visual']) if (!String((s as any)?.[k] || '').trim()) e.push(`scenes[${i}].${k}`)
    for (const c of Array.isArray(s?.characters) ? s.characters : []) if (!characterIds.has(c)) e.push(`scenes[${i}].characters.unknown:${c}`)
  }
  const sents: any[] = Array.isArray(act?.sentences) ? act.sentences : []
  let at = 0
  for (const [j, x] of sents.entries()) {
    const k = ids.indexOf(String(x?.scene || ''))
    if (k < 0) { e.push(`sentences[${j}].scene.unknown`); continue }
    if (k < at) e.push(`sentences[${j}].scene.out_of_order`)
    at = Math.max(at, k)
  }
  const used = new Set(sents.map((x) => String(x?.scene || '')))
  for (const id of ids) if (!used.has(id)) e.push(`scene ${id} has no sentence`)
  return e
}
// every picture of the video, in order (one per scene)
export const seniorScenes = (s: SeniorScript) => s.sections.flatMap((a) => a.scenes)
// sentence k -> its scene, then the time span of each scene from the measured narration timeline
export function sceneRuns(s: SeniorScript, timeline: Array<{ start: number; end: number; k: number }>): Array<{ sceneId: string; start: number; end: number }> {
  const sceneOf = s.sections.flatMap((a) => a.sentences.map((x) => x.scene))
  const runs: Array<{ sceneId: string; start: number; end: number }> = []
  for (const t of timeline) {
    const id = sceneOf[t.k], last = runs[runs.length - 1]
    if (last && last.sceneId === id) last.end = t.end
    else runs.push({ sceneId: id, start: t.start, end: t.end })
  }
  return runs
}
// The scene picture: the scene content + the ONE style + 16:9 story framing + the Character Bible of who is in it.
export function seniorScenePrompt(s: SeniorScript, scene: SeniorScene, style: VisualStyleProfile): string {
  const people = scene.characters.map((id) => s.characters.find((c) => c.id === id)).filter(Boolean).map((c) => characterLine(c!))
  return composeImagePrompt({
    content: `${scene.visual} Place: ${scene.place}. Time: ${scene.time}. Action: ${scene.action}. Mood: ${scene.mood}`,
    style,
    composition: 'Wide 16:9 story frame. Faces and the key action in the upper two thirds; the bottom quarter calm and simple (subtitles are added later).',
    characters: people
  })
}
// gentle motion only (no fast moves, no transitions): slow zoom in, slow pan, or a still picture
export const SCENE_MOTIONS = ['zoom', 'pan-right', 'pan-left', 'still'] as const
export type SceneMotion = (typeof SCENE_MOTIONS)[number]
export const sceneMotion = (i: number): SceneMotion => SCENE_MOTIONS[i % SCENE_MOTIONS.length]
// one picture held for `seconds`: scaled 10% larger than the frame, then a slow crop move (or a 6% zoom over the scene)
export function sceneFilter(input: number, seconds: number, motion: SceneMotion, label: string): string {
  const { w, h } = SENIOR.canvas, W = Math.round(w * 1.1 / 2) * 2, H = Math.round(h * 1.1 / 2) * 2, d = Math.max(0.1, seconds).toFixed(3)
  const base = `[${input}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`
  const move = motion === 'zoom'
    ? `,scale=w='trunc(${w}*(1+0.06*t/${d})/2)*2':h=-2:eval=frame,crop=${w}:${h}`
    : motion === 'pan-right' ? `,crop=${w}:${h}:x='(${W}-${w})*t/${d}':y='(${H}-${h})/2'`
      : motion === 'pan-left' ? `,crop=${w}:${h}:x='(${W}-${w})*(1-t/${d})':y='(${H}-${h})/2'`
        : `,crop=${w}:${h}`
  return `${base}${move},fps=${LONGFORM.fps},format=yuv420p[${label}]`
}
// one encode: every scene picture (looped for its time) -> motion -> concat -> bottom shade -> subtitle cards + narration
export function seniorVideoArgv(o: { images: string[]; runs: Array<{ image: number; seconds: number }>; audio: string; ass: string; fontsDir: string; out: string; seconds: number; threads: number }): string[] {
  const e = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  const { w, h } = SENIOR.canvas
  const inputs = o.runs.flatMap((r) => ['-loop', '1', '-framerate', String(LONGFORM.fps), '-t', r.seconds.toFixed(3), '-i', o.images[r.image]])
  const parts = o.runs.map((r, i) => sceneFilter(i, r.seconds, sceneMotion(i), `s${i}`))
  const shade = `color=c=black:s=${w}x${h},format=rgba,geq=r=0:g=0:b=0:a='clip(210*(Y-${h}*0.62)/(${h}*0.38),0,210)'[sh]`
  const graph = [...parts, shade, `${o.runs.map((_, i) => `[s${i}]`).join('')}concat=n=${o.runs.length}:v=1:a=0,format=rgba[cat]`, `[cat][sh]overlay=0:0,ass=filename='${e(o.ass)}':fontsdir='${e(o.fontsDir)}',format=yuv420p[v]`].join(';')
  return ['-y', ...inputs, '-i', o.audio, '-filter_complex', graph, '-map', '[v]', '-map', `${o.runs.length}:a`, '-t', o.seconds.toFixed(3),
    '-c:v', 'libx264', '-threads:v', String(o.threads), '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(LONGFORM.fps), '-g', String(LONGFORM.fps * 4),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', o.out]
}
export const seniorSentences = (s: SeniorScript) => sentencesOf(s as unknown as LongformScript) as SeniorSentence[]
// outline checks (before any act is written): the Character Bible and every act's scenes
export function seniorOutlineErrors(o: any): string[] {
  const ids = new Set<string>((Array.isArray(o?.characters) ? o.characters : []).map((c: any) => String(c?.id)))
  return [
    ...characterBibleErrors(o?.characters),
    ...(Array.isArray(o?.sections) ? o.sections : []).flatMap((a: any, i: number) => seniorActErrors({ scenes: a?.scenes, sentences: [] }, ids).filter((x) => !/has no sentence/.test(x)).map((x) => `sections[${i}].${x}`))
  ]
}
