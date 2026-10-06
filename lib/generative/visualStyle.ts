// The single place where picture styles (그림체) are defined, like voiceProfile.ts for voices. Planners never write a
// style sentence of their own when a style is chosen: every generated image prompt is composed here, in one order:
// BASE CONTENT -> VISUAL STYLE -> COMPOSITION -> CHARACTER CONSISTENCY -> NEGATIVE. UI strings carry only the key.
export const VISUAL_STYLE_KEYS = ['senior-warm-watercolor', 'wisdom-painterly', 'historical-dramatic', 'realistic-documentary', 'bright-editorial'] as const
export type VisualStyleKey = (typeof VISUAL_STYLE_KEYS)[number]
export const VISUAL_STYLE_CHOICES = ['auto', ...VISUAL_STYLE_KEYS] as const
export type VisualStyleChoice = (typeof VISUAL_STYLE_CHOICES)[number]
export type VisualStyleProfile = { id: VisualStyleKey; label: string; promptPrefix: string; negativePrompt: string; compositionHints: string }

const NO_TEXT = 'no text, letters, numbers, captions, signatures, logos or watermark'
export const VISUAL_STYLE_PROFILES: Readonly<Record<VisualStyleKey, VisualStyleProfile>> = {
  'senior-warm-watercolor': {
    id: 'senior-warm-watercolor', label: '따뜻한 수채화',
    promptPrefix: 'Warm hand-painted watercolor illustration with soft brush strokes and a light paper grain, gentle natural light, honest everyday Korean life (homes, markets, hospitals, streets, small restaurants), natural older Korean people drawn with dignity and clearly readable, unexaggerated facial emotion; every image looks painted by the same artist for the same film',
    negativePrompt: `photorealistic photo, glossy 3D render, anime, manga, cartoon exaggeration, childish picture-book style, caricature of elderly people, heavy yellow or sepia filter, ${NO_TEXT}`,
    compositionHints: 'clear story staging, faces large enough to read emotion, uncluttered background'
  },
  'wisdom-painterly': {
    id: 'wisdom-painterly', label: '철학적 페인터리',
    promptPrefix: 'Cinematic painterly illustration, calm and contemplative, deep chiaroscuro light and shadow, muted rich colors, philosophical reflective mood',
    negativePrompt: `cartoon, anime, glossy 3D render, bright flat colors, ${NO_TEXT}`,
    compositionHints: 'strong single focal point, generous negative space'
  },
  'historical-dramatic': {
    id: 'historical-dramatic', label: '시대극',
    promptPrefix: 'Dramatic cinematic historical illustration, period-accurate costumes, architecture and props, theatrical lighting, epic yet human storytelling',
    negativePrompt: `modern clothing or objects, anime, cartoon, glossy 3D render, ${NO_TEXT}`,
    compositionHints: 'period setting clearly visible, characters in action'
  },
  'realistic-documentary': {
    id: 'realistic-documentary', label: '현실적 다큐',
    promptPrefix: 'Realistic documentary-style image, natural available light, true-to-life colors and textures, unstaged candid moment, minimal stylization',
    negativePrompt: `cartoon, anime, painterly effects, fantasy elements, dramatic exaggeration, ${NO_TEXT}`,
    compositionHints: 'eye-level documentary framing'
  },
  'bright-editorial': {
    id: 'bright-editorial', label: '밝은 일러스트',
    promptPrefix: 'Bright clean editorial illustration, clear simple shapes, high visual readability on a phone, fresh saturated but balanced colors',
    negativePrompt: `dark muddy colors, cluttered details, photorealistic photo, ${NO_TEXT}`,
    compositionHints: 'one clear subject, readable silhouette'
  }
}
export function parseVisualStyle(v: unknown): VisualStyleChoice {
  const s = String(v ?? 'auto')
  if (!(VISUAL_STYLE_CHOICES as readonly string[]).includes(s)) throw new Error(`visualStyleProfile must be one of ${VISUAL_STYLE_CHOICES.join(', ')}`)
  return s as VisualStyleChoice
}
// One generated image prompt, always in the same order. `content` is what the picture shows (from the planner);
// `composition` is the format's framing rule; `characters` are the Character Bible lines of the people in the picture.
export function composeImagePrompt(o: { content: string; style: VisualStyleProfile; composition: string; characters?: string[]; negative?: string }): string {
  return [
    `Content: ${o.content.trim()}.`,
    `Style: ${o.style.promptPrefix}.`,
    `Composition: ${o.composition.trim()} ${o.style.compositionHints}.`,
    ...(o.characters?.length ? [`Characters (keep exactly this look): ${o.characters.join(' | ')}.`] : []),
    `Avoid: ${[o.style.negativePrompt, o.negative].filter(Boolean).join(', ')}.`
  ].join(' ')
}
