// Opt-in, locked Odyssey Book IX bedtime audiobook. No changes to existing Wisdom Shorts or talk planner.
// The nine chapter beats are verified against the public-domain Homer original; Claude writes original Korean narration.
import { openAiLongformPlanner, respond, type LongformPlanner, type LongformOutline } from './longformPlanner.js'
import type { LongformBrief, LongformSentence } from './longform.js'
import { classifyOpenAiError } from './longformResearch.js'

export const SLEEP_CLASSIC_ID = 'odyssey-cyclops-v1'
export const SLEEP_CLASSIC_TITLE = '잠들기 전 듣는 오디세이아 | 아무도 아니다, 외눈박이 거인의 동굴 (1편)'
export const SLEEP_CLASSIC_SOURCE = 'Homer, Odyssey, Book IX (ancient public-domain source; no modern Korean translation)'
export const SLEEP_CHAPTERS = [
  { heading: '이름을 묻는 저녁, 이스마로스', chars: 1500, beats: ['파이아케스 왕 앞에서 오디세우스 실명 공개', '키코네스인 이스마로스 약탈과 마론의 가족을 살려 얻은 포도주', '출항을 거부한 부하들과 반격, 배마다 여섯 명 희생', '죽은 동료의 이름을 세 번 부름과 북풍'] },
  { heading: '연밥의 땅', chars: 900, beats: ['로토파고이에게 보낸 정탐꾼', '연밥을 먹고 귀향할 뜻을 잃음', '울며 버티는 이들을 배로 데려와 묶고 출항'] },
  { heading: '안개 속 염소 섬', chars: 1300, beats: ['키클롭스의 풍습과 법 없이 사는 모습', '무인도 염소 사냥과 포도주 잔치', '건너편에서 들리는 양 울음', '배 한 척과 부하 열두 명 및 마론 포도주를 가져감'] },
  { heading: '돌문이 닫힌 동굴', chars: 2000, beats: ['치즈를 챙겨 떠나자는 부하들', '손님 환대를 기대한 오디세우스가 기다림', '거인이 돌아와 거대한 바위로 입구를 막음', '손님을 보호하는 신을 무시하고 배의 행방을 묻는 거인', '거인이 첫 저녁 부하 두 명을 잡아먹음'] },
  { heading: '첫 번째 밤과 올리브 말뚝', chars: 1800, beats: ['거인을 죽여도 입구 바위를 치울 수 없다는 판단', '이튿날 아침 두 명 추가 희생', '올리브 말뚝을 다듬고 불에 굳혀 거름 아래 숨김', '제비로 부하 네 명을 고르고 자신이 합류함', '두 번째 저녁 양 떼를 모두 동굴에 들임'] },
  { heading: "포도주와 '아무도 아니다'", chars: 1900, beats: ['두 번째 저녁 두 명 더 희생하여 동굴 안에서 합계 여섯 명 사망', '오디세우스가 마론의 포도주를 세 그릇 마시게 함', "거짓 이름을 '아무도 아니다'라고 말함", '맨 마지막에 잡아먹겠다는 끔찍한 선물', '거인이 취해 잠듦'] },
  { heading: '눈먼 거인과 이웃들', chars: 1700, beats: ['다섯 명이 뜨거운 말뚝을 외눈에 박아 돌림; 잔혹한 직접 묘사 금지', '이웃들이 누구에게 당했는지 묻자 아무도 아니다라고 답해 돌아감', '입구 바위를 치우고 손을 뻗어 지키는 거인'] },
  { heading: '양의 배 아래', chars: 1600, beats: ['사흘째 아침, 숫양 세 마리씩 묶고 가운데 한 마리 배 밑에 부하 매달기', '오디세우스는 가장 큰 숫양의 배 털을 잡음', '거인이 등만 만지며 양을 보냄', '맨 마지막 숫양에게 거인이 말을 검', '밖에서 일행이 풀려나 배로 향함'] },
  { heading: '바다 위에서 밝힌 이름', chars: 2600, beats: ['첫 조롱과 첫 돌 투척', '부하들이 위험하니 그만하라고 만류', '이타카의 오디세우스라는 본명을 소리침', '예언자 텔레모스의 예언을 기억하는 거인', '포세이돈에게 귀향 지연·동료 상실·남의 배 귀향·집안 고난을 저주해 달라 기원', '두 번째 바위와 염소 섬 귀환', '제우스가 숫양의 제물을 받지 않고 다음 날 떠남'] }
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
export const sleepChapterLength = (i: number) => SLEEP_CHAPTERS[i]?.chars ?? 0
export function sleepClassicOutline(): LongformOutline {
  return {
    title: SLEEP_CLASSIC_TITLE,
    hook: '잠자리에 누워 듣는 오디세우스의 외눈박이 거인 이야기',
    figure: { name: '오디세우스', imagePrompt: 'A classical Greek stone bust of Odysseus and a closed ancient book resting beside a softly lit night sea; quiet, monochrome charcoal-gray still, no text, no motion, soothing dark atmosphere' },
    thumbnail: { lines: [{ text: '아무도 아니다', color: 'yellow' }, { text: '거인의 동굴', color: 'white' }] },
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
export function createSleepClassicPlanner(f: Fetcher = fetch): LongformPlanner {
  return {
    async outline() { return sleepClassicOutline() },
    async section({ index, previousTail, targetChars, repair }, apiKey) {
      const c = SLEEP_CHAPTERS[index]
      if (!c) throw new Error('unknown locked sleep chapter ' + index)
      const key = process.env.ANTHROPIC_API_KEY || ''
      if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY missing: sleep classic requires Claude, no GPT fallback'), { stop: true, code: 'PROVIDER_AUTH' })
      const input = [
        '고전 수면 청취용 오리지널 한국어 이야기 낭독 대본, 총 9장 중 ' + (index + 1) + '장. 책 번역의 직역/복사는 금지.',
        '원전: ' + SLEEP_CLASSIC_SOURCE, '고정 작품 제목: ' + SLEEP_CLASSIC_TITLE,
        '이 장 제목: ' + c.heading,
        '원전 사건(이 순서 유지, 추가 사건/인물/거짓 대사/명언 금지): ' + c.beats.join(' → '),
        '목표: 공백 제외 약 ' + targetChars + '자. 반복과 억지 분량 채우기 금지, 사건 밀도에 따라 자연스럽게.',
        '차분한 한국 남성 저음으로 낭독할 3인칭 이야기체. 고함/잔혹 상세 묘사/훈계/의미 없는 반복/비유 남발/챕터 명칭·무대 지시·효과음 금지.',
        '다른 장 서사를 미리 진행하거나 되풀이하지 말 것. 전 장 마지막: ' + previousTail.join(' '),
        index === 0 ? '첫 장의 맨 앞은 이미 확정된 90초 도입 대본으로 별도 삽입한다. 도입을 반복하지 말고 이스마로스 사건부터 이어라.' : '이전 장의 인과를 짧게 연결하고 즉시 본 사건으로 이어라.',
        index === 8 ? '포세이돈의 저주까지 다루고 다음날 바다에서 독립된 이야기를 잔잔하게 끝낸다.' : '다음 장 사건은 미리 설명하지 않는다.',
        repair?.length ? '이전 형식 오류: ' + repair.join('; ') : '',
        '순수 JSON 객체만 반환: {"paragraphs":["한글 낭독 문단 1","문단 2",...]}. 문단 하나는 약 200~700자. 자연스러운 문장 끝에서 끊기게 작성.'
      ].filter(Boolean).join('\n')
      const res = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: process.env.ANTHROPIC_STORY_MODEL || 'claude-sonnet-5', max_tokens: 7000, temperature: 0.5,
          messages: [{ role: 'user', content: input }] })
      })
      const raw = await res.text().catch(() => '')
      if (!res.ok) {
        const error = classifyOpenAiError(res.status, raw)
        throw Object.assign(new Error('Claude sleep classic HTTP ' + res.status), { stop: error.stop, code: error.code })
      }
      const obj = JSON.parse(raw)
      const message = (obj.content ?? []).filter((x: any) => x?.type === 'text').map((x: any) => String(x.text || '')).join('')
      const match = /\{[\s\S]*\}/.exec(message)
      if (!match) throw new Error('Claude sleep story returned no JSON')
      const parsed = JSON.parse(match[0])
      if (!Array.isArray(parsed.paragraphs) || !parsed.paragraphs.length || parsed.paragraphs.some((x: any) => typeof x !== 'string' || !x.trim())) throw new Error('Claude sleep paragraphs missing')
      const core = splitSleepParagraphs(parsed.paragraphs)
      const sentences = index === 0 ? [...splitSleepParagraphs([SLEEP_INTRO]), ...core] : core
      const count = [...sentences.map((s) => s.say).join('')].filter((ch) => !/\s/.test(ch)).length
      if (count < targetChars * 0.5 || count > targetChars * 1.7) throw new Error('Claude sleep chapter length out of safe range: ' + count + '/' + targetChars)
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
