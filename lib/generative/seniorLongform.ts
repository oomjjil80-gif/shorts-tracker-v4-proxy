// Senior Longform (profile senior_longform): a told STORY for older viewers on the Longform engine (same PLAN checkpoints,
// sentence TTS + timing, cards, loudness, render infrastructure, R2, package). What differs is the "scenes" image mode:
// six acts, each told over a few visual scenes; a new picture only when the place, time, people, key action or a big
// emotional turn changes (never per sentence), all in ONE picture style with a Character Bible so the same person
// always looks the same. Wisdom Longform keeps its one-image mode untouched.
import { composeImagePrompt, type VisualStyleProfile } from './visualStyle.js'
import { LONGFORM, sentencesOf, type LongformScript, type LongformSentence } from './longform.js'
import { estimateUsd, runSpentUsd } from './usageLedger.js'

export const SENIOR = {
  acts: 6,
  // the six acts of the story template (adapted to the story, never an explainer)
  // hook -> conflict -> crisis -> reversal -> emotional reward -> an ending that lingers
  actRoles: ['Hook: a strong event or an emotional question within the first 30 seconds (no greeting, no background first)', 'Conflict: the people, what they want and what stands between them', 'Crisis: the conflict deepens to the worst moment', 'Reversal: the decisive event that turns the story', 'Emotional reward: what the reversal gives back (reconciliation, truth, gratitude)', 'Ending: a quiet aftertaste that stays with the viewer'],
  // PACING: how long one picture stays on screen (narration told over it). A new picture only for a real visible change
  // (expression, action, place, viewpoint); never more than maxHold seconds, never a split just to add pictures.
  pace: { hookSeconds: 30, targetMin: 20, targetMax: 30, maxHold: 30 },
  // the shot of a scene picture (the image prompt; motion is the renderer's own zoom / pan cycle)
  shots: ['close-up', 'medium', 'wide', 'over-the-shoulder', 'low-angle', 'high-angle'],
  canvas: { w: 1920, h: 1080 },
  // bottom subtitle cards (the picture is the whole frame)
  text: { x: 960, bottom: 70, maxWidth: 1640, basePx: 78, minPx: 54 }
} as const

export type CharacterBible = { id: string; name: string; role: string; gender: string; age: string; face: string; hair: string; build: string; outfit: string; colors: string }
export type SeniorScene = { id: string; place: string; time: string; characters: string[]; action: string; mood: string; visual: string; shot?: string }
export type SeniorSentence = LongformSentence & { scene: string }
// sections = acts; each act has its scenes and its sentences (every sentence names the scene it is told over)
export type SeniorScript = Omit<LongformScript, 'schema' | 'sections'> & {
  schema: 'senior-longform-script/1'
  characters: CharacterBible[]
  sections: Array<{ id: string; heading: string; scenes: SeniorScene[]; sentences: SeniorSentence[] }>
}

// how many scenes each act gets, from the PACING: one picture per targetMax..targetMin (30..20 s) of narration —
// e.g. 45 min: 15-23 per act (90-138 pictures). A guide for the planner; the 30 s hold is checked.
export function seniorScenePlan(targetSeconds: number): { acts: number; scenesPerAct: { min: number; max: number }; charsPerAct: number } {
  const act = Math.max(1, targetSeconds) / SENIOR.acts, { targetMin, targetMax } = SENIOR.pace
  const min = Math.max(2, Math.ceil(act / targetMax)), max = Math.max(min + 1, Math.ceil(act / targetMin))
  const totalChars = Math.max(1, Math.round(targetSeconds * LONGFORM.charsPerSecond))
  return { acts: SENIOR.acts, scenesPerAct: { min, max }, charsPerAct: Math.round(totalChars / SENIOR.acts) }
}
// narration seconds of a text at the voice's speed (the same estimate that sizes the script)
const secondsOf = (chars: number, speed = 1) => chars / (LONGFORM.charsPerSecond * (speed || 1))
// PACING CHECK of one act (Senior only): every scene's estimated time on screen; a picture held over maxHold is an error
// the act is written again for (split it at a real visible change, or tell less over it)
export function seniorPacingErrors(act: { scenes: SeniorScene[]; sentences: SeniorSentence[] }, speed = 1): string[] {
  const chars = new Map<string, number>()
  for (const x of act.sentences ?? []) chars.set(x.scene, (chars.get(x.scene) ?? 0) + [...String(x.say || '')].length)
  return (act.scenes ?? []).flatMap((sc) => { const t = secondsOf(chars.get(sc.id) ?? 0, speed); return t > SENIOR.pace.maxHold ? [`pacing.scene_too_long:${sc.id}:${Math.round(t)}s (at most ${SENIOR.pace.maxHold} s per picture: split it where the expression, action, place or viewpoint really changes, or tell less over it)`] : [] })
}
// the same picture twice: two scenes anywhere in the video that would draw the same thing (same place, people, action
// and visual) — one of them must show something else (outline check, Senior only)
const sceneSig = (sc: SeniorScene) => [norm(sc.place), [...(sc.characters ?? [])].sort().join('|'), norm(sc.action), norm(sc.visual)].join('#')
export function seniorRepeatErrors(o: any): string[] {
  const seen = new Map<string, string>(), e: string[] = []
  let prev = ''
  for (const a of Array.isArray(o?.sections) ? o.sections : []) for (const sc of Array.isArray(a?.scenes) ? a.scenes : []) {
    const k = sceneSig(sc), first = seen.get(k), back = k === prev; prev = k
    if (back) continue // the same scene twice in a row is ONE picture (mergeSameScenes), not a repeat
    if (first) e.push(`pacing.repeated_picture:${sc.id}=${first} (the same place, people, action and picture; show a new expression, action or viewpoint)`); else seen.set(k, sc.id)
  }
  return e
}
// ---- COST (Senior only): what the pictures and the narration of this script will cost, before ASSET pays for any ----
// one 16:9 1K Gemini picture incl. its reference-image input (measured ~$0.068 on a real job), rounded up
export const SENIOR_COST = { imageUsd: 0.07 } as const
export const ttsUsdOf = (chars: number) => estimateUsd({ api: 'speech', model: 'gpt-4o-mini-tts', inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, images: 0, ttsChars: Math.max(0, chars) }) ?? 0
const usd = (x: number) => Number(x.toFixed(4))
export function seniorCostEstimate(o: { pictures: number; extraPictures?: number; narrationChars: number; spentUsd?: number; budgetUsd?: number }) {
  const images = o.pictures + (o.extraPictures ?? 0), imageUsd = images * SENIOR_COST.imageUsd, ttsUsd = ttsUsdOf(o.narrationChars)
  const assetUsd = imageUsd + ttsUsd, spent = o.spentUsd ?? 0, total = spent + assetUsd
  return { images, imageUsd: usd(imageUsd), ttsUsd: usd(ttsUsd), assetUsd: usd(assetUsd), spentUsd: usd(spent), totalUsd: usd(total), ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd, fits: total <= o.budgetUsd } : {}) }
}
// BUDGET GUARD of one ASSET run: every paid call RESERVES its price first; a call that would take the job over its budget
// is never sent (the stage stops and the job waits for a bigger budget; everything made so far is stored and reused)
export function budgetGuard(o: { budgetUsd: number; spentBefore: number }) {
  let inflight = 0
  const spent = () => o.spentBefore + runSpentUsd()
  return {
    spent: () => usd(spent()),
    // true = paid for (call `done` after the call); false = over budget, do not call
    take(cost: number) { if (spent() + inflight + cost > o.budgetUsd + 1e-9) return false; inflight += cost; return true },
    done(cost: number) { inflight = Math.max(0, inflight - cost) }
  }
}
// the measured-in-advance pacing of a whole script (stored with the PLAN result; RENDER reports the real one)
export function seniorPacing(s: SeniorScript, speed = 1) {
  const all = s.sections.flatMap((a) => a.scenes.map((sc) => secondsOf(a.sentences.filter((x) => x.scene === sc.id).reduce((n, x) => n + [...String(x.say || '')].length, 0), speed)))
  const sents = s.sections.flatMap((a) => a.sentences), hook = norm(s.hook).replace(/[^가-힣a-z0-9]/g, '')
  let at = 0, hookAt: number | null = null
  for (const x of sents) { at += secondsOf([...String(x.say || '')].length, speed); if (hook && norm(x.say).replace(/[^가-힣a-z0-9]/g, '').includes(hook.slice(0, Math.min(12, hook.length)))) { hookAt = Number(at.toFixed(1)); break } }
  const r = (x: number) => Number(x.toFixed(1))
  return { pictures: all.length, avgSeconds: r(all.reduce((a, b) => a + b, 0) / Math.max(1, all.length)), minSeconds: r(Math.min(...all)), maxSeconds: r(Math.max(...all)), inTarget: all.filter((t) => t >= SENIOR.pace.targetMin && t <= SENIOR.pace.targetMax).length, overMaxHold: all.filter((t) => t > SENIOR.pace.maxHold).length, hookBy: hookAt, repeated: seniorRepeatErrors(s).length }
}
// the real pacing from the rendered runs (seconds each picture was on screen)
export function runPacing(runs: Array<{ image: number; seconds: number }>) {
  const r = (x: number) => Number(x.toFixed(1)), t = runs.map((x) => x.seconds)
  return { runs: runs.length, avgSeconds: r(t.reduce((a, b) => a + b, 0) / Math.max(1, t.length)), maxSeconds: r(Math.max(0, ...t)), overMaxHold: t.filter((x) => x > SENIOR.pace.maxHold).length, sameImageBackToBack: runs.filter((x, i) => i > 0 && runs[i - 1].image === x.image).length }
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
// (숨은야담: the cold open's sentences come first and are their own runs, marked `cold`, never merged into the story's)
export function sceneRuns(s: SeniorScript, timeline: Array<{ start: number; end: number; k: number }>): Array<{ sceneId: string; start: number; end: number; cold?: true }> {
  const cold: string[] = ((s as any).coldOpen?.sentences ?? []).map((x: any) => x.scene)
  const sceneOf = [...cold, ...s.sections.flatMap((a) => a.sentences.map((x) => x.scene))]
  const runs: Array<{ sceneId: string; start: number; end: number; cold?: true }> = []
  for (const t of timeline) {
    const id = sceneOf[t.k], isCold = t.k < cold.length, last = runs[runs.length - 1]
    if (last && last.sceneId === id && !!last.cold === isCold) last.end = t.end
    else runs.push({ sceneId: id, start: t.start, end: t.end, ...(isCold ? { cold: true as const } : {}) })
  }
  return runs
}
// The scene picture: the scene content + the ONE style + 16:9 story framing + the Character Bible of who is in it.
export function seniorScenePrompt(s: SeniorScript, scene: SeniorScene, style: VisualStyleProfile): string {
  const people = scene.characters.map((id) => s.characters.find((c) => c.id === id)).filter(Boolean).map((c) => characterLine(c!))
  return composeImagePrompt({
    content: `${scene.visual} Place: ${scene.place}. Time: ${scene.time}. Action: ${scene.action}. Mood: ${scene.mood}`,
    style,
    composition: `${scene.shot ? `${SHOT_LINE[scene.shot] ?? `Shot: ${scene.shot}.`} ` : ''}16:9 story frame. Faces and the key action in the upper two thirds; the bottom quarter calm and simple (subtitles are added later).`,
    characters: people
  })
}
const SHOT_LINE: Record<string, string> = {
  'close-up': 'Close-up shot: the face and its expression fill the frame.', medium: 'Medium shot: the people from the waist up and what they are doing.',
  wide: 'Wide shot: the whole place and the people in it.', 'over-the-shoulder': 'Over-the-shoulder shot: from behind one person toward the other.',
  'low-angle': 'Low-angle shot: looking up at the person.', 'high-angle': 'High-angle shot: looking down at the person.'
}
// gentle motion only (no fast moves, no transitions): slow zoom in, slow pan, or a still picture
export const SCENE_MOTIONS = ['zoom', 'pan-right', 'pan-left', 'still'] as const
export type SceneMotion = (typeof SCENE_MOTIONS)[number]
export const sceneMotion = (i: number): SceneMotion => SCENE_MOTIONS[i % SCENE_MOTIONS.length]
// 숨은야담 cold open: livelier cuts over the same pictures (always moving: a stronger push-in or a wider pan, never still)
export const COLD_MOTIONS = ['zoom', 'pan-left', 'pan-right'] as const
export const coldMotion = (i: number): SceneMotion => COLD_MOTIONS[i % COLD_MOTIONS.length]
// one picture held for `seconds`: scaled larger than the frame (10%; `strong` 24%), then a crop move (or a zoom of 6%;
// `strong` 16%) over the scene
export function sceneFilter(input: number, seconds: number, motion: SceneMotion, label: string, strong = false): string {
  const k = strong ? 1.24 : 1.1, z = strong ? 0.16 : 0.06
  const { w, h } = SENIOR.canvas, W = Math.round(w * k / 2) * 2, H = Math.round(h * k / 2) * 2, d = Math.max(0.1, seconds).toFixed(3)
  const base = `[${input}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`
  const move = motion === 'zoom'
    ? `,scale=w='trunc(${w}*(1+${z}*t/${d})/2)*2':h=-2:eval=frame,crop=${w}:${h}`
    : motion === 'pan-right' ? `,crop=${w}:${h}:x='(${W}-${w})*t/${d}':y='(${H}-${h})/2'`
      : motion === 'pan-left' ? `,crop=${w}:${h}:x='(${W}-${w})*(1-t/${d})':y='(${H}-${h})/2'`
        : `,crop=${w}:${h}`
  return `${base}${move}${strong ? ',setsar=1' : ''},fps=${LONGFORM.fps},format=yuv420p[${label}]`
}
// one encode: every scene picture (looped for its time) -> motion -> concat -> bottom shade -> subtitle cards + narration
export function seniorVideoArgv(o: { images: string[]; runs: Array<{ image: number; seconds: number; cold?: boolean }>; audio: string; ass: string; fontsDir: string; out: string; seconds: number; threads: number }): string[] {
  const e = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  const { w, h } = SENIOR.canvas
  const inputs = o.runs.flatMap((r) => ['-loop', '1', '-framerate', String(LONGFORM.fps), '-t', r.seconds.toFixed(3), '-i', o.images[r.image]])
  const parts = o.runs.map((r, i) => (r.cold ? sceneFilter(i, r.seconds, coldMotion(i), `s${i}`, true) : sceneFilter(i, r.seconds, sceneMotion(i), `s${i}`)))
  const shade = `color=c=black:s=${w}x${h},format=rgba,geq=r=0:g=0:b=0:a='clip(210*(Y-${h}*0.62)/(${h}*0.38),0,210)'[sh]`
  const graph = [...parts, shade, `${o.runs.map((_, i) => `[s${i}]`).join('')}concat=n=${o.runs.length}:v=1:a=0,format=rgba[cat]`, `[cat][sh]overlay=0:0,ass=filename='${e(o.ass)}':fontsdir='${e(o.fontsDir)}',format=yuv420p[v]`].join(';')
  return ['-y', ...inputs, '-i', o.audio, '-filter_complex', graph, '-map', '[v]', '-map', `${o.runs.length}:a`, '-t', o.seconds.toFixed(3),
    '-c:v', 'libx264', '-threads:v', String(o.threads), '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(LONGFORM.fps), '-g', String(LONGFORM.fps * 4),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', o.out]
}
// ---------------- CHUNKED RENDER (scene longforms: Senior / 숨은야담) ----------------
// One ffmpeg process for a whole 45~120 minute video held every scene picture in one filter graph and ran out of the
// worker's 1 GB (SIGKILL). The video is now made in SEGMENTS cut at scene boundaries (never inside a sentence; the cold
// open stays in the first one), each holding at most RENDER_SEGMENT.maxRuns pictures and maxSeconds of video, so a
// longer video means MORE segments, never a bigger process. Segments are video only, frame-exact, encoded with the same
// settings; the final file is a stream copy of the segments plus the narration track as it is (no re-encode).
export const RENDER_SEGMENT = { maxRuns: 8, maxSeconds: 360 } as const
export const SEGMENT_ENCODER = 'libx264-veryfast-crf20-yuv420p-gop120-v1'
// scene runs -> segments [from, to) of run indices
export function planSegments(runs: Array<{ seconds: number; cold?: boolean }>, o: { maxRuns: number; maxSeconds: number } = RENDER_SEGMENT): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = []
  let from = 0, n = 0, sec = 0
  for (const [i, r] of runs.entries()) {
    // a cold-open beat never starts a new segment: the whole cold open is in the first one
    if (n > 0 && !r.cold && (n + 1 > o.maxRuns || sec + r.seconds > o.maxSeconds)) { out.push({ from, to: i }); from = i; n = 0; sec = 0 }
    n++; sec += r.seconds
  }
  if (n) out.push({ from, to: runs.length })
  return out
}
// frame-exact run lengths: cumulative rounding, so the frames of all runs add up to round(total * fps) (no drift)
export function runFrames(starts: number[], total: number, fps: number = LONGFORM.fps): number[] {
  const edge = [...starts.map((x) => Math.round(x * fps)), Math.round(total * fps)]
  return starts.map((_, i) => Math.max(1, edge[i + 1] - edge[i]))
}
// one segment: its own pictures only, the same motion each run had in the single-graph render (by its index in the
// whole video), bottom shade + its own subtitle cards, video only, exactly `frames` frames
export function sceneSegmentArgv(o: { images: string[]; runs: Array<{ image: number; frames: number; index: number; cold?: boolean }>; ass: string; fontsDir: string; out: string; threads: number }): string[] {
  const e = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  const { w, h } = SENIOR.canvas, fps = LONGFORM.fps
  const sec = (f: number) => (f / fps).toFixed(3)
  const inputs = o.runs.flatMap((r) => ['-loop', '1', '-framerate', String(fps), '-t', sec(r.frames), '-i', o.images[r.image]])
  const parts = o.runs.map((r, i) => (r.cold ? sceneFilter(i, r.frames / fps, coldMotion(r.index), `s${i}`, true) : sceneFilter(i, r.frames / fps, sceneMotion(r.index), `s${i}`)))
  const shade = `color=c=black:s=${w}x${h},format=rgba,geq=r=0:g=0:b=0:a='clip(210*(Y-${h}*0.62)/(${h}*0.38),0,210)'[sh]`
  const graph = [...parts, shade, `${o.runs.map((_, i) => `[s${i}]`).join('')}concat=n=${o.runs.length}:v=1:a=0,format=rgba[cat]`, `[cat][sh]overlay=0:0,ass=filename='${e(o.ass)}':fontsdir='${e(o.fontsDir)}',format=yuv420p[v]`].join(';')
  const frames = o.runs.reduce((a, r) => a + r.frames, 0)
  return ['-y', ...inputs, '-filter_complex', graph, '-map', '[v]', '-frames:v', String(frames), '-an',
    '-c:v', 'libx264', '-threads:v', String(o.threads), '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 4), o.out]
}
// the final MP4: the segments back to back (stream copy) + the narration as it is (stream copy); nothing re-encoded
export function segmentConcatArgv(o: { list: string; audio: string; out: string; seconds: number }): string[] {
  return ['-y', '-f', 'concat', '-safe', '0', '-i', o.list, '-i', o.audio, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-t', o.seconds.toFixed(3), '-movflags', '+faststart', o.out]
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
