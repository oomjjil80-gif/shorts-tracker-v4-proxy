// CANDIDATE 숨은야담 그림체 v2 — used ONLY by the one-off example maker (worker/oneoffStyleExamples.ts). Nothing in the
// production pipeline imports this file: the styles jobs use (visualStyle.ts, AUTO = korean_drama_illustration) are
// unchanged until the user approves these pictures.
import type { VisualStyleProfile } from './visualStyle.js'

const NEG = 'photorealistic, photoreal, real photo, live action, hyper realistic human, uncanny realism, ugly or grotesque faces, horror style, wrong hands, faces or body proportions, sepia or yellow-brown colour cast over the whole picture, aged, stained or yellowed paper, vintage faded colours, grey or brown haze, muddy colours, modern or Western people, clothing or settings, borders or frames, no text, letters, numbers, captions, signatures, logos or watermark'
const v2 = (id: string, label: string, look: string, composition: string): VisualStyleProfile =>
  ({ id: id as any, label, promptPrefix: `${look}; a beautiful, pleasant-looking illustration (never a photograph), attractive well-drawn faces with clear emotion`, negativePrompt: NEG, compositionHints: composition })
// the 5 styles of the new menu; joseon_clean_watercolor is the proposed AUTO
export const YADAM_STYLE_CANDIDATES: ReadonlyArray<{ key: string; compareWith: string; profile: VisualStyleProfile }> = [
  { key: 'joseon_clean_watercolor', compareWith: 'classic_storybook', profile: v2('joseon_clean_watercolor', '선명한 조선 수채화', 'Clean, luminous Korean watercolor illustration of the Joseon era: fine confident ink outlines under transparent watercolor washes on bright white paper, crisp where it matters, rich natural colour contrast (jade green, indigo blue, vermilion red, clean white) with natural warm skin tones and soft natural daylight, beautiful refined faces with delicate features and clear emotion', 'clear story staging, faces large enough to read emotion, airy uncluttered background') },
  { key: 'korean_drama_illustration', compareWith: 'korean_drama_illustration', profile: v2('korean_drama_illustration', '고급 사극 일러스트', 'Premium Korean historical drama illustration of the Joseon era, refined digital painting with a soft watercolor finish, beautiful clean faces with natural skin, vivid clear colours, soft natural light, expressive emotion that reads at thumbnail size', 'faces and emotion clearly readable, strong thumbnail-friendly focal point') },
  { key: 'oriental_painterly', compareWith: 'oriental_painterly', profile: v2('oriental_painterly', '감성 동양화풍', 'Lyrical Korean ink-and-colour painting on clean white paper: confident ink brush lines with clear transparent colour washes (jade, indigo, vermilion, soft pink), graceful beautiful figures, airy luminous atmosphere', 'airy composition with breathing space, figures gracefully placed') },
  { key: 'webtoon_historical', compareWith: 'webtoon_historical', profile: v2('webtoon_historical', '웹툰형 사극풍', 'Korean historical webtoon style of the Joseon era, crisp clean line art, attractive distinct characters, strong readable facial expressions, bright clear colours with a clean neutral white balance', 'characters easy to tell apart, expressive faces large in frame') },
  { key: 'fairytale_illustration', compareWith: 'fairytale_illustration', profile: v2('fairytale_illustration', '동화풍 채색 일러스트', 'Joseon-era fairytale illustration, soft bright painted colours, friendly beautiful Korean faces, gentle emotional storytelling, clean luminous light', 'warm inviting staging, emotion carried by faces and gestures') }
]
// the ONE Joseon scene every example draws (only the style differs)
export const EXAMPLE_SCRIPT: any = {
  characters: [
    { id: 'bride', name: '며느리', role: 'young daughter-in-law', age: 22, gender: 'female', appearance: 'a beautiful young Korean woman, gentle oval face, natural warm skin, serious but kind eyes', hair: 'neat Joseon married-woman chignon with a wooden binyeo', outfit: 'pale yellow jeogori, deep blue chima, white apron cloth', props: '' },
    { id: 'mother', name: '시어머니', role: 'old mother-in-law', age: 65, gender: 'female', appearance: 'a dignified elderly Korean woman, graceful wrinkles, calm firm gaze', hair: 'grey hair in a low chignon with a silver binyeo', outfit: 'jade green jeogori and charcoal chima', props: '' }
  ],
  yasaStoryDNA: { setting: { region: '조선', era: '후기 (18세기)', culturalNotes: '시골 마을' }, mystery: { concreteProp: '메주' } }
}
export const EXAMPLE_SCENE: any = {
  id: 'example', place: 'the sunny yard in front of the kitchen of a thatched-roof choga house, a jangdokdae crock terrace behind, a persimmon tree', time: 'clear late morning, soft natural daylight',
  characters: ['bride', 'mother'], action: 'the mother-in-law hands the young daughter-in-law a block of 메주 wrapped in straw; both look at each other seriously',
  mood: 'warm, lyrical, quietly serious', visual: 'a Joseon countryside village yard; blocks of meju hang from straw ropes under the eaves'
}
