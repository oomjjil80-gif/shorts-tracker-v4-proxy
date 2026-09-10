const SCREEN_TYPES = [
  'situation', 'comparison', 'cause_effect', 'data_chart', 'timeline_growth',
  'steps', 'document_evidence', 'symbolic', 'single_focus'
] as const

const VISUAL_DIRECTOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'episodeTitle', 'cuts', 'warnings'],
  properties: {
    version: { type: 'string' },
    episodeTitle: { type: 'string' },
    cuts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'chapterNo', 'segmentNo', 'parentTopic', 'sequenceLabel',
          'narration', 'screenGoal', 'screenType', 'pageTitle',
          'visualFocus', 'layoutBrief', 'dataPoints', 'artworkPrompt',
          'trackerOverlay', 'semanticQc'
        ],
        properties: {
          chapterNo: { type: 'integer' },
          segmentNo: { type: 'integer' },
          parentTopic: { type: 'string' },
          sequenceLabel: { type: 'string' },
          narration: { type: 'string' },
          screenGoal: { type: 'string' },
          screenType: { type: 'string', enum: SCREEN_TYPES },
          pageTitle: { type: 'string' },
          visualFocus: { type: 'string' },
          layoutBrief: { type: 'string' },
          dataPoints: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'value', 'role'],
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
                role: { type: 'string', enum: ['primary', 'secondary', 'comparison', 'axis', 'annotation'] }
              }
            }
          },
          artworkPrompt: { type: 'string' },
          trackerOverlay: {
            type: 'object',
            additionalProperties: false,
            required: ['pageTitle', 'dataRequired', 'chartRequired', 'exactText'],
            properties: {
              pageTitle: { type: 'boolean' },
              dataRequired: { type: 'boolean' },
              chartRequired: { type: 'boolean' },
              exactText: { type: 'array', items: { type: 'string' } }
            }
          },
          semanticQc: {
            type: 'object',
            additionalProperties: false,
            required: ['pass', 'reason'],
            properties: {
              pass: { type: 'boolean' },
              reason: { type: 'string' }
            }
          }
        }
      }
    },
    warnings: { type: 'array', items: { type: 'string' } }
  }
} as const

function extractText(data: any) {
  if (typeof data?.output_text === 'string') return data.output_text.trim()
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') return content.text.trim()
    }
  }
  return ''
}

function systemPrompt() {
  return [
    '당신은 Content Production Tracker의 Visual Director다.',
    '대본을 예쁜 이미지 프롬프트로 바꾸는 사람이 아니라 시청자가 소리 없이 화면만 봐도 현재 설명의 핵심을 따라갈 수 있게 각 장면을 설계한다.',
    '',
    '[절대 원칙]',
    '- 기존 CUT 개수나 과거 이미지에 맞추지 않는다. 입력 대본의 완결 의미 단위를 기준으로 설계한다.',
    '- 한 화면에는 시청자가 반드시 이해해야 할 핵심 한 가지를 둔다.',
    '- narration과 화면이 다른 내용을 말하면 semanticQc.pass=false다.',
    '- 멋있지만 설명에 도움이 안 되는 장식 장면을 만들지 않는다.',
    '- 숫자, 퍼센트, 기간, 비교, 단계, 그래프는 이미지 생성 모델에 정확성을 맡기지 않고 Tracker overlay/data engine 대상으로 분리한다.',
    '- artworkPrompt에는 임의 문장, 가짜 숫자, 가짜 표, 워터마크를 넣지 않는다.',
    '',
    '[화면 유형]',
    '- situation: 생활 상황 자체가 핵심일 때.',
    '- comparison: A와 B 차이가 핵심일 때.',
    '- cause_effect: 원인과 결과의 연결이 핵심일 때.',
    '- data_chart: 금액·비율·수치 관계가 핵심일 때.',
    '- timeline_growth: 시간에 따른 증가·감소가 핵심일 때.',
    '- steps: 첫째·둘째·셋째, 단계, 순서가 핵심일 때.',
    '- document_evidence: 정책·제도·공식자료의 존재가 핵심일 때.',
    '- symbolic: 추상 개념을 단순 상징으로 설명할 때.',
    '- single_focus: 하나의 사물·인물·행동만 크게 보여주면 충분할 때.',
    '',
    '[상단 페이지 제목]',
    '- 현재 문장만 줄이지 말고 이전·현재·다음 segment와 chapter 상위 주제를 함께 읽어 현재 위치를 알려주는 제목을 만든다.',
    '- 첫째·둘째·셋째처럼 순서가 있으면 sequenceLabel과 pageTitle에 순서를 보존한다.',
    '- 이미지 자체만으로 의미가 완전히 명확하면 pageTitle은 빈 문자열이 가능하다.',
    '- pageTitle은 보통 8~22자 내외의 짧은 한국어다.',
    '',
    '[경제 설명 화면]',
    '- 월 투자액과 연 증가율처럼 시간 변화가 핵심이면 timeline_growth를 사용하고 연차별 높아지는 자산과 상승 흐름을 배치한다. 정확한 금액·퍼센트는 Tracker overlay로 분리한다.',
    '- 세대·조건 차이는 comparison으로 두 집단을 한 화면에 명확히 대비한다.',
    '- 정책 적용 조건은 document_evidence 또는 data_chart를 쓰고 정확한 문구·수치는 overlay로 분리한다.',
    '- 모바일에서도 핵심이 즉시 읽히도록 큰 형태와 명확한 시선 순서를 사용한다.',
    '- 상단 제목과 핵심 숫자가 들어갈 안전영역을 artworkPrompt에서 비워 둔다.',
    '',
    '[출력]',
    '- 입력 chapter/segment 순서를 보존한다.',
    '- 각 segment마다 screenGoal, screenType, pageTitle, visualFocus, layoutBrief, dataPoints, artworkPrompt, trackerOverlay를 구체적으로 작성한다.',
    '- semanticQc는 해당 설계가 narration의 실제 의미를 정확하게 전달하는지 자체 검수한다.',
    '- 반드시 지정 JSON schema만 출력한다.'
  ].join('\n')
}

function userPrompt(input: any) {
  return [
    '[Episode / Production Master Brief]',
    JSON.stringify(input?.handoff || {}, null, 2),
    '',
    '[Final Longform Draft]',
    JSON.stringify(input?.draft || {}, null, 2),
    '',
    '이 대본을 실제 제작용 Visual Director 계획으로 변환하라.',
    '각 segment를 독립된 의미 화면으로 설계하되 앞뒤 segment와 chapter 맥락을 반드시 함께 읽어라.',
    '정확한 숫자·문자·그래프는 Tracker overlay로 분리하고 artworkPrompt는 장면 자산과 구도에 집중하라.'
  ].join('\n')
}

export async function runVisualDirector(apiKey: string, model: string, input: any) {
  if (!input?.draft || typeof input.draft !== 'object') {
    return { status: 400, body: { ok: false, error: 'Final longform draft is required' } }
  }

  const payload = {
    model,
    store: false,
    reasoning: { effort: 'medium' },
    instructions: systemPrompt(),
    input: userPrompt(input),
    max_output_tokens: 12000,
    text: {
      format: {
        type: 'json_schema',
        name: 'longform_visual_director',
        strict: true,
        schema: VISUAL_DIRECTOR_SCHEMA
      }
    }
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  const raw = await response.text()
  let data: any = {}
  try { data = raw ? JSON.parse(raw) : {} } catch {}
  if (!response.ok) {
    return { status: response.status, body: { ok: false, error: data?.error?.message || raw || 'OpenAI Visual Director request failed' } }
  }

  const text = extractText(data)
  if (!text) return { status: 502, body: { ok: false, error: 'OpenAI response had no text output' } }

  let plan: any
  try { plan = JSON.parse(text) }
  catch { return { status: 502, body: { ok: false, error: 'OpenAI returned invalid Visual Director JSON', rawText: text } } }

  plan.version = plan.version || 'v1'
  return {
    status: 200,
    body: { ok: true, provider: 'OpenAI', model: data?.model || model, plan, usage: data?.usage || null, visualDirector: 'v1' }
  }
}
