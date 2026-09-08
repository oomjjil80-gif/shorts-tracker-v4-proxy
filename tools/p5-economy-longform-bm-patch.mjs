import fs from 'node:fs';

function replace(path, from, to) {
  const src = fs.readFileSync(path, 'utf8');
  if (!src.includes(from)) throw new Error(`anchor not found: ${path}: ${from.slice(0,80)}`);
  fs.writeFileSync(path, src.replace(from, to));
}

// Claude Writer: make longform profile/channel-aware and accept BM reference/story map.
replace('api/claude-story.ts',
`function buildSystemPrompt() {\n  return [\n    '당신은 유튜브 콘텐츠 제작 시스템의 전문 대본 작가다.',\n    '현재 채널은 한국어 경제·생활경제 채널 경제그루터기다.',`,
`function buildSystemPrompt() {\n  return [\n    '당신은 유튜브 콘텐츠 제작 시스템의 전문 롱폼 Story Writer다.',\n    '채널 이름보다 콘텐츠의 실제 주제와 longformProfile을 우선한다.',\n    'economy_benchmark 프로필에서는 검증된 성공작의 논증 순서와 시청 유지 구조를 최대한 보존하되 문장·고유 표현·원본 영상 자체를 복제하지 않는다.',\n    '경제, 주거, 직장, 세대, 가족, 생활의 경계 소재를 억지로 한 카테고리에 가두지 않는다.',`);

replace('api/claude-story.ts',
`    '- 롱폼에서도 30~60초마다 새로운 질문·사례·숫자·비교가 등장하도록 구성한다.',`,
`    '- 롱폼에서는 약 60~120초마다 새 질문·반론·데이터·사례·관점 전환 중 하나가 등장해 다음 구간을 볼 이유가 생기게 한다.',\n    '- BM Reference와 Story Map이 제공되면 그것을 자유창작보다 우선하는 설계도로 취급한다.',\n    '- 성공작의 큰 질문 → 소주제 순서 → 반론 → 재해석 → 결론 리듬을 유지한다.',`);

replace('api/claude-story.ts',
`[훅 후보]\n\${JSON.stringify(input?.hookCandidates || [], null, 2)}\n\n[목표]`,
`[훅 후보]\n\${JSON.stringify(input?.hookCandidates || [], null, 2)}\n\n[롱폼 프로필]\n\${String(input?.longformProfile || 'standard')}\n\n[BM Reference]\n\${String(input?.benchmarkReference || '')}\n\n[Story Map — 가능한 한 순서와 기능을 유지]\n\${String(input?.storyMap || '')}\n\n[Primary Category / Secondary Tags]\n\${JSON.stringify({ primaryCategory: input?.primaryCategory || '', secondaryTags: input?.secondaryTags || [] }, null, 2)}\n\n[목표]`);

replace('api/claude-story.ts',
`- 그루 중심 설명\n- 민재는 실제 시청자 질문이 필요한 곳에만 등장\n- 각 챕터가 다음 챕터를 궁금하게 만드는 연결 구조`,
`- economy_benchmark 프로필이면 특정 고정 캐릭터 대화에 의존하지 말고 내레이션 중심 경제 다큐/설명형으로 작성\n- 원본 BM의 큰 질문과 소주제 기능을 유지하되 한국의 사실·사례·데이터로 치환\n- 각 챕터가 답을 하나 주면서 동시에 다음 질문을 열어 다음 챕터를 궁금하게 만드는 연결 구조\n- 시청자 유지에 기여하지 않는 역사·배경 설명을 길게 선행하지 않음`);

// GPT QC: editor-in-chief / retention pass + BM adherence.
replace('api/gpt-script-qc.ts',
`    '[경제그루터기 채널 규칙]',`,
`    '[편집장 / Retention Editor 규칙 — 매 검수마다 초심 환기]',\n    '- 좋은 문장을 칭찬하는 것이 아니라 시청자가 떠날 이유를 먼저 찾는다.',\n    '- 90~120초 분량 동안 질문, 데이터, 사례, 반론, 감정/관점 변화가 전혀 없으면 chapter_flow required 후보로 본다.',\n    '- 결론을 너무 빨리 공개하거나 다음 구간을 볼 질문이 사라지는 지점을 공격적으로 지적한다.',\n    '- BM Reference/Story Map이 제공된 실험에서는 원작의 성공 구조를 이유 없이 창작적으로 바꾼 부분을 지적한다.',\n    '- 제목/핵심 질문이 약속한 문제를 본편이 끝까지 추적하는지 본다.',\n    '',\n    '[경제·생활경제 채널 규칙]',`);

replace('api/gpt-script-qc.ts',
`      contentFormat: input?.handoff?.contentFormat || ''\n    }, null, 2),`,
`      contentFormat: input?.handoff?.contentFormat || '',\n      longformProfile: input?.handoff?.longformProfile || '',\n      primaryCategory: input?.handoff?.primaryCategory || '',\n      secondaryTags: input?.handoff?.secondaryTags || []\n    }, null, 2),\n    '',\n    '[BM Reference]',\n    String(input?.handoff?.benchmarkReference || ''),\n    '',\n    '[Story Map]',\n    String(input?.handoff?.storyMap || ''),`);

console.log('economy longform BM proxy patch applied');
