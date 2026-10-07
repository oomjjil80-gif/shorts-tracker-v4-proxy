// 숨은야담 YASA STORY DNA — the story rules of the yasa content (yasa_shorts / yasa_longform).
// The text AI writes the story; Tracker enforces the structure:
//   PLAN   (api/story.ts taskType yasa_story_plan): the AI fills this DNA first (strict JSON schema), checked here
//   STORY  (story_draft / longform_chapter / claude-story chapter): the AI gets the DNA as is and must keep it
//   CHECK  (story_draft result, gpt-script-qc review): deterministic checks — no second AI call
// Only content of the family "yasa" ever reaches this module; every other family is unchanged.

export const STORY_BASIS = ['historical_fact', 'legend_or_folklore', 'inspired_fiction'] as const
export type YasaFormat = 'shorts' | 'longform'

const s = { type: 'string' } as const
const strings = { type: 'array', items: s } as const
const obj = (props: Record<string, any>) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props })

export const YASA_STORY_DNA_SCHEMA = obj({
  title: s,
  openingLine: s,
  setting: obj({ region: s, era: s, culturalNotes: s }),
  storyBasis: { type: 'string', enum: [...STORY_BASIS] },
  hero: obj({ role: s, socialPosition: s, emotionalWound: s, desire: s, immediateProblem: s }),
  mystery: obj({ strangeAction: s, concreteProp: s, apparentMeaning: s, trueMeaning: s, mainQuestion: s, secondaryQuestion: s }),
  pressure: obj({ immediateLoss: s, humiliationOrMisunderstanding: s, antagonistOrPressure: s, worseningEvents: strings }),
  reveal: obj({ partialProof: s, majorCrisis: s, majorReveal: s, emotionalReframe: s }),
  payoff: obj({ externalRewardOrResolution: s, emotionalReward: s, finalAfterglow: s }),
  // after the major reveal the story is NOT over: a first resolution (it looks like the end), then at least two layers
  // that each open a real further event / relationship / consequence; lifeLesson = one short line earned by THIS story
  aftermath: obj({ firstResolution: s, postRevealLayers: strings, lifeLesson: s }),
  propArc: strings,
})

// the story engine (positions are shares of the running time)
export const YASA_STORY_ENGINE = [
  '[숨은야담 — 드라마형 야담(옛이야기) 스토리텔링]',
  '역사 설명 콘텐츠가 아니다. "사람 → 사건 → 의문 → 위기 → 반전 → 감정 보상"으로 끌고 가는 드라마다.',
  '나라·시대 제한 없음: 조선·중국·일본·유럽·중동·미국·고대 문명 등 소재에 맞게 고른다. 자동으로 조선/한복/양반/시어머니로 가지 않는다. 한 이야기 안에서는 시대·지역·문화 설정을 일관되게 유지한다.',
  '금지: 역사 강의식 구성, 연대기 나열, 인물 생애 요약, 백과사전식 설명, 배경 설명부터 길게 시작, 결말을 초반에 공개, 비슷한 고난 장면 반복.',
  '',
  '[구조]',
  '0~3% 이상한 사건 — 설명 없이 바로 사건. 시청자가 즉시 "왜?"라고 묻게 한다.',
  '3~15% 즉시 손해 — 돈·체면·기회·가족·안전·신분 중 실제 손해. 억울하다고 느낄 정도.',
  '15~30% 인물 관계 + 상처 — 주인공의 과거 상처 1개만. 과도한 과거 설명 금지.',
  '30~50% 의심 증폭 — 조롱·압박·손실·관계 악화·위험 증가. "정말 잘못된 선택 아닌가?"',
  '50~65% 작은 증거(partialProof) — 이상한 행동/물건이 평범하지 않다는 첫 증거. 비밀 전체 공개 금지.',
  '65~80% 큰 위기(majorCrisis) — 목숨·재산·가족·명예 중 최소 하나가 실제 위험. 최고 압박.',
  '80~92% 대반전(majorReveal) — strangeAction/concreteProp의 진짜 의미 공개. 초반 장면이 완전히 다른 의미로 보이게.',
  '대반전 직후 FIRST RESOLUTION(가짜 결말) — 눈앞의 문제가 풀려 여기서 끝날 것처럼 보인다.',
  '이어서 POST-REVEAL LAYER 최소 2개 — 문장 2개가 아니라 실제 사건·관계·결과가 한 단계씩 더 열린다(예: 개인 문제 해결 → 상대나 공동체에 미치는 결과 → 과거 행동의 감정적 의미 재해석). 복수·마을 구제를 억지로 넣지 않는다. 같은 갈등 반복 금지.',
  '마지막 emotionalReframe + finalPayoff/afterglow — 억울함 해소, 관계 재해석, 짧은 후일담. 교훈은 이 이야기의 행동·관계·선택에서 자연스럽게 나오는 짧은 한마디만 허용(뜬금없는 명언·훈계·"그러므로 우리는" 식 강의 금지).',
  '[길이] 긴 이야기는 인물 관계 → 오해 → 작은 선행 → 압박 → 악화 → 부분 증거 → 위기 → 가짜 해결 → 진실 → 추가 결과 → 감정 재해석의 축적으로 길어진다. 같은 고난·설명 반복, 의미 없는 대화, 배경 설명 늘이기로 채우지 않는다.',
  '',
  '[CONCRETE PROP] 눈으로 기억되는 물건 1개(예: 썩은 메주, 낡은 열쇠, 옥가락지, 찢어진 지도, 오래된 편지). 이야기 진행에 따라 의미가 변해야 한다(예: 짐 → 수상한 물건 → 위험을 막는 도구 → 마지막 비밀의 열쇠).',
  '[장면 존재 이유] 모든 장면은 ①주인공 감정/억울함을 키우거나 ②mystery/prop의 중요성을 키우거나 ③reveal/payoff로 전진시킨다. 셋 다 아니면 삭제·병합. 같은 기능의 고난 반복 금지.',
  '[RETENTION] 질문은 최대 2개: mainQuestion "왜 저런 행동을 했는가?", secondaryQuestion "저 물건/사람에는 무엇이 숨겨져 있는가?". 새 미스터리를 계속 늘리지 않는다. mainQuestion의 답은 80% 이전에 완전히 공개하지 않는다(50~65% partialProof는 허용).',
  '[TITLE DNA] 사람 + 결핍/상황 + 이상한 행동 또는 물건 + 답하지 않은 WHY. 예: "5년 만에 친정 가는 며느리에게 시어머니가 썩은 메주만 지워 보낸 이유". "충격적인 진실", "놀라운 비밀" 같은 추상어로 훅을 대신하지 않는다.',
  '[OPENING] "옛날 ○○시대에는", "오늘 이야기의 주인공은", "먼저 당시 시대적 배경을" 금지. 이상한 행동 → 주인공 반응 → 손해 예상 → WHY 질문 순으로 바로 시작.',
  '[storyBasis] historical_fact / legend_or_folklore / inspired_fiction 중 하나. 전승·창작을 사실처럼 단정하지 않는다.',
].join('\n')

const FORMAT_RULES: Record<YasaFormat, string> = {
  shorts: '[쇼츠] 사건 진입을 더 빠르게, 등장인물 최소화, mystery 1개, payoff 1개. worseningEvents는 1~3개로 압축.',
  longform: '[롱폼] worseningEvents를 3단계 이상 충분히 단계화, 관계 변화 허용, 작은 반전 가능. 하지만 majorReveal은 후반(80~92%)까지 유지.',
}

const BANNED_OPENINGS = [/^\s*옛날\s*\S*\s*시대/, /^\s*오늘\s*(이야기|소개할)/, /^\s*먼저\s*당시/, /시대적\s*배경을\s*살펴/]
const ABSTRACT_TITLE = /(충격적인\s*진실|놀라운\s*비밀|충격\s*실화|소름\s*돋는\s*진실)/

const text = (v: unknown) => String(v ?? '').trim()
// the noun a viewer remembers ("썩은 메주" -> "메주")
export const propKeyword = (dna: any) => { const p = text(dna?.mystery?.concreteProp); return p.split(/\s+/).filter((w) => [...w].length >= 2).pop() || p || '\u0000' }

// deterministic structure check of a PLAN result
// layers: a NEW longform PLAN must have the post-reveal structure (first resolution + 2 layers). The script / QC / revise
// endpoints keep accepting a PLAN made before that existed (an Episode already in production is never broken).
export function validateYasaStoryDna(dna: any, format: YasaFormat, o: { layers?: boolean } = {}): { ok: boolean; errors: string[] } {
  const e: string[] = []
  if (!dna || typeof dna !== 'object') return { ok: false, errors: ['dna: missing'] }
  const need = (path: string) => { const v = path.split('.').reduce((o: any, k) => o?.[k], dna); if (!text(v)) e.push(`${path}: missing`) }
  ;['hero.role', 'hero.socialPosition', 'hero.emotionalWound', 'hero.desire', 'hero.immediateProblem'].forEach(need)
  ;['mystery.strangeAction', 'mystery.concreteProp', 'mystery.apparentMeaning', 'mystery.trueMeaning', 'mystery.mainQuestion'].forEach(need)
  ;['pressure.immediateLoss', 'reveal.partialProof', 'reveal.majorCrisis', 'reveal.majorReveal', 'reveal.emotionalReframe'].forEach(need)
  ;['payoff.emotionalReward', 'setting.region', 'setting.era', 'title', 'openingLine'].forEach(need)
  if (!(STORY_BASIS as readonly string[]).includes(dna.storyBasis)) e.push('storyBasis: must be historical_fact, legend_or_folklore or inspired_fiction')
  const worsening = Array.isArray(dna.pressure?.worseningEvents) ? dna.pressure.worseningEvents.filter((x: unknown) => text(x)) : []
  if (format === 'longform' && worsening.length < 3) e.push(`pressure.worseningEvents: longform needs at least 3 (got ${worsening.length})`)
  if (format === 'shorts' && worsening.length < 1) e.push('pressure.worseningEvents: at least 1')
  if (format === 'longform' && o.layers) {
    const first = text(dna.aftermath?.firstResolution), layers = (Array.isArray(dna.aftermath?.postRevealLayers) ? dna.aftermath.postRevealLayers : []).map(text).filter(Boolean)
    if (!first) e.push('aftermath.firstResolution: missing (the story must look solved before it goes further)')
    if (new Set(layers).size < 2) e.push(`aftermath.postRevealLayers: longform needs at least 2 different layers after the reveal (got ${new Set(layers).size})`)
    if (first && layers.includes(first)) e.push('aftermath.postRevealLayers: must go beyond the first resolution')
    if (!text(dna.payoff?.finalAfterglow)) e.push('payoff.finalAfterglow: missing')
  }
  if (text(dna.mystery?.apparentMeaning) && text(dna.mystery?.apparentMeaning) === text(dna.mystery?.trueMeaning)) e.push('mystery.trueMeaning: must differ from apparentMeaning')
  if (ABSTRACT_TITLE.test(text(dna.title)) && !text(dna.title).includes(propKeyword(dna))) e.push('title: abstract hook words instead of a concrete person/prop/action')
  if (BANNED_OPENINGS.some((r) => r.test(text(dna.openingLine)))) e.push('openingLine: must start with the strange event, not background')
  return { ok: e.length === 0, errors: e }
}

export function yasaPlanInstructions(format: YasaFormat, targetSeconds: number): string {
  return [
    '당신은 "숨은야담" 채널의 스토리 설계자다. 대본을 쓰기 전에 YASA STORY DNA를 설계한다.',
    YASA_STORY_ENGINE,
    FORMAT_RULES[format],
    `목표 길이 약 ${Math.round(targetSeconds)}초.`,
    '모든 필드를 구체적인 사람·사건·물건으로 채운다. 추상적인 표현 금지.',
    'mystery.apparentMeaning(처음 보이는 의미)과 mystery.trueMeaning(대반전에서 밝혀지는 진짜 의미)은 반드시 달라야 한다.',
    'propArc는 concreteProp의 의미 변화를 순서대로 3~5단계로 적는다.',
    'aftermath.firstResolution은 대반전 직후 해결된 것처럼 보이는 결말, aftermath.postRevealLayers는 그 뒤에 실제로 더 열리는 사건·관계·결과(롱폼은 서로 다른 2개 이상), aftermath.lifeLesson은 이 이야기에서 나오는 짧은 한마디(없으면 빈 문자열).',
    'openingLine은 영상의 첫 문장이다(이상한 사건/말로 바로 시작).',
    '반드시 지정된 JSON schema만 출력한다.',
  ].join('\n\n')
}

// what the STORY/SCRIPT AI must keep (the PLAN goes in as is)
export function yasaScriptBrief(dna: any, format: YasaFormat): string {
  return [
    '[숨은야담 STORY DNA — 이 PLAN을 그대로 따른다. 아래 규칙은 다른 일반 규칙보다 우선한다]',
    YASA_STORY_ENGINE,
    FORMAT_RULES[format],
    '[반드시 유지] strangeAction 유지 · concreteProp 유지 · apparentMeaning → trueMeaning 전환 유지 · mainQuestion 유지 · partialProof는 50~65% 구간 · majorReveal은 80~92% 후반 · 대반전 뒤 firstResolution과 postRevealLayers(롱폼 2개 이상) 유지 · emotionalReframe 유지. 핵심 반전 구조를 임의로 없애거나 앞당기지 않는다.',
    '[첫 문장] openingLine으로 시작한다(또는 같은 사건으로 바로 시작).',
    '[PLAN]',
    JSON.stringify(dna, null, 2),
  ].join('\n\n')
}

// deterministic check of a written script against its PLAN (no AI call)
export function checkYasaScript(script: string, dna: any): { ok: boolean; errors: string[] } {
  const e: string[] = []
  const body = text(script)
  if (!body) return { ok: false, errors: ['script: empty'] }
  const firstSentence = body.split(/(?<=[.!?。…])\s+|\n/)[0] || ''
  if (BANNED_OPENINGS.some((r) => r.test(firstSentence))) e.push('opening: starts with background/introduction instead of the strange event')
  const prop = text(dna?.mystery?.concreteProp)
  if (prop && !body.replace(/\s+/g, '').includes(propKeyword(dna).replace(/\s+/g, ''))) e.push(`concreteProp: "${prop}" never appears in the script`)
  return { ok: e.length === 0, errors: e }
}

// 숨은야담 longform length: whole minutes 10..120, about 3 minutes per chapter (other families keep their own limits)
export const YASA_LONGFORM_MINUTES = { min: 10, max: 120 } as const
export const yasaLongformMinutes = (v: unknown) => Math.max(YASA_LONGFORM_MINUTES.min, Math.min(YASA_LONGFORM_MINUTES.max, Math.round(Number(v) || 25)))
export const yasaChapterCount = (minutes: number, requested?: unknown) => Math.max(3, Math.min(40, Math.round(Number(requested) || minutes / 3)))

export const isYasa = (input: any) => String(input?.contentFamily || input?.family || '').trim() === 'yasa'
export const yasaFormatOf = (input: any): YasaFormat => (String(input?.contentFormat || input?.format || '') === 'longform' ? 'longform' : 'shorts')
