import { createHash } from 'node:crypto'
import { canonicalize } from '../tracker-core/renderManifest.js'
import { resolveCreativeProfile, type CreativeProfile } from './creativeProfile.js'

export type GenerativeInputKind = 'topic' | 'text'
export type GenerativeBrief = {
  schema: 'generative-brief/1'
  profile: 'wisdom'
  kind: GenerativeInputKind
  text: string
  language: 'ko'
  aspectRatio: '9:16'
  targetSeconds: number
  creative?: CreativeProfile
  // a Short derived from a Wisdom Longform (set by job_create from the parent's stored recommendation)
  derivedFrom?: { parentLongformJobId: string; parentLongformTitle: string; parentLongformUrl: string | null; candidateId: string; shortTitle: string; hook: string; corePoint: string; payoff: string; sourceClaim: string; sourceRefs: Array<{ section: number; sentence: number }> }
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
export function normalizeGenerativeBrief(input:any): GenerativeBrief {
  const kind=String(input?.kind||'') as GenerativeInputKind
  if(kind!=='topic'&&kind!=='text') throw new Error('input.kind must be topic or text')
  const text=String(input?.text||'').replace(/\s+/g,' ').trim()
  if(text.length<4||text.length>12000) throw new Error('input.text must be 4..12000 characters')
  const targetSeconds=Number(input?.targetSeconds??55)
  if(!Number.isFinite(targetSeconds)||targetSeconds<35||targetSeconds>75) throw new Error('targetSeconds must be 35..75 for wisdom')
  // Creative Settings (voice/tone/speed/picture style): AUTO keeps the Wisdom Shorts house voice and its own style
  const creative=resolveCreativeProfile('wisdom',input,text)
  return {schema:'generative-brief/1',profile:'wisdom',kind,text,language:'ko',aspectRatio:'9:16',targetSeconds,creative}
}
export function generativeBriefHash(b:GenerativeBrief){return createHash('sha256').update(canonicalize(b)).digest('hex')}
