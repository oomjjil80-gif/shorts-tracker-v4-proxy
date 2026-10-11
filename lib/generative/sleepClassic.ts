// Opt-in, locked Odyssey Book IX bedtime audiobook. No changes to existing Wisdom Shorts or talk planner.
// The nine chapter beats are verified against the public-domain Homer original; Claude writes original Korean narration.
import { openAiLongformPlanner, respond, type LongformPlanner, type LongformOutline } from './longformPlanner.js'
import type { LongformBrief, LongformSentence } from './longform.js'
import { classifyOpenAiError } from './longformResearch.js'

export const SLEEP_CLASSIC_ID = 'odyssey-cyclops-v1'
export const SLEEP_CLASSIC_TITLE = '잠들기 전 듣는 오디세이아 | 아무도 아니다, 외눈박이 거인의 동굴 (1편)'
export const SLEEP_CLASSIC_SOURCE = 'Homer, Odyssey, Book IX (ancient public-domain source; no modern Korean translation)'
export const SLEEP_CHAPTERS = [
  { heading: '이름을 묻는 저녁, 이스마로스', beats: ['파이아케스 왕 앞에서 오디세우스 실명 공개', '키코네스인 이스마로스 약탈과 마론의 가족을 살려 얻은 포도주', '출항을 거부한 부하들과 반격, 배마다 여섯 명 희생', '죽은 동료의 이름을 세 번 부름과 북풍'] },
  { heading: '연밥의 땅', beats: ['로토파고이에게 보낸 정탐꾼', '연밥을 먹고 귀향할 뜻을 잃음', '울며 버티는 이들을 배로 데려와 묶고 출항'] },
  { heading: '안개 속 염소 섬', beats: ['키클롭스의 풍습과 법 없이 사는 모습', '무인도 염소 사냥과 포도주 잔치', '건너편에서 들리는 양 울음', '배 한 척과 부하 열두 명 및 마론 포도주를 가져감'] },
  { heading: '돌문이 닫힌 동굴', beats: ['치즈를 챙겨 떠나자는 부하들', '손님 환대를 기대한 오디세우스가 기다림', '거인이 돌아와 거대한 바위로 입구를 막음', '손님을 보호하는 신을 무시하고 배의 행방을 묻는 거인', '거인이 첫 저녁 부하 두 명을 잡아먹음'] },
  { heading: '첫 번째 밤과 올리브 말뚝', beats: ['거인을 죽여도 입구 바위를 치울 수 없다는 판단', '이튿날 아침 두 명 추가 희생', '올리브 말뚝을 다듬고 불에 굳혀 거름 아래 숨김', '제비로 부하 네 명을 고르고 자신이 합류함', '두 번째 저녁 양 떼를 모두 동굴에 들임'] },
  { heading: "포도주와 '아무도 아니다'", beats: ['두 번째 저녁 두 명 더 희생하여 동굴 안에서 합계 여섯 명 사망', '오디세우스가 마론의 포도주를 세 그릇 마시게 함', "거짓 이름을 '아무도 아니다'라고 말함", '맨 마지막에 잡아먹겠다는 끔찍한 선물', '거인이 취해 잠듦'] },
  { heading: '눈먼 거인과 이웃들', beats: ['다섯 명이 뜨거운 말뚝을 외눈에 박아 돌림; 잔혹한 직접 묘사 금지', '이웃들이 누구에게 당했는지 묻자 아무도 아니다라고 답해 돌아감', '입구 바위를 치우고 손을 뻗어 지키는 거인'] },
  { heading: '양의 배 아래', beats: ['사흘째 아침, 숫양 세 마리씩 묶고 가운데 한 마리 배 밑에 부하 매달기', '오디세우스는 가장 큰 숫양의 배 털을 잡음', '거인이 등만 만지며 양을 보냄', '맨 마지막 숫양에게 거인이 말을 검', '밖에서 일행이 풀려나 배로 향함'] },
  { heading: '바다 위에서 밝힌 이름', beats: ['첫 조롱과 첫 돌 투척', '부하들이 위험하니 그만하라고 만류', '이타카의 오디세우스라는 본명을 소리침', '예언자 텔레모스의 예언을 기억하는 거인', '포세이돈에게 귀향 지연·동료 상실·남의 배 귀향·집안 고난을 저주해 달라 기원', '두 번째 바위와 염소 섬 귀환', '제우스가 숫양의 제물을 받지 않고 다음 날 떠남'] }
] as const

// Concrete source chronology: protects the author from plausible but invented filler.
// These are factual accuracy constraints, never a running-time or length target.
export const SLEEP_CANON = [
  '파이아케스 왕 앞의 실명 공개는 회상 이야기의 바깥 틀이다. 마론을 살려 얻은 포도주는 훗날 키클롭스 동굴에서 쓴다.',
  '이스마로스 탈출 후 거센 북풍으로 돛이 찢겨 육지에 닿고 이틀 밤낮 머물렀다. 사흘째 떠나 말레이아 곶에서 다시 북풍과 조류에 밀려 아흐레 떠돈 뒤 로토파고이 땅에 닿는다. 그 순서와 장소를 바꾸지 말라.',
  '염소 섬은 키클롭스들이 사는 큰 섬 맞은편의 무인 섬이다. 한 척만 따로 동굴을 살핀다.',
  '폴리페모스가 양떼를 들여오고 바위를 닫는다. 손님 환대의 신을 무시하는 대화와 배 위치를 묻는 질문, 오디세우스의 배에 관한 거짓 답은 앞뒤 인과 순서가 자연스러워야 한다. 실제로 하지 않은 말이나 사후에 언급하는 대화를 꾸며 넣지 않는다.',
  '아침 두 명을 더 잡아먹은 다음 올리브 말뚝을 깎아 불에 굳히고 거름 아래 숨긴다. 동료 네 명을 뽑아 오디세우스가 합류한다.',
  '마론의 강한 포도주 세 잔을 마시게 하며 거짓 이름 아무도 아니다를 밝힌다. 도리에 관한 창작 훈계나 포도주가 손에서 떨어지는 사건, 직접 인용을 새로 만들지 않는다.',
  '올리브 말뚝은 전날 거름 아래 감췄던 동일한 말뚝이다. 재나 화덕에 묻어 두었다고 바꾸지 않는다. 이웃들은 아무도 아니다라는 말을 듣고 돌아간다.',
  '셋씩 숫양을 묶고 가운데 매달려 빠져나간다. 오디세우스는 가장 큰 숫양의 배를 붙든다.',
  '첫 조롱 뒤 첫 투석, 동료들 만류, 본명 공개, 폴리페모스의 예언 회상·포세이돈 저주, 두 번째 돌, 숫양 제물과 제우스가 받지 않음 순이다.'
] as const

export const SLEEP_INTRO = [
  '오늘 밤에는 아주 오래된 이야기를 하나 들려 드리겠습니다.',
  '아주 오래전 고대 그리스에서 노래로 전해지던 이야기입니다. 오디세이아라는 긴 노래에 나오는 모험 가운데 하나지요.',
  '트로이아 전쟁이 끝난 뒤, 한 사람이 고향 이타카를 향해 배를 띄웠습니다. 이름은 오디세우스. 그러나 바닷길은 그를 집으로 곧장 보내 주지 않았습니다. 그는 오랫동안 바다 위를 떠돌다가, 어느 섬나라에 낯선 손님으로 닿게 됩니다.',
  '그 나라 왕은 손님에게 먼저 먹을 것과 잠자리를 내주었습니다. 그리고 잔치가 무르익은 저녁, 이제 이름을 알려 달라고 청했습니다. 어디서 왔는지, 어쩌다 이곳까지 오게 되었는지도 함께 물었지요.',
  '손님은 그제야 입을 열었습니다. 저는 라에르테스의 아들 오디세우스입니다. 그리고 트로이아를 떠난 날부터 겪은 일을, 처음부터 천천히 이야기하기 시작했습니다.',
  '그 이야기 속에는 동굴이 하나 나옵니다. 오디세우스는 그 동굴에서 두 번의 밤을 보냈고, 두 번째 밤에는 자기 이름을 다른 말로 바꿔 댔습니다. 이름을 감춘 덕에 목숨을 건졌고, 이름을 밝히는 바람에 오랫동안 고생하게 되지요.',
  '서두르지 않고 가겠습니다. 편안하게 누워서, 숨을 천천히 내쉬면서 들어 주세요. 먼저, 트로이아를 떠난 배들이 처음 닿은 해안에서부터 시작하겠습니다.'
].join(' ')

export const isSleepClassic = (brief: Pick<LongformBrief, 'profile' | 'sleepClassic'> | null | undefined) =>
  brief?.profile === 'wisdom_longform' && brief?.sleepClassic === SLEEP_CLASSIC_ID
export function sleepClassicOutline(): LongformOutline {
  return {
    title: SLEEP_CLASSIC_TITLE,
    hook: '잠자리에 누워 듣는 오디세우스의 외눈박이 거인 이야기',
    figure: { name: '오디세우스', imagePrompt: 'A classical Greek stone bust of Odysseus and a closed ancient book resting beside a softly lit night sea; quiet, monochrome charcoal-gray still, no text, no motion, soothing dark atmosphere' },
    // Thumbnail click-copy obeys the existing red/purple/green accent gate; VIDEO remains monochrome.
    thumbnail: { lines: [{ text: '아무도 아니다', color: 'purple' }, { text: '거인의 동굴', color: 'white' }] },
    sections: SLEEP_CHAPTERS.map((c, i) => ({ id: 's' + (i + 1), heading: c.heading, points: [...c.beats] }))
  }
}
export const sleepCard = (say: string): LongformSentence => ({ say, show: ['조용한 고전', '오디세이아'], accent: '고전', color: 'yellow' })
export function splitSleepParagraphs(paragraphs: string[]): LongformSentence[] {
  const out: LongformSentence[] = []
  for (const para of paragraphs) {
    const words = String(para || '').replace(/\s+/g, ' ').trim().split(' ')
    let block = ''
    for (const w of words) {
      if (!w) continue
      if ([...w].length > 1100) throw new Error('Claude sleep narration contains a too-long unsplittable word')
      const candidate = block ? block + ' ' + w : w
      if ([...candidate].length > 900 && block) { out.push(sleepCard(block)); block = w } else block = candidate
    }
    if (block) out.push(sleepCard(block))
  }
  return out
}
type Fetcher = typeof fetch
export type SleepChapterPartCache = {
  read: (chapter: number, part: number) => Promise<string[] | null>
  write: (chapter: number, part: number, paragraphs: string[]) => Promise<void>
}
const stopSleep = (reason: string, code: string) => Object.assign(new Error(reason), { stop: true, code })

// Long bedtime narration MUST be composed in bite-size, non-overlapping plot beats.
// Never throw away one valid paid part to repeat the whole chapter. Save each part BEFORE the next API call.
export function createSleepClassicPlanner(f: Fetcher = fetch, cache?: SleepChapterPartCache): LongformPlanner {
  return {
    async outline() { return sleepClassicOutline() },
    async section({ index, previousTail }, apiKey) {
      const c = SLEEP_CHAPTERS[index]
      if (!c) throw stopSleep('unknown locked sleep chapter ' + index, 'SLEEP_CHAPTER_UNKNOWN')
      const key = process.env.ANTHROPIC_API_KEY || ''
      if (!key) throw stopSleep('ANTHROPIC_API_KEY missing: sleep classic requires Claude, no GPT fallback', 'PROVIDER_AUTH')
      // Divide only by verified story beats, never a word count or runtime target.
      // This avoids fabricated padding and lets short events remain short.
      const parts = Math.max(1, Math.ceil(c.beats.length / 2))
      const whole: string[] = []
      for (let part = 0; part < parts; part++) {
        const start = Math.floor(part * c.beats.length / parts)
        const stop = Math.floor((part + 1) * c.beats.length / parts)
        const beats = c.beats.slice(start, stop)
        if (!beats.length) throw stopSleep('chapter is missing verified events', 'SLEEP_BEATS_SHORT')
        let paragraphs: string[] | null = cache ? await cache.read(index, part) : null
        if (paragraphs && (!Array.isArray(paragraphs) || !paragraphs.length || paragraphs.some((p) => typeof p !== 'string' || !p.trim()))) {
          throw stopSleep('corrupt checkpoint for a paid Claude chapter part', 'SLEEP_CHECKPOINT_INVALID')
        }
        if (!paragraphs) {
          const tail = whole.slice(-1).join(' ').slice(-850) || previousTail.join(' ').slice(-850)
          const input = [
            '호메로스 오디세이아 제9권을 기반으로, 밤에 듣는 한국어 고전 오디오북의 이야기를 새로 서술하라. 현대 한국어 번역문을 복사하지 말 것.',
            '확정 작품: ' + SLEEP_CLASSIC_TITLE, '원전: ' + SLEEP_CLASSIC_SOURCE,
            '9장 중 ' + (index + 1) + '장 (' + c.heading + ')의 ' + (part + 1) + '/' + parts + '번째 연속 낭독 구간이다.',
            '이번 구간에서만 다룰 검증된 사건(순서를 바꾸거나 다른 구간 사건을 앞당기지 말 것): ' + beats.join(' → '),
            '원전 사실관계와 인과 고정: ' + SLEEP_CANON[index],
            '글자 수·문단 수·낭독 시간 제한은 없다. 해당 사건이 자연스럽게 끝날 때까지 서술한다. 반복/분량 늘리기/새 인물/새 사건/가짜 직접 인용은 금지.',
            '위 사건을 시간적 행동과 인물의 선택, 동작 및 자연스러운 원전 맥락으로 풀어 구체적으로 설명하라. 한두 단락으로 줄이지 말고 사건별 변화가 독립적으로 드러나도록 충분히 서술할 것.',
            '낮고 따뜻한 남성 음성으로 읽을 3인칭 이야기체. 잔혹 상세 묘사·고함·무대 지시·챕터명·효과음 금지.',
            index === 0 && part === 0 ? '확정 90초 소개 대본은 별도 삽입된다. 도입을 다시 쓰지 말고 이스마로스 사건부터 시작할 것.' : '직전 본문의 마지막 (중복하지 말고 자연스럽게 이어서): ' + tail,
            part === parts - 1 && index === 8 ? '포세이돈의 저주를 다룬 뒤 다음날 아침 바다에서 차분하게 마무리하라.' : '다음 구간의 사건으로 넘어가지 말고 이번 부분의 마지막 행동에서 끝내라.',
            '오직 JSON만 반환: {"paragraphs":["완전한 문장으로 구성된 낭독용 문단",...]}. 문단 수와 분량은 사건에 따라 자유롭게 결정하고, 장면과 인물의 행동이 자연스럽게 이어지게 한다.'
          ].join('\n')
          const res = await f('https://api.anthropic.com/v1/messages', {
            method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({ model: process.env.ANTHROPIC_STORY_MODEL || 'claude-sonnet-5', max_tokens: 7000, messages: [{ role: 'user', content: input }] })
          })
          const raw = await res.text().catch(() => '')
          if (!res.ok) {
            const error = classifyOpenAiError(res.status, raw)
            throw stopSleep('Claude sleep classic HTTP ' + res.status, error.code)
          }
          let parsed: any
          try {
            const obj = JSON.parse(raw)
            if (obj.stop_reason === 'max_tokens') throw new Error('Claude part truncated')
            const text = (obj.content ?? []).filter((x: any) => x?.type === 'text').map((x: any) => String(x.text || '')).join('')
            const match = /\{[\s\S]*\}/.exec(text)
            if (!match) throw new Error('no JSON')
            parsed = JSON.parse(match[0])
          } catch {
            throw stopSleep('Claude returned invalid/truncated chapter part; no paid retry', 'SLEEP_PART_INVALID')
          }
          if (!Array.isArray(parsed.paragraphs) || !parsed.paragraphs.length || parsed.paragraphs.some((p: any) => typeof p !== 'string' || !p.trim())) {
            throw stopSleep('Claude returned an empty chapter part; no paid retry', 'SLEEP_PART_INVALID')
          }
          paragraphs = parsed.paragraphs as string[]
          if (cache) {
            try { await cache.write(index, part, paragraphs) } catch {
              throw stopSleep('Claude chapter part was generated but checkpoint save failed; stop to avoid charging again', 'SLEEP_CHECKPOINT_WRITE_FAILED')
            }
          }
        }
        whole.push(...paragraphs)
      }
      const core = splitSleepParagraphs(whole)
      const sentences = index === 0 ? [...splitSleepParagraphs([SLEEP_INTRO]), ...core] : core
      return { sentences }
    },
    metadata: openAiLongformPlanner(f).metadata
  }
}

// Actual independent GPT review of the complete Claude-authored narration. Rejects unsafe/incorrect results
// before any paid TTS or image generation. One checkpointed text call; never invents a replacement story.
export type SleepReview = { approved: boolean; fidelity: number; standalone: number; bedtime: number; story: number; originality: number; issues: string[] }
export async function reviewSleepClassicStory(sections: Array<{ id: string; sentences: LongformSentence[] }>, apiKey: string, f: Fetcher = fetch): Promise<SleepReview> {
  const schema = { type: 'object', additionalProperties: false,
    required: ['approved', 'fidelity', 'standalone', 'bedtime', 'story', 'originality', 'issues'],
    properties: {
      approved: { type: 'boolean' },
      fidelity: { type: 'integer', minimum: 1, maximum: 5 },
      standalone: { type: 'integer', minimum: 1, maximum: 5 },
      bedtime: { type: 'integer', minimum: 1, maximum: 5 },
      story: { type: 'integer', minimum: 1, maximum: 5 },
      originality: { type: 'integer', minimum: 1, maximum: 5 },
      issues: { type: 'array', maxItems: 8, items: { type: 'string' } }
    } }
  const source = sections.map((s, i) => ({
    chapter: i + 1, heading: SLEEP_CHAPTERS[i]?.heading,
    approvedBeats: SLEEP_CHAPTERS[i]?.beats,
    narration: s.sentences.map((x) => x.say).join(' ')
  }))
  const r: any = await respond(apiKey, 'sleep_classic_review', schema,
    'You are an independent Korean audiobook quality gate reviewing a CLAUDE-authored Odyssey Book IX narration. Check original Homeric plot sequence (two nights inside the cave, six men eaten 2+2+2, first taunt -> first thrown rock -> crew warning -> real name reveal -> Poseidon curse -> second rock), no invented events/characters/quoted statements, standalone plot, calm bedtime style, pacing/repetition and the fact the approved chapter order is retained. Score fidelity, standalone, bedtime, story and originality 1..5. Approve only if accurate and watchable; any consequential factual fabrication or structural break must cause approved=false. Describe only concrete defects in Korean. No rewrite. JSON only.',
    JSON.stringify(source), f)
  if (r.approved !== true || (r.issues ?? []).length) return { ...r, approved: false }
  return r as SleepReview
}


// No new generation on a failed original review. Only chapters explicitly cited by the
// independent reviewer can be repaired, at most once, and must pass the SAME review again.
export function sleepReviewIssuesByChapter(issues: string[]): Map<number, string[]> {
  const out = new Map<number, string[]>()
  if (!Array.isArray(issues) || !issues.length || issues.length > 8) throw stopSleep('sleep review issues missing or excessive; do not guess edits', 'SLEEP_REVIEW_UNMAPPED')
  for (const raw of issues) {
    const message = String(raw ?? '').trim()
    const match = /^(?:제\s*)?([1-9])\s*장(?:에서는|에서|의|:|：|\s)/.exec(message)
    if (!match || !message || message.length > 1300) throw stopSleep('GPT review issue lacks a single explicit chapter; do not revise blindly', 'SLEEP_REVIEW_UNMAPPED')
    const index = Number(match[1]) - 1
    const old = out.get(index) ?? []
    old.push(message)
    out.set(index, old)
  }
  return out
}
export async function repairSleepClassicChapter(args: {
  index: number
  sentences: LongformSentence[]
  issues: string[]
  before?: string
  after?: string
}, f: Fetcher = fetch): Promise<LongformSentence[]> {
  const c = SLEEP_CHAPTERS[args.index]
  if (!c || !Array.isArray(args.issues) || !args.issues.length || !args.sentences?.length) {
    throw stopSleep('repair requires a valid chapter and explicit GPT findings', 'SLEEP_REPAIR_INVALID')
  }
  const apiKey = process.env.ANTHROPIC_API_KEY || ''
  if (!apiKey) throw stopSleep('Claude key missing for issue-specific repair', 'PROVIDER_AUTH')
  const original = args.sentences.map(s => s.say).join(' ')
  const intro = args.index === 0 ? splitSleepParagraphs([SLEEP_INTRO]) : []
  const before = args.index === 0 ? original.slice(SLEEP_INTRO.length).trim() : original
  const input = [
    '호메로스 오디세이아 제9권 한국어 수면 오디오북: GPT 원전 검증에서 오류가 발견된 이 장만 정확하게 고쳐라.',
    '전체 9장 중 ' + (args.index + 1) + '장: ' + c.heading,
    '유지할 검증된 원전 사건과 순서: ' + c.beats.join(' → '),
    '추가로 반드시 지킬 사실관계: ' + SLEEP_CANON[args.index],
    '독립 GPT 리뷰가 지적한 사실 오류·앞뒤 모순 (모두 수정):\n' + args.issues.join('\n'),
    '직전 장 마지막(중복 금지): ' + String(args.before || '').slice(-750),
    '다음 장 첫머리(앞당겨 쓰지 말 것): ' + String(args.after || '').slice(0, 750),
    '수정 대상 기존 본문(틀리지 않은 서술은 유지하고 틀린 장면만 고쳐 연결하라):\n' + before,
    '환대와 거짓말의 실제 인과를 유지하라. 원전에 없는 직접 인용, 새로운 물건/행동/인물, 지루한 반복은 추가하지 말 것.',
    '글자 수·문단 수·낭독 시간은 제한하지 않는다. 사실 오류가 제거되고 이야기가 매끄럽게 끝나면 된다.',
    args.index === 0 ? '확정된 오프닝은 서버가 따로 보존하므로 결과에 다시 쓰지 마라.' : '',
    '순수 JSON 객체만 반환: {"paragraphs":["수정한 낭독 대본 문단",...]}. 오류 수정 이외의 다른 장면 변경은 하지 않는다.'
  ].filter(Boolean).join('\n')
  const res = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_STORY_MODEL || 'claude-sonnet-5', max_tokens: 7000, messages: [{ role: 'user', content: input }] })
  })
  const raw = await res.text().catch(() => '')
  if (!res.ok) throw stopSleep('Claude targeted story repair HTTP ' + res.status + ' (no automatic repeat)', 'SLEEP_REPAIR_PROVIDER')
  let parsed: any
  try {
    const obj = JSON.parse(raw)
    if (obj.stop_reason === 'max_tokens') throw new Error('truncated')
    const t = (obj.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => String(c.text || '')).join('')
    const m = /\{[\s\S]*\}/.exec(t)
    if (!m) throw new Error('missing JSON')
    parsed = JSON.parse(m[0])
    if (!Array.isArray(parsed.paragraphs) || !parsed.paragraphs.length || parsed.paragraphs.some((x: any) => typeof x !== 'string' || !x.trim())) throw new Error('empty paragraphs')
  } catch { throw stopSleep('Claude targeted story repair returned invalid text; do not retry paid call', 'SLEEP_REPAIR_INVALID') }
  return [...intro, ...splitSleepParagraphs(parsed.paragraphs)]
}
