import fs from 'node:fs';

const storyFile = 'api/claude-story.ts';
let story = fs.readFileSync(storyFile, 'utf8');
story = story.replace("    '[캐릭터]',\n    '- 그루: 복잡한 경제를 차분하고 쉽게 풀어주는 안내자.',\n    '- 민재: 시청자가 실제로 궁금해할 질문을 대신 묻는 인물.',\n    '- 민재의 질문은 억지 대화가 아니라 설명 전환점에서만 사용한다.',\n    '',\n", "    '[화자 규칙]',\n    '- economy_benchmark 프로필은 기본적으로 단일 중립 내레이션으로 작성한다.',\n    '- 그루, 민재 등 과거 경제그루터기 캐릭터를 자동 등장시키지 않는다.',\n    '- 특정 캐릭터/진행자가 소재나 Master Brief에 명시적으로 지정된 경우에만 사용한다.',\n    '',\n");
story = story.replace('다음 소재로 약 ${targetMinutes}분 분량의 경제그루터기 롱폼 대본을 작성하라.', '다음 소재로 약 ${targetMinutes}분 분량의 경제·생활 설명형 롱폼 대본을 작성하라.');
story = story.replace('- economy_benchmark 프로필이면 특정 고정 캐릭터 대화에 의존하지 말고 내레이션 중심 경제 다큐/설명형으로 작성', '- economy_benchmark 프로필이면 고정 캐릭터를 사용하지 말고 단일 중립 내레이션 중심 경제·생활 설명형으로 작성. speaker는 기본적으로 내레이션을 사용');
fs.writeFileSync(storyFile, story);

const reviseFile = 'api/claude-longform-revise.ts';
let revise = fs.readFileSync(reviseFile, 'utf8');
revise = revise.replace("    '당신은 Content Production Tracker의 경제그루터기 롱폼 대본 수정 작가다.',", "    '당신은 Content Production Tracker의 경제·생활 롱폼 대본 수정 작가다.',");
revise = revise.replace("    '- 원래 제목, 훅, 챕터 수, 챕터 흐름, 그루/민재 역할을 가능한 한 유지한다.',", "    '- 원래 제목, 훅, 챕터 수, 챕터 흐름은 가능한 한 유지한다.',\n    '- economy_benchmark에서는 그루, 민재 등 과거 경제그루터기 캐릭터를 유지하지 않는다. 기존 초안에 섞여 있으면 대화 의존성을 제거하고 중립 내레이션으로 정리한다.',");
revise = revise.replace("    '- 경제그루터기 특성상 원인 → 생활 연결 → 사람마다 결과가 다른 이유 → 변수/대응 시나리오 → 열린 결말 흐름을 유지한다.',", "    '- 경제·생활 설명형 특성상 원인 → 생활 연결 → 사람마다 결과가 다른 이유 → 변수/대응 시나리오 → 열린 결말 흐름을 유지한다.',");
fs.writeFileSync(reviseFile, revise);

console.log('Alpha 35 legacy economy character cleanup applied');
