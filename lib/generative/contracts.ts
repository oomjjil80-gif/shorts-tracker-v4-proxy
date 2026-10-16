import { createHash } from 'node:crypto'
import { canonicalize } from '../tracker-core/renderManifest.js'
import { resolveCreativeProfile, type CreativeProfile } from './creativeProfile.js'

export type GenerativeInputKind = 'topic' | 'text'
export type GenerativeBrief = {
  schema: 'generative-brief/1'
  profile: 'wisdom' | 'yasa_shorts'
  kind: GenerativeInputKind
  text: string
  language: 'ko'
  aspectRatio: '9:16'
  targetSeconds: number
  creative?: CreativeProfile
  thumbnailFirst?: boolean
  firstFrameStyle?: 'miniature' | 'animation' | 'watercolor' | 'ink'
  // a user-confirmed script (history/yasa Reels): PLAN uses it verbatim — no rewrite, no AI plan, no semantic QC
  fixedScript?: FixedScript
  // a Short derived from a Wisdom Longform (set by job_create from the parent's stored recommendation)
  derivedFrom?: { parentLongformJobId: string; parentLongformTitle: string; parentLongformUrl: string | null; candidateId: string; shortTitle: string; hook: string; corePoint: string; payoff: string; sourceClaim: string; sourceRefs: Array<{ section: number; sentence: number }> }
}
export type FixedScript = { title: string; stylePrefix: string; beats: Array<{ narration: string; imagePrompt: string; visualGoal: string; durationSec: number }> }
export function normalizeFixedScript(input: any): FixedScript {
  const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim()
  const title = clean(input?.title), beats = Array.isArray(input?.beats) ? input.beats : []
  if (title.length < 2 || title.length > 80) throw new Error('fixedScript.title must be 2..80 characters')
  if (beats.length < 5 || beats.length > 12) throw new Error('fixedScript.beats must be 5..12 scenes')
  const stylePrefix = clean(input?.stylePrefix).slice(0, 600)
  return {
    title, stylePrefix,
    beats: beats.map((b: any, i: number) => {
      const narration = clean(b?.narration), imagePrompt = clean(b?.imagePrompt)
      if (!narration || narration.length > 90) throw new Error(`fixedScript.beats[${i}].narration must be 1..90 characters`)
      if (imagePrompt.length < 8 || imagePrompt.length > 1500) throw new Error(`fixedScript.beats[${i}].imagePrompt must be 8..1500 characters`)
      const given = Number(b?.durationSec), durationSec = Number.isFinite(given) && given > 0 ? given : Number(Math.max(3, Math.min(12, narration.length / 6.2)).toFixed(1))
      if (durationSec < 3 || durationSec > 12) throw new Error(`fixedScript.beats[${i}].durationSec must be 3..12`)
      return { narration, imagePrompt, visualGoal: clean(b?.visualGoal) || narration.slice(0, 80), durationSec }
    })
  }
}
export type WisdomProfile = {
  schema: 'generative-profile/1'
  id: 'wisdom'
  version: 1
  aspectRatio: '9:16'
  targetSeconds: { min: number; max: number }
  visualContinuity: 'low'
  narration: { tone: 'calm_clear'; maxCharsPerBeat: number }
}
export const WISDOM_PROFILE: WisdomProfile = {
  schema:'generative-profile/1', id:'wisdom', version:1, aspectRatio:'9:16',
  targetSeconds:{min:35,max:75}, visualContinuity:'low',
  narration:{tone:'calm_clear',maxCharsPerBeat:90}
}
export function normalizeGenerativeBrief(input:any, profile:'wisdom'|'yasa_shorts'='wisdom'): GenerativeBrief {
  const fixedScript=input?.fixedScript?normalizeFixedScript(input.fixedScript):undefined
  const kind=(fixedScript?'text':String(input?.kind||'')) as GenerativeInputKind
  if(kind!=='topic'&&kind!=='text') throw new Error('input.kind must be topic or text')
  const text=(fixedScript&&!String(input?.text||'').trim()?`${fixedScript.title}. ${fixedScript.beats.map(b=>b.narration).join(' ')}`:String(input?.text||'')).replace(/\s+/g,' ').trim()
  if(text.length<4||text.length>12000) throw new Error('input.text must be 4..12000 characters')
  const targetSeconds=Number(input?.targetSeconds??55)
  if(!Number.isFinite(targetSeconds)||targetSeconds<35||targetSeconds>75) throw new Error('targetSeconds must be 35..75 for wisdom')
  // Creative Settings (voice/tone/speed/picture style): AUTO keeps the Wisdom Shorts house voice and its own style
  const creative=resolveCreativeProfile(profile,input,text)
  const thumbnailFirst = profile === 'yasa_shorts' && input?.thumbnailFirst === true
  const selectedStyle = input?.firstFrameStyle ?? 'miniature'
  if (thumbnailFirst && !['miniature','animation','watercolor','ink'].includes(selectedStyle)) throw new Error('firstFrameStyle must be miniature, animation, watercolor or ink')
  const firstFrameStyle = thumbnailFirst ? selectedStyle : undefined
  return {schema:'generative-brief/1',profile,kind,text,language:'ko',aspectRatio:'9:16',targetSeconds,creative,...(thumbnailFirst?{thumbnailFirst,firstFrameStyle}:{}),...(fixedScript?{fixedScript}:{})}
}
export function generativeBriefHash(b:GenerativeBrief){return createHash('sha256').update(canonicalize(b)).digest('hex')}
