import fs from 'node:fs';

const path = 'api/claude-longform-revise.ts';
let src = fs.readFileSync(path, 'utf8');

function replaceOnce(from, to, label) {
  if (!src.includes(from)) throw new Error('anchor not found: ' + label);
  src = src.replace(from, to);
}

replaceOnce(
  "    '초안 전체를 새로 창작하는 것이 아니라 GPT QC가 지적한 필수 문제만 정확하게 고친다.',",
  "    '기본은 GPT QC가 지적한 필수 문제만 정확하게 고친다. 단, rewriteMode가 켜진 반복 실패 구간은 기존 문장을 보존하려 하지 말고 해당 문제 구간을 통째로 새로 쓴다.',",
  'system rewrite rule'
);

replaceOnce(
  "    '- warning은 문맥상 필요할 때만 다듬고 좋은 문장은 이유 없이 전면 재작성하지 않는다.',",
  "    '- warning은 문맥상 필요할 때만 다듬고 좋은 문장은 이유 없이 전면 재작성하지 않는다.',\n    '- rewriteMode=true이면 반복된 required/blocker와 연결된 segment/챕터만 폐기 후 재작성한다. 검증된 Fact Pack 밖의 사실을 새로 만들지 않는다.',\n    '- 재작성 대상 밖의 좋은 구간, 제목의 핵심 질문, BM Reference와 Story Map의 큰 흐름은 유지한다.',",
  'rewrite principles'
);

replaceOnce(
  "    '[GPT QC 필수 수정 지시]',",
  "    '[반복 QC 재작성 모드]',\n    JSON.stringify({ rewriteMode: Boolean(input?.rewriteMode), repeatedIssueKeys: Array.isArray(input?.repeatedIssueKeys) ? input.repeatedIssueKeys : [] }, null, 2),\n    '',\n    '[GPT QC 필수 수정 지시]',",
  'rewrite metadata'
);

replaceOnce(
  "    '위 자료만 사용해 정확히 1회 수정본을 작성하라. 새로운 외부 사실을 보충하지 말고, 필요한 부분만 수정한 뒤 동일 JSON 구조만 반환하라.'",
  "    input?.rewriteMode\n      ? '같은 QC 문제가 3회 이상 반복됐다. 반복 문제와 연결된 구간은 기존 문장을 살리려 하지 말고 삭제 후 verifiedFacts·claimsToVerify·sources와 현재 GPT 필수 수정지시만으로 새로 작성하라. 나머지 좋은 구간과 큰 구조는 유지하고 동일 JSON 구조만 반환하라.'\n      : '위 자료만 사용해 정확히 1회 수정본을 작성하라. 새로운 외부 사실을 보충하지 말고, 필요한 부분만 수정한 뒤 동일 JSON 구조만 반환하라.'",
  'final instruction'
);

replaceOnce(
  "      revisionCount: 1",
  "      revisionCount: 1,\n      rewriteMode: Boolean(input?.rewriteMode)",
  'response metadata'
);

fs.writeFileSync(path, src);
console.log('Alpha 33 proxy rewrite mode patch applied');
