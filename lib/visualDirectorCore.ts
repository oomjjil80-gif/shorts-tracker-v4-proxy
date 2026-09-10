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

function clean(v: any) {
  return String(v ?? '').replace(/\s+/g, ' ').trim()
}

function extractText(data: any) {
  if (typeof data?.output_text === 'string') return data.output_text.trim()
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') return content.text.trim()
    }
  }
  return ''
}

function sourceNarrationRows(draft: any) {
  const rows: Array<{ chapterNo: number, segmentNo: number, text: string }> = []
  const hook = clean(draft?.hook)
  if (hook) rows.push({ chapterNo: 0, segmentNo: 0, text: hook })
  const chapters = Array.isArray(draft?.chapters) ? draft.chapters : []
  chapters.forEach((chapter: any, ci: number) => {
    const chapterNo = Number(chapter?.chapterNo || ci + 1)
    const segments = Array.isArray(chapter?.segments) ? chapter.segments : []
    segments.forEach((segment: any, si: number) => {
      const text = clean(segment?.text)
      if (text) rows.push({ chapterNo, segmentNo: si + 1, text })
    })
  })
  const ending = clean(draft?.ending?.text)
  if (ending) rows.push({ chapterNo: 999, segmentNo: 1, text: ending })
  return rows
}

function normalizeForCoverage(text: string) {
  return clean(text).replace(/[\s\u200b]+/g, '').replace(/[“”‘’]/g, '')
}

function validateNarrationCoverage(draft: any, plan: any) {
  const source = normalizeForCoverage(sourceNarrationRows(draft).map((x) => x.text).join(' '))
  const planned = normalizeForCoverage((Array.isArray(plan?.cuts) ? plan.cuts : []).map((x: any) => clean(x?.narration)).join(' '))
  return {
    pass: Boolean(source && source === planned),
    sourceLength: source.length,
    plannedLength: planned.length
  }
}

function enforcePlanIntegrity(draft: any, plan: any) {
  const cuts = Array.isArray(plan?.cuts) ? plan.cuts : []
  const coverage = validateNarrationCoverage(draft, plan)
  if (!coverage.pass) {
    plan.warnings = [
      ...(Array.isArray(plan?.warnings) ? plan.warnings : []),
      `NARRATION_COVERAGE_FAIL source=${coverage.sourceLength} planned=${coverage.plannedLength}`
    ]
    cuts.forEach((cut: any) => {
      cut.semanticQc = { pass: false, reason: '원본 나레이션이 누락·변형되었거나 순서가 바뀌어 제작용 CUT으로 사용할 수 없음' }
    })
  }

  for (let i = 0; i < cuts.length; i += 1) {
    const cut = cuts[i]
    const narration = clean(cut?.narration)
    const goal = clean(cut?.screenGoal)
    const focus = clean(cut?.visualFocus)
    const artwork = clean(cut?.artworkPrompt)
    if (!narration || !goal || !focus || !artwork) {
      cut.semanticQc = { pass: false, reason: '나레이션·화면목적·시각초점·이미지 지시 중 필수 항목이 비어 있음' }
      continue
    }
    const next = cuts[i + 1]
    if (/[,:;·\-–—]$/.test(narration) || /(?:그리고|하지만|그런데|반면|때문에|따라서)$/.test(narration)) {
      cut.semanticQc = { pass: false, reason: 'CUT이 문장 또는 의미가 닫히지 않은 상태에서 끝남' }
      continue
    }
    if (next && clean(next?.narration) === narration) {
      cut.semanticQc = { pass: false, reason: '같은 나레이션 의미 단위가 중복됨' }
    }
  }
  return plan
}

function systemPrompt() {
  return [
    '당신은 Content Production Tracker의 Visual Director다.',
    '대본을 예쁜 이미지 프롬프트로 바꾸는 사람이 아니라 시청자가 소리 없이 화면만 봐도 현재 설명의 핵심을 따라갈 수 있게 각 장면을 설계한다.',
    '',
    '[절대 원칙]',
    '- 기존 CUT 개수나 과거 이미지에 맞추지 않는다. 입력 대본의 완결 의미 단위를 기준으로 CUT 수를 새로 결정한다.',
    '- 입력 segment 하나에 서로 다른 핵심 의미가 2개 이상 있으면 반드시 2개 이상의 CUT으로 분해한다. 이때 같은 segmentNo를 반복 사용해 출처를 보존한다.',
    '- 반대로 짧다는 이유만으로 문장 중간, 원인과 결과 중간, 수식어와 본문 중간을 자르지 않는다.',
    '- narration은 원본 대본에서 정확히 복사한다. 요약·재작성·어순변경·문장 추가·삭제를 금지한다.',
    '- 모든 CUT의 narration을 순서대로 이어 붙였을 때 원본 hook + chapters + ending 전체와 정확히 같아야 한다.',
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
    '- 현재 문장만 줄이지 말고 이전·현재·다음 CUT과 chapter 상위 주제를 함께 읽어 현재 위치를 알려주는 제목을 만든다.',
    '- 첫째·둘째·셋째처럼 순서가 있으면 sequenceLabel과 pageTitle에 순서를 보존한다.',
    '- 이미지 자체만으로 의미가 완전히 명확하면 pageTitle은 빈 문자열이 가능하다.',
    '- pageTitle은 보통 8~22자 내외의 짧은 한국어다.',
    '- pageTitle은 하단 나레이션 자막과 역할이 다르다. 현재 설명의 위치/상위주제를 알려주는 내비게이션 제목이어야 한다.',
    '',
    '[경제 설명 화면]',
    '- 월 투자액과 연 증가율처럼 시간 변화가 핵심이면 timeline_growth를 사용하고 연차별 높아지는 자산과 상승 흐름을 배치한다. 정확한 금액·퍼센트는 Tracker overlay로 분리한다.',
    '- 세대·조건 차이는 comparison으로 두 집단을 한 화면에 명확히 대비한다.',
    '- 정책 적용 조건은 document_evidence 또는 data_chart를 쓰고 정확한 문구·수치는 overlay로 분리한다.',
    '- 추상 경제개념을 억지 상황극으로 바꾸지 않는다. 필요하면 상징·비교·데이터 화면을 사용한다.',
    '- 모바일에서도 핵심이 즉시 읽히도록 큰 형태와 명확한 시선 순서를 사용한다.',
    '- 상단 제목과 핵심 숫자가 들어갈 안전영역을 artworkPrompt에서 비워 둔다.',
    '',
    '[이미지 의미 QC]',
    '- artworkPrompt는 반드시 현재 narration의 실제 의미와 screenGoal을 직접 표현해야 한다.',
    '- narration에 없는 빈곤·파산·폭락·상속·세대갈등 같은 자극 소재를 임의 추가하지 않는다.',
    '- 장면이 narration의 핵심을 1초 안에 설명하지 못하면 semanticQc.pass=false다.',
    '',
    '[출력]',
    '- 입력 chapter/segment 순서를 보존한다.',
    '- 필요하면 한 segment를 여러 CUT으로 분해하되 narration 원문은 연속 구간으로 정확히 분할한다.',
    '- 각 CUT마다 screenGoal, screenType, pageTitle, visualFocus, layoutBrief, dataPoints, artworkPrompt, trackerOverlay를 구체적으로 작성한다.',
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
    '고정 CUT 수를 사용하지 말고 완결 의미 단위로 다시 나눈다. 한 segment 안에 핵심 의미가 여러 개면 여러 CUT으로 분해한다.',
    '각 CUT narration은 원문을 그대로 연속 분할하고 전체 CUT을 합치면 원문 전체가 정확히 복원되어야 한다.',
    '이전/현재/다음 CUT과 chapter 맥락을 함께 읽어 문맥형 상단 제목을 만든다.',
    '정확한 숫자·문자·그래프는 Tracker overlay로 분리하고 artworkPrompt는 현재 나레이션 의미와 직접 일치하는 장면 자산과 구도에 집중하라.'
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
    max_output_tokens: 14000,
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

  plan.version = 'v1.1'
  plan = enforcePlanIntegrity(input.draft, plan)
  const integrityPass = (Array.isArray(plan?.cuts) ? plan.cuts : []).every((x: any) => x?.semanticQc?.pass === true)
  return {
    status: 200,
    body: { ok: true, provider: 'OpenAI', model: data?.model || model, plan, usage: data?.usage || null, visualDirector: 'v1.1', integrityPass }
  }
}
