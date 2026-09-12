import type { Request, Response } from 'express'

function setCors(_req: Request, res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
  res.setHeader('Cache-Control', 'no-store')
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

type ContaminationSignal = {
  kind: string
  sample: string
}

type StructureSignal = {
  kind: string
  location: string
  sample: string
}

function detectContamination(draft: any): ContaminationSignal[] {
  const text = JSON.stringify(draft || {})
  const checks: Array<[string, RegExp]> = [
    ['test_marker', /END_MARK|REMOVE_ME|JUST_KIDDING|KEEP_ME|TEST_MARKER/i],
    ['role_leak', /['"]?role['"]?\s*:\s*['"](?:assistant|system|user)['"]/i],
    ['message_object_leak', /['"]?content['"]?\s*:\s*['"]/i],
    ['prompt_leak', /\b(system prompt|developer message|assistant message|prompt injection)\b/i],
    ['code_fence_leak', /```(?:json|javascript|typescript|python)?/i],
    ['json_fragment_leak', /\{\s*['"](?:role|content|messages)['"]\s*:/i],
    ['abnormal_jamo_repeat', /[ㄱ-ㅎㅏ-ㅣ]{8,}/],
    ['abnormal_symbol_repeat', /([^\p{L}\p{N}\s])\1{7,}/u],
  ]

  const signals: ContaminationSignal[] = []
  for (const [kind, re] of checks) {
    const m = text.match(re)
    if (m) {
      const idx = m.index || 0
      signals.push({
        kind,
        sample: text.slice(Math.max(0, idx - 60), Math.min(text.length, idx + 160))
      })
    }
  }
  return signals
}

function detectStructureSignals(draft: any): StructureSignal[] {
  const signals: StructureSignal[] = []
  const chapters = Array.isArray(draft?.chapters) ? draft.chapters : []

  for (const chapter of chapters) {
    const chapterNo = Number(chapter?.chapterNo || 0)
    const segments = Array.isArray(chapter?.segments) ? chapter.segments : []
    segments.forEach((segment: any, index: number) => {
      const text = String(segment?.text || '').trim()
      const visualHint = String(segment?.visualHint || '').trim()
      const location = `chapter ${chapterNo || '?'} / segment ${index + 1}`

      if (!visualHint) {
        signals.push({ kind: 'missing_visual_hint', location, sample: text.slice(0, 220) })
      }
      if (text.length > 430) {
        signals.push({ kind: 'segment_too_long_for_single_meaning', location, sample: text.slice(0, 260) })
      }
      const sentenceCount = (text.match(/[.!?。！？](?:\s|$)/g) || []).length
      if (sentenceCount >= 6) {
        signals.push({ kind: 'too_many_sentences_in_segment', location, sample: text.slice(0, 260) })
      }
      if (/^(그리고|또한|한편|반면|하지만|그런데)\s*$/.test(text)) {
        signals.push({ kind: 'incomplete_segment', location, sample: text })
      }
    })
  }
  return signals
}

const QC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'summary',
    'scores',
    'issues',
    'verifiedFactCoverage',
    'claimsToVerifyHandling',
    'revisionInstructions',
    'productionReadiness',
    'finalDecision'
  ],
  properties: {
    status: {
      type: 'string',
      enum: ['pass', 'revision_required', 'blocked']
    },
    summary: { type: 'string' },
    scores: {
      type: 'object',
      additionalProperties: false,
      required: [
        'factualGrounding', 'channelFit', 'structure', 'ttsNaturalness',
        'contentDensity', 'causalClarity', 'visualReadiness',
        'retentionStrength', 'curiosityContinuity', 'pacing', 'payoffStrength'
      ],
      properties: {
        factualGrounding: { type: 'integer', minimum: 0, maximum: 100 },
        channelFit: { type: 'integer', minimum: 0, maximum: 100 },
        structure: { type: 'integer', minimum: 0, maximum: 100 },
        ttsNaturalness: { type: 'integer', minimum: 0, maximum: 100 },
        contentDensity: { type: 'integer', minimum: 0, maximum: 100 },
        causalClarity: { type: 'integer', minimum: 0, maximum: 100 },
        visualReadiness: { type: 'integer', minimum: 0, maximum: 100 },
        retentionStrength: { type: 'integer', minimum: 0, maximum: 100 },
        curiosityContinuity: { type: 'integer', minimum: 0, maximum: 100 },
        pacing: { type: 'integer', minimum: 0, maximum: 100 },
        payoffStrength: { type: 'integer', minimum: 0, maximum: 100 }
      }
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'location', 'claim', 'evidence', 'problem', 'recommendation'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'required', 'warning'] },
          category: {
            type: 'string',
            enum: [
              'fact', 'number', 'source', 'verified_fact', 'claim_to_verify',
              'logic', 'tone', 'repetition', 'writing_style', 'hook',
              'chapter_flow', 'open_ending', 'visualization', 'tts',
              'content_density', 'causality', 'segment_boundary', 'mixed_core',
              'hierarchy', 'visual_mismatch', 'production_readiness',
              'contamination', 'format_leak'
            ]
          },
          location: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          problem: { type: 'string' },
          recommendation: { type: 'string' }
        }
      }
    },
    verifiedFactCoverage: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fact', 'result', 'note'],
        properties: {
          fact: { type: 'string' },
          result: { type: 'string', enum: ['supported', 'not_used', 'distorted'] },
          note: { type: 'string' }
        }
      }
    },
    claimsToVerifyHandling: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'result', 'note'],
        properties: {
          claim: { type: 'string' },
          result: { type: 'string', enum: ['safe', 'overstated', 'not_used'] },
          note: { type: 'string' }
        }
      }
    },
    revisionInstructions: {
      type: 'array',
      items: { type: 'string' }
    },
    productionReadiness: {
      type: 'object',
      additionalProperties: false,
      required: ['readyForCutPlanning', 'readyForTts', 'readyForVisualDirector', 'note'],
      properties: {
        readyForCutPlanning: { type: 'boolean' },
        readyForTts: { type: 'boolean' },
        readyForVisualDirector: { type: 'boolean' },
        note: { type: 'string' }
      }
    },
    finalDecision: { type: 'string' }
  }
} as const

function systemPrompt() {
  return [
    '당신은 Content Production Tracker의 독립적인 최종 대본 QC 편집자다.',
    '작성자는 Claude이고, 당신은 작성자가 아니다. 좋은 문장을 이유 없이 다시 쓰지 말고 검수한다.',
    '목표는 문학적 완성도가 아니라 실제 CUT, TTS, 화면 설계로 바로 넘길 수 있는 제작 가능한 최종 나레이션인지 판정하는 것이다.',
    '',
    '[가장 중요한 사실성 원칙]',
    '- verifiedFacts는 현재 입력 안에서 확인된 사실의 기준이다.',
    '- claimsToVerify는 미확정 주장이다. 대본에서 확정 사실처럼 단정되면 반드시 문제로 잡는다.',
    '- sources는 근거 목록이다. 입력 자료가 뒷받침하지 않는 사실을 스스로 만들어 채우지 않는다.',
    '- 입력만으로 확인할 수 없는 외부 사실은 "확인됨"이라고 판정하지 않는다.',
    '- 숫자, 비율, 시행시점, 적용대상, 예외조건은 특히 엄격하게 본다.',
    '',
    '[내용 밀도 / 인과관계 — 필수]',
    '- 추상적인 상식, 분위기 설명, 결론을 표현만 바꾼 반복, 앞 문단을 다시 요약하는 filler는 content_density 또는 repetition required 이슈로 잡는다.',
    '- 중요한 주장 뒤에 시청자가 "왜?"라고 물을 핵심 연결고리가 빠지면 causality required 이슈로 잡는다.',
    '- 주장에는 필요한 범위에서 이유, 대상, 근거/사례, 예외/반론이 붙어 실제 이해가 전진해야 한다.',
    '- 각 segment는 이전 segment보다 새 정보·논리·사례·반론·관점 중 최소 하나를 전진시켜야 한다.',
    '',
    '[segment / CUT 경계 — 필수]',
    '- 한 segment는 하나의 핵심 의미만 담당해야 한다. 서로 독립된 핵심 두 개가 섞이면 mixed_core required 이슈다.',
    '- 문장이나 핵심 의미가 다음 segment에서야 완성되면 segment_boundary required 이슈다.',
    '- 접속어나 전제만 남기고 segment가 끝나는 구조, 다음 segment가 앞 문장의 목적어나 결론을 이어받는 구조를 허용하지 않는다.',
    '- 기존 CUT 개수를 유지하기 위해 의미 단위를 억지로 쪼개거나 합치는 발상을 금지한다.',
    '- 실제 TTS에서 한 segment를 통째로 읽어도 자연스럽게 닫혀야 한다.',
    '',
    '[상위 주제 / 순서 구조 — 필수]',
    '- 여러 원인, 방안, 단계, 조건을 나열할 때는 부모 주제가 먼저 잡혀야 한다.',
    '- 첫째·둘째·셋째 또는 1단계·2단계 같은 순차 항목이면 시청자가 현재 위치를 잃지 않도록 hierarchy를 검수한다.',
    '- 순서가 중요한 항목이 평면적으로 섞여 있으면 hierarchy required 이슈다.',
    '',
    '[Visual Director 준비도 — 필수]',
    '- visualHint는 예쁜 장면 제안이 아니라 현재 narration의 핵심 의미를 화면으로 어떻게 이해시킬지 설명해야 한다.',
    '- narration은 수치 변화인데 visualHint가 단순히 돈을 보는 사람처럼 장식 장면이면 visual_mismatch required 이슈다.',
    '- 비교는 비교 화면, 시간 변화는 단계/추세, 숫자 관계는 데이터 화면, 원인-결과는 인과 구조처럼 정보 성격에 맞는 시각화가 제안되어야 한다.',
    '- 이미지 하나로 설명하기 어려운 추상 경제 개념을 억지 상황극으로 바꾸지 않는다.',
    '- 화면만 봐도 핵심 내용을 따라갈 수 있는 수준으로 후속 Visual Director가 설계 가능한지 판정한다.',
    '',
    '[대본 오염/형식 누출 검사 — 필수]',
    '- 최종 시청자용 대사에 시스템/assistant/user role, JSON 조각, 코드블록, 테스트 마커, 디버그 문자열이 섞이면 반드시 required 이슈로 잡는다.',
    '- END_MARK, REMOVE_ME, JUST_KIDDING, role/content/messages 같은 내부 형식 문자열은 정상 대본으로 인정하지 않는다.',
    '- 주제와 전혀 무관한 문장, 갑작스러운 타 채널/타 인물 대사, 비정상 자모·기호 반복도 contamination 또는 format_leak으로 잡는다.',
    '- contaminationSignals가 하나라도 있으면 status=pass로 판정하지 않는다.',
    '',
    '[편집장 / Retention Editor — 최우선 품질 기준]',
    '- 좋은 문장을 칭찬하는 것이 아니라 시청자가 떠날 이유를 먼저 찾는다.',
    '- 첫 20~40초 안에 영상의 핵심 질문, 시청 이유, 예상 밖의 긴장 또는 구체적 이득이 잡혀야 한다.',
    '- 훅이 질문만 던지고 보상 약속이 없거나, 결론을 너무 빨리 다 말해버려 다음 구간의 궁금증이 사라지면 hook/retention required 이슈다.',
    '- 각 챕터는 최소 하나의 역할을 가져야 한다: 새 사실, 원인 규명, 사례, 반론, 관점 전환, 위험 확대, 해결 조건, 결론 회수. 역할이 없는 챕터는 chapter_role required 이슈다.',
    '- 60~120초 이상 새 정보·질문·사례·반론·감정/관점 변화가 없으면 pacing 또는 retention required 이슈다.',
    '- 챕터 끝은 다음 챕터로 넘어갈 이유가 있어야 한다. 단순 요약으로 닫혀 궁금증이 0이 되면 curiosity_gap required 이슈다.',
    '- 중간마다 작은 답을 주되 더 큰 질문을 남기는 구조를 선호한다. 계속 미루기만 하는 낚시는 금지한다.',
    '- 같은 결론을 표현만 바꿔 반복하거나 이미 이해한 내용을 오래 설명하면 retention/content_density 이슈다.',
    '- 결말은 제목과 훅의 핵심 질문을 반드시 회수해야 하며, 본문에서 쌓은 논리보다 약한 일반론으로 끝나면 payoff required 이슈다.',
    '- BM Reference/Story Map이 제공된 실험에서는 원작의 성공 구조를 이유 없이 창작적으로 바꾼 부분을 지적한다.',
    '- 제목/핵심 질문이 약속한 문제를 본편이 끝까지 추적하는지 본다.',
    '- retentionStrength: 20분 이상 시청을 유지할 전체 견인력.',
    '- curiosityContinuity: 한 구간의 답이 다음 구간의 질문으로 자연스럽게 이어지는 정도.',
    '- pacing: 정보/사례/반론/관점 변화의 속도와 지루한 정체 구간의 부재.',
    '- payoffStrength: 제목·훅의 약속을 결론에서 충분히 회수하는 정도.',
    '',
    '[경제·생활경제 채널 규칙]',
    '- 복잡한 경제 현안을 생활 문제로 쉽게 연결한다.',
    '- 왜 생겼는지 → 내 삶과 어떻게 연결되는지 → 사람마다 결과가 왜 다른지 → 어떤 변수가 있는지 흐름을 선호한다.',
    '- 정치적 주장보다 생활경제 이해를 우선한다.',
    '- 공포·선동·과도한 단정을 피하고 가능한 시각을 여러 개 제시할 수 있다.',
    '- 문어체보다 실제 말하기 좋은 자연스러운 한국어를 쓴다.',
    '- 같은 설명과 AI식 관용구를 반복하지 않는다.',
    '',
    '[제작 준비도 판정]',
    '- readyForCutPlanning=true: 의미 단위가 완결되고 한 segment 한 핵심이며 상위 구조가 명확해야 한다.',
    '- readyForTts=true: 문장 경계가 닫혀 있고 말하기 자연스러우며 다음 segment에 의미가 물리지 않아야 한다.',
    '- readyForVisualDirector=true: 각 segment의 핵심과 visualHint가 일치하고 화면 형태를 설계할 정보가 충분해야 한다.',
    '- 위 세 항목 중 하나라도 false면 status=pass로 판정하지 않는다.',
    '',
    '[최종 판정]',
    '- pass: 게시 전 추가 수정이 필요하지 않고 CUT/TTS/Visual Director로 바로 넘길 수 있는 수준. blocker/required 이슈가 없어야 한다.',
    '- revision_required: Claude가 수정하면 해결 가능한 required 이슈가 하나 이상 있다.',
    '- blocked: 핵심 사실 근거 부족, 상충, 위험한 단정 등 현재 입력만으로 안전하게 고칠 수 없는 blocker가 있다.',
    '- warning만 있다면 pass가 가능하다.',
    '',
    'revisionInstructions는 Claude에게 그대로 전달할 수 있도록 위치, 문제, 수정 방향을 구체적으로 쓴다.',
    '반드시 지정된 JSON schema로만 응답한다.'
  ].join('\n')
}

function userPrompt(input: any, contaminationSignals: ContaminationSignal[], structureSignals: StructureSignal[]) {
  return [
    '[소재 메타데이터]',
    JSON.stringify({
      title: input?.handoff?.title || '',
      summary: input?.handoff?.summary || '',
      whyNow: input?.handoff?.whyNow || '',
      viewerValue: input?.handoff?.viewerValue || '',
      channelKey: input?.handoff?.channelKey || '',
      contentFormat: input?.handoff?.contentFormat || '',
      longformProfile: input?.handoff?.longformProfile || '',
      primaryCategory: input?.handoff?.primaryCategory || '',
      secondaryTags: input?.handoff?.secondaryTags || []
    }, null, 2),
    '',
    '[Production Master Brief]',
    JSON.stringify(input?.handoff?.productionMasterBrief || {}, null, 2),
    '',
    '[BM Reference]',
    String(input?.handoff?.benchmarkReference || ''),
    '',
    '[Story Map]',
    String(input?.handoff?.storyMap || ''),
    '',
    '[verifiedFacts]',
    JSON.stringify(Array.isArray(input?.handoff?.verifiedFacts) ? input.handoff.verifiedFacts : [], null, 2),
    '',
    '[claimsToVerify]',
    JSON.stringify(Array.isArray(input?.handoff?.claimsToVerify) ? input.handoff.claimsToVerify : [], null, 2),
    '',
    '[sources]',
    JSON.stringify(Array.isArray(input?.handoff?.sources) ? input.handoff.sources : [], null, 2),
    '',
    '[deterministic contaminationSignals]',
    JSON.stringify(contaminationSignals, null, 2),
    '',
    '[deterministic structureSignals — 자동 참고 신호이며 최종 의미 판정은 직접 수행]',
    JSON.stringify(structureSignals, null, 2),
    '',
    '[Claude Longform Draft]',
    JSON.stringify(input?.draft || {}, null, 2),
    '',
    '위 자료만을 근거로 대본 전체를 검수하라. 근거가 없는 내용을 외부 지식으로 확정하지 말라.',
    '내용 밀도, 인과관계, segment 완결성, 한 segment 한 핵심, 상위주제/순서, visualHint-나레이션 의미 일치를 모두 검사하라.',
    '현재 원고가 실제 제작용 최종 나레이션으로 바로 CUT/TTS/Visual Director 단계에 넘어갈 수 있는지 엄격하게 판정하라.',
    '특히 첫 30초 훅, 챕터별 역할, 60~120초 단위의 변화, 챕터 사이 궁금증 연결, 마지막 payoff를 별도로 점검하라.',
    'retentionStrength, curiosityContinuity, pacing, payoffStrength는 각각 100점 만점으로 냉정하게 채점하라.',
    'contaminationSignals가 있으면 반드시 issues와 revisionInstructions에 반영하고 pass로 판정하지 말라.'
  ].join('\n')
}

function enforceContamination(qc: any, signals: ContaminationSignal[]) {
  if (!signals.length || !qc || typeof qc !== 'object') return qc

  const issues = Array.isArray(qc.issues) ? qc.issues : []
  const already = issues.some((x: any) => ['contamination', 'format_leak'].includes(String(x?.category || '')))

  if (!already) {
    issues.unshift({
      severity: 'required',
      category: 'contamination',
      location: 'Claude Longform Draft',
      claim: '대본 내부에 시청자용 대사와 무관한 내부 형식/테스트 문자열이 포함됨',
      evidence: signals.map((s) => `${s.kind}: ${s.sample}`).join(' | ').slice(0, 1600),
      problem: '프롬프트·메시지 객체·테스트 마커·비정상 반복 문자열이 최종 대본에 노출되면 그대로 게시하거나 CUT 변환할 수 없습니다.',
      recommendation: '오염된 segment 또는 ending을 삭제 후 앞뒤 문맥에 맞는 정상 한국어 대사로 다시 작성하고 내부 role/content/JSON/테스트 문자열을 모두 제거합니다.'
    })
  }
  qc.issues = issues

  const revisions = Array.isArray(qc.revisionInstructions) ? qc.revisionInstructions : []
  const instruction = '대본 전체에서 내부 role/content/JSON 조각, 테스트 마커, 디버그 문자열, 주제와 무관한 문장, 비정상 반복문자를 제거하고 오염된 구간은 앞뒤 문맥에 맞는 정상 대사로 다시 작성한다.'
  if (!revisions.some((x: any) => String(x).includes('내부 role/content/JSON'))) revisions.unshift(instruction)
  qc.revisionInstructions = revisions

  if (qc.status === 'pass') qc.status = 'revision_required'
  if (qc.productionReadiness && typeof qc.productionReadiness === 'object') {
    qc.productionReadiness.readyForCutPlanning = false
    qc.productionReadiness.readyForTts = false
    qc.productionReadiness.readyForVisualDirector = false
  }
  qc.summary = `대본 오염/형식 누출이 감지되어 수정이 필요합니다. ${String(qc.summary || '')}`.trim()
  return qc
}

function enforceEditorialScores(qc: any) {
  if (!qc || typeof qc !== 'object') return qc
  const scores = qc.scores || {}
  const checks = [
    ['retentionStrength', 'retention', '시청 유지력'],
    ['curiosityContinuity', 'curiosity_gap', '궁금증 연결'],
    ['pacing', 'pacing', '전개 속도'],
    ['payoffStrength', 'payoff', '결말 회수력']
  ] as const
  const weak = checks.filter(([key]) => Number(scores[key]) < 80)
  if (!weak.length) return qc

  qc.issues = Array.isArray(qc.issues) ? qc.issues : []
  qc.revisionInstructions = Array.isArray(qc.revisionInstructions) ? qc.revisionInstructions : []

  for (const [key, category, label] of weak) {
    const score = Number(scores[key])
    if (!qc.issues.some((x:any) => String(x?.category||'') === category)) {
      qc.issues.push({
        severity:'required',
        category,
        location:'대본 전체',
        claim:`${label} 점수 ${Number.isFinite(score) ? score : 0}/100`,
        evidence:'편집장 QC 점수 기준 80점 미만',
        problem:`${label}가 기준 미달이라 장편 영상의 이탈 위험이 높습니다.`,
        recommendation:'문제 구간만 재작성해 새 정보·질문·사례·반론·관점 변화 또는 결론 회수를 강화합니다.'
      })
    }
    const instruction = `${label}를 80점 이상으로 올린다. 좋은 구간은 유지하고 이탈 위험 구간만 압축·재배치·재작성한다.`
    if (!qc.revisionInstructions.some((x:any)=>String(x).includes(label))) qc.revisionInstructions.push(instruction)
  }
  if (qc.status === 'pass') qc.status = 'revision_required'
  return qc
}

function enforceStructureSignals(qc: any, signals: StructureSignal[]) {
  if (!signals.length || !qc || typeof qc !== 'object') return qc
  const hardSignals = signals.filter((s) => s.kind === 'incomplete_segment' || s.kind === 'missing_visual_hint')
  if (!hardSignals.length) return qc

  const issues = Array.isArray(qc.issues) ? qc.issues : []
  for (const signal of hardSignals) {
    const category = signal.kind === 'missing_visual_hint' ? 'visualization' : 'segment_boundary'
    const exists = issues.some((x: any) => String(x?.category) === category && String(x?.location) === signal.location)
    if (!exists) {
      issues.push({
        severity: 'required',
        category,
        location: signal.location,
        claim: signal.kind === 'missing_visual_hint' ? '화면 설계 정보가 비어 있음' : 'segment가 완결 의미 단위로 닫히지 않음',
        evidence: signal.sample,
        problem: signal.kind === 'missing_visual_hint'
          ? 'Visual Director가 narration과 일치하는 화면을 설계할 근거가 없습니다.'
          : '이 상태로 CUT/TTS 경계를 만들면 다음 CUT과 의미가 물릴 수 있습니다.',
        recommendation: signal.kind === 'missing_visual_hint'
          ? '해당 narration의 핵심을 실제로 이해시키는 화면 유형과 핵심 시각요소를 visualHint에 명시합니다.'
          : '앞뒤 문맥을 합치거나 다시 나눠 이 segment 자체가 완결된 문장과 의미로 끝나게 수정합니다.'
      })
    }
  }
  qc.issues = issues
  if (qc.status === 'pass') qc.status = 'revision_required'
  return qc
}


// GPT longform revise/finalize fallback is intentionally merged here to stay within Vercel function limits.
const LONGFORM_DRAFT_SCHEMA = {
  type:'object',
  additionalProperties:false,
  required:['title','hook','targetMinutes','chapters','ending','shortsSpinOff','warnings'],
  properties:{
    title:{type:'string'},
    hook:{type:'string'},
    targetMinutes:{type:'integer'},
    chapters:{type:'array',items:{
      type:'object',additionalProperties:false,required:['chapterNo','title','purpose','segments'],
      properties:{
        chapterNo:{type:'integer'},
        title:{type:'string'},
        purpose:{type:'string'},
        segments:{type:'array',items:{
          type:'object',additionalProperties:false,required:['speaker','text','visualHint','factStatus'],
          properties:{
            speaker:{type:'string'},
            text:{type:'string'},
            visualHint:{type:'string'},
            factStatus:{type:'string',enum:['verified','interpretation','verify_before_publish']}
          }
        }}
      }
    }},
    ending:{type:'object',additionalProperties:false,required:['speaker','text'],properties:{speaker:{type:'string'},text:{type:'string'}}},
    shortsSpinOff:{type:'array',items:{type:'string'}},
    warnings:{type:'array',items:{type:'string'}}
  }
} as const

function revisionPrompt(input:any, finalize=false) {
  const handoff=input?.handoff||{}
  const draft=input?.draft||{}
  const qc=input?.qc||{}
  const requiredIssues=(Array.isArray(qc?.issues)?qc.issues:[])
    .filter((x:any)=>['blocker','required'].includes(String(x?.severity||'').toLowerCase()))
  return [
    '당신은 경제·생활 롱폼 대본 수정 작가다.',
    '새로운 외부 사실을 만들지 말고 제공된 handoff, Fact Pack, 원고, QC 지시만 사용한다.',
    '',
    '[handoff]',
    JSON.stringify(handoff,null,2),
    '',
    '[QC revision instructions]',
    JSON.stringify(Array.isArray(qc?.revisionInstructions)?qc.revisionInstructions:[],null,2),
    '',
    '[QC required/blocker issues]',
    JSON.stringify(requiredIssues,null,2),
    '',
    '[draft]',
    JSON.stringify(draft,null,2),
    '',
    finalize
      ? '실제 제작 직전 최종 정리다. 제목·훅·챕터 순서·검증된 사실을 유지하고 모든 speaker를 내레이션으로 통일한다. TTS에 자연스럽게 다듬되 새 사실이나 숫자를 추가하지 않는다. 동일 JSON 구조만 반환한다.'
      : 'QC가 요구한 문제만 정확히 수정한다. 근거가 부족한 주장은 삭제·완화하거나 verify_before_publish로 남긴다. 좋은 구간은 이유 없이 전면 재작성하지 않는다. 동일 JSON 구조만 반환한다.'
  ].join('\n')
}

export default async function handler(req: Request, res: Response) {
  setCors(req, res)

  if (req.method === 'OPTIONS') return res.status(204).end()

  const apiKey = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_QC_MODEL || 'gpt-5.6-terra'

  if (req.method === 'GET') {
    return res.status(apiKey ? 200 : 503).json({
      ok: Boolean(apiKey),
      provider: 'OpenAI',
      model,
      keyConfigured: Boolean(apiKey),
      task: 'longform_script_qc',
      contaminationGuard: 'v1',
      productionQc: 'v3-retention-editor'
    })
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
  if (!apiKey) return res.status(503).json({ ok: false, error: 'OPENAI_API_KEY is not configured' })

  const input = req.body?.input || {}
  const test = Boolean(req.body?.test)
  const mode = String(req.body?.mode || '')

  if ((mode === 'revise' || mode === 'finalize') && input?.draft && typeof input.draft === 'object') {
    if (mode === 'revise' && (!input?.qc || input.qc.status !== 'revision_required')) {
      return res.status(409).json({ ok:false, error:`Revision is not allowed for QC status: ${String(input?.qc?.status || 'unknown')}` })
    }
    try {
      const payload:any = {
        model,
        store:false,
        reasoning:{ effort:'medium' },
        instructions:'한국어 롱폼 대본을 수정한다. 제공된 사실과 QC 지시만 사용하고 지정된 JSON Schema를 정확히 따른다.',
        input:revisionPrompt(input, mode === 'finalize'),
        max_output_tokens:16000,
        text:{format:{type:'json_schema',name:'longform_script_revision',strict:true,schema:LONGFORM_DRAFT_SCHEMA}}
      }
      const response = await fetch('https://api.openai.com/v1/responses',{
        method:'POST',
        headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
        body:JSON.stringify(payload)
      })
      const raw=await response.text()
      let data:any={}
      try{data=raw?JSON.parse(raw):{}}catch{}
      if(!response.ok) return res.status(response.status).json({ok:false,error:data?.error?.message || raw || 'OpenAI revision failed'})
      const text=extractText(data)
      if(!text) return res.status(502).json({ok:false,error:'OpenAI revision response had no text output'})
      let draft:any
      try{draft=JSON.parse(text)}catch{return res.status(502).json({ok:false,error:'OpenAI revision returned invalid JSON',rawText:text})}
      return res.status(200).json({
        ok:true,
        provider:'OpenAI',
        model:data?.model || model,
        draft,
        usage:data?.usage || null,
        revisionCount:mode === 'finalize' ? 0 : 1,
        finalizeForProduction:mode === 'finalize'
      })
    } catch(error:any) {
      return res.status(500).json({ok:false,error:error?.message || String(error)})
    }
  }

  if (!test && (!input?.draft || typeof input.draft !== 'object')) {
    return res.status(400).json({ ok: false, error: 'Claude longform draft is required' })
  }

  try {
    const contaminationSignals = test ? [] : detectContamination(input?.draft)
    const structureSignals = test ? [] : detectStructureSignals(input?.draft)

    const payload: any = test
      ? {
          model,
          store: false,
          input: 'Content Production Tracker GPT QC 연결 테스트입니다. 한국어로 "GPT QC API 연결 성공"이라고만 답하세요.',
          max_output_tokens: 64
        }
      : {
          model,
          store: false,
          reasoning: { effort: 'medium' },
          instructions: systemPrompt(),
          input: userPrompt(input, contaminationSignals, structureSignals),
          max_output_tokens: 7500,
          text: {
            format: {
              type: 'json_schema',
              name: 'longform_script_qc',
              strict: true,
              schema: QC_SCHEMA
            }
          }
        }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    const raw = await response.text()
    let data: any = {}
    try { data = raw ? JSON.parse(raw) : {} } catch {}

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: data?.error?.message || raw || 'OpenAI API request failed'
      })
    }

    const text = extractText(data)
    if (!text) return res.status(502).json({ ok: false, error: 'OpenAI response had no text output' })

    if (test) {
      return res.status(200).json({
        ok: true,
        provider: 'OpenAI',
        model: data?.model || model,
        text,
        usage: data?.usage || null,
        contaminationGuard: 'v1',
        productionQc: 'v3-retention-editor'
      })
    }

    let qc: any
    try {
      qc = JSON.parse(text)
    } catch {
      return res.status(502).json({ ok: false, error: 'OpenAI returned invalid QC JSON', rawText: text })
    }

    qc = enforceContamination(qc, contaminationSignals)
    qc = enforceStructureSignals(qc, structureSignals)
    qc = enforceEditorialScores(qc)

    if (qc?.productionReadiness && (
      qc.productionReadiness.readyForCutPlanning !== true ||
      qc.productionReadiness.readyForTts !== true ||
      qc.productionReadiness.readyForVisualDirector !== true
    ) && qc.status === 'pass') {
      qc.status = 'revision_required'
    }

    return res.status(200).json({
      ok: true,
      provider: 'OpenAI',
      model: data?.model || model,
      qc,
      usage: data?.usage || null,
      contaminationSignals,
      structureSignals,
      contaminationGuard: 'v1',
      productionQc: 'v3-retention-editor'
    })
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
}
