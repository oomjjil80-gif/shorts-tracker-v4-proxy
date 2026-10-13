// 제작 6단계: 제목·썸네일 약속 잠금 → Claude 집필(승인 전 차단) → GPT 독립 검수 → 문제 구간만 수정 → 최종본 약속 확인.
// fetch는 stand-in (유료 AI 호출 없음). Run: node --import tsx --test tools/title-promise.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import claudeStoryHandler from '../api/claude-story.js'
import qcHandler from '../api/gpt-script-qc.js'
import reviseHandler from '../api/claude-longform-revise.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { lockTitlePromise, issueTitlePromise, verifyPromise, finalPromiseCheck, checkDraftAgainstPromise, revisionTargets, parseLocation, mergePartial, rescopeLocations, filterIssuesToScope } from '../lib/story/titlePromise.js'

process.env.OPENAI_API_KEY ||= 'test-openai-key'
process.env.ANTHROPIC_API_KEY ||= 'test-anthropic-key'
process.env.TITLE_PROMISE_SECRET = 'test-promise-secret-0123456789'

const INPUT = { title: '월급날 통장이 비는 진짜 이유', thumbnail: { concept: '월급이 자동이체로 빠져나가는 텅 빈 통장', lines: ['월급이', '사라진 이유'] }, coreEvent: '월급이 들어오자마자 자동이체로 빠져나가는 구조를 실제 통장 내역으로 보여준다', mustShow: ['자동이체', '통장 내역'] }
const lock = () => { const r = issueTitlePromise(INPUT, new Date('2026-10-13T00:00:00Z')); assert.equal(r.ok, true); return (r as any).promise }
const seg = (text: string) => ({ speaker: '내레이션', text, visualHint: `v:${text.slice(0, 6)}`, factStatus: 'interpretation' })
const DRAFT = () => ({ title: INPUT.title, hook: '월급이 들어오면 자동이체가 먼저 가져갑니다.', targetMinutes: 5,
  chapters: [
    { chapterNo: 1, title: 'a', purpose: 'p', segments: [seg('통장 내역을 열어보면 첫 줄부터 이상합니다.'), seg('월세와 보험료가 같은 날 빠집니다.'), seg('남는 돈은 생각보다 적습니다.')] },
    { chapterNo: 2, title: 'b', purpose: 'p', segments: [seg('자동이체 목록을 정리해야 합니다.'), seg('하나씩 해지하면 달라집니다.')] }
  ], ending: { speaker: '내레이션', text: '오늘 자동이체 목록부터 열어보세요.' }, shortsSpinOff: [], warnings: [] })

function fakeFetch(respond: (url: string, body: any) => any) {
  const calls: Array<{ url: string; body: any }> = []
  const f = async (url: any, init: any) => {
    const body = JSON.parse(init.body); calls.push({ url: String(url), body })
    const r = respond(String(url), body)
    if (String(url).includes('anthropic')) return new Response(JSON.stringify({ model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(r) }] }), { status: 200 })
    return new Response(JSON.stringify({ model: 'gpt-test', output_text: JSON.stringify(r) }), { status: 200 })
  }
  return { f, calls }
}
async function call(handler: any, body: any, respond: (url: string, body: any) => any = () => ({})) {
  const { f, calls } = fakeFetch(respond), orig = globalThis.fetch; (globalThis as any).fetch = f
  try {
    let status = 0, json: any = null
    const req: any = { method: 'POST', headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': 'k'.repeat(32) }, query: {}, body }
    const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this }, send(b: any) { json = b; return this } }
    await handler(req, res); return { status, json, calls }
  } finally { (globalThis as any).fetch = orig }
}
const QC_PASS = { status: 'pass', summary: 's', scores: {}, issues: [], verifiedFactCoverage: [], claimsToVerifyHandling: [], revisionInstructions: [], productionReadiness: { readyForCutPlanning: true, readyForTts: true, readyForVisualDirector: true, note: '' }, finalDecision: '' }
const iss = (category: string, location: string, severity = 'required') => ({ severity, category, location, claim: 'c', evidence: 'e', problem: 'p', recommendation: 'r' })

test('1 lock: validated + stable promiseId; a promise that names nothing visible, or a tampered one, is not approved', () => {
  const p = lock(); assert.match(p.promiseId, /^tp_[0-9a-f]{24}$/); assert.equal(verifyPromise(p), true)
  assert.equal(lock().promiseId, p.promiseId, 'same content -> same id')
  assert.equal(lockTitlePromise({ ...INPUT, mustShow: ['전혀다른단어'] }).ok, false, 'core event must be visible in title/thumbnail')
  assert.equal(lockTitlePromise({ ...INPUT, coreEvent: '짧음' }).ok, false)
  assert.equal(verifyPromise({ ...p, title: '다른 제목입니다 정말로' }), false); assert.equal(verifyPromise(null), false)
})

test('1b approval integrity: only the server-signed approval counts; a client-rebuilt (self-consistent sha256) promise, a swapped signature or a changed approvedAt is rejected; no secret = fail closed', () => {
  const p = lock(), rebuilt = (lockTitlePromise(INPUT, new Date('2026-10-13T00:00:00Z')) as any).promise // 내용·식별자는 맞지만 서명이 없다
  assert.equal(rebuilt.signature, undefined); assert.equal(verifyPromise(rebuilt), false, 'client-side rebuild is not an approval')
  assert.equal(verifyPromise({ ...rebuilt, signature: 'a'.repeat(64) }), false, 'made-up signature')
  assert.equal(verifyPromise({ ...p, approvedAt: '2030-01-01T00:00:00.000Z' }), false, 'approvedAt is signed')
  assert.equal(verifyPromise({ ...p, signature: p.signature.slice(0, -2) + (p.signature.endsWith('00') ? '11' : '00') }), false)
  assert.equal(verifyPromise(p, 'another-server-secret-0000'), false, 'signed by a different secret')
  assert.equal(verifyPromise(p, null), false, 'no secret configured -> nothing verifies')
  assert.equal((issueTitlePromise(INPUT, new Date(), null) as any).code, 'PROMISE_SIGNING_NOT_CONFIGURED')
  assert.equal(verifyPromise(p), true)
})

test('2 Claude: promiseFlow without an approved promise never reaches Claude (409, 0 calls); with it the prompt carries the promiseId; legacy requests are untouched', async () => {
  const draft = DRAFT()
  const blocked = await call(claudeStoryHandler, { input: { promiseFlow: true, title: 't' } }, () => draft)
  assert.equal(blocked.status, 409); assert.equal(blocked.json.error.code, 'PROMISE_NOT_APPROVED'); assert.equal(blocked.calls.length, 0)
  const p = lock()
  const forged = await call(claudeStoryHandler, { input: { promiseFlow: true, approvedPromise: { ...p, coreEvent: '위조된 핵심 사건입니다 위조' } } }, () => draft)
  assert.equal(forged.status, 409); assert.equal(forged.calls.length, 0)
  const ok = await call(claudeStoryHandler, { input: { promiseFlow: true, approvedPromise: p, title: '소재', summary: 's', targetMinutes: 5, chapterCount: 3 } }, () => draft)
  assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.calls.length, 1)
  const sent = ok.calls[0].body.messages[0].content
  assert.ok(sent.includes(p.promiseId) && sent.includes(p.title) && sent.includes('자동이체'), 'title, core event and promiseId reach the Claude prompt')
  const legacy = await call(claudeStoryHandler, { input: { title: '소재', summary: 's', targetMinutes: 5, chapterCount: 3 } }, () => draft)
  assert.equal(legacy.status, 200); assert.ok(!legacy.calls[0].body.messages[0].content.includes('tp_'), 'no promise -> prompt unchanged')
})

test('3 GPT QC: promise reaches the QC prompt; model findings keep severity (not downgraded); deterministic checks add what the model missed; ids echoed', async () => {
  const p = lock(), draft = DRAFT(); draft.title = '바뀐 제목입니다 정말로'; draft.chapters[0].segments[0].text = '월급 이야기를 해봅니다.'; draft.hook = '월급 얘기입니다.'
  const r = await call(qcHandler, { input: { draft, approvedPromise: p, handoff: { title: 't' } } }, () => ({ ...QC_PASS, issues: [iss('thumbnail_overclaim', 'chapter 1 / segment 2'), iss('fact', 'chapter 2 / segment 1')] }))
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const sent = r.calls[0].body.input; assert.ok(sent.includes(p.promiseId) && sent.includes('thumbnail_overclaim') && sent.includes('repeat_video'), 'promise + 5 checks in the QC prompt')
  const q = r.json.qc
  assert.equal(q.status, 'revision_required'); assert.equal(q.promise.promiseId, p.promiseId)
  const promiseIssues = q.issues.filter((x: any) => ['title_promise', 'thumbnail_overclaim'].includes(x.category))
  assert.ok(promiseIssues.every((x: any) => x.severity === 'required'), 'promise issues are not downgraded to warnings')
  assert.ok(promiseIssues.some((x: any) => x.location === 'title') && promiseIssues.some((x: any) => x.category === 'thumbnail_overclaim'))
  assert.equal(q.issues.find((x: any) => x.category === 'fact').severity, 'warning', 'ordinary editorial issues keep the existing advisory policy')
  // no promise -> exactly the old behaviour
  const old = await call(qcHandler, { input: { draft: DRAFT(), handoff: { title: 't' } } }, () => ({ ...QC_PASS, issues: [iss('fact', 'chapter 1 / segment 1')] }))
  assert.equal(old.json.qc.status, 'pass'); assert.equal(old.json.qc.promise, undefined); assert.ok(!old.calls[0].body.input.includes('tp_'))
})

test('4 location mapping + partial merge: only the failing segments change; title is restored to the approved one; other segments are byte-identical', () => {
  const d = DRAFT()
  assert.deepEqual(parseLocation('chapter 1 / segment 2', d)!.map((t) => t.key), ['c1s2']); assert.deepEqual(parseLocation('hook', d)!.map((t) => t.key), ['hook'])
  assert.deepEqual(parseLocation('chapter 2', d)!.map((t) => t.key), ['c2s1', 'c2s2']); assert.equal(parseLocation('chapter 9 / segment 1', d), null); assert.equal(parseLocation('전체 구조', d), null)
  const plan = revisionTargets([iss('repeat_video', 'chapter 1 / segment 2') as any, iss('immersion', 'hook') as any, iss('title_promise', 'title') as any, iss('fact', 'chapter 2 / segment 1', 'warning') as any], d)
  assert.deepEqual(plan.targets.map((t) => t.key).sort(), ['c1s2', 'hook']); assert.equal(plan.titleRestore, true); assert.equal(plan.partial, true)
  assert.equal(revisionTargets([iss('logic', '전체 구조') as any], d).partial, false, 'unmappable issue -> full revision fallback')
  const m = mergePartial(d, [{ target: 'c1s2', text: '월세와 보험료가 자동이체로 같은 날 빠집니다.', visualHint: 'new', factStatus: 'verified' }, { target: 'c2s2', text: '범위 밖 수정 시도' }, { target: 'hook', text: '월급날 통장 내역부터 보겠습니다. 자동이체가 먼저 가져갑니다.' }], plan.targets)
  assert.deepEqual(m.changed.sort(), ['c1s2', 'hook']); assert.deepEqual(m.ignored, ['c2s2'])
  assert.deepEqual(m.draft.chapters[1], d.chapters[1], 'untouched chapter identical'); assert.deepEqual(m.draft.chapters[0].segments[0], d.chapters[0].segments[0]); assert.deepEqual(m.draft.chapters[0].segments[2], d.chapters[0].segments[2])
  assert.equal(m.draft.chapters[0].segments[1].visualHint, 'new'); assert.deepEqual(d, DRAFT(), 'input not mutated')
  assert.deepEqual(rescopeLocations(['c1s2'], d).sort(), ['chapter 1 / segment 1', 'chapter 1 / segment 2', 'chapter 1 / segment 3', 'title'])
  assert.equal(filterIssuesToScope([iss('fact', 'chapter 2 / segment 1') as any, iss('immersion', 'chapter 1 / segment 3') as any], rescopeLocations(['c1s2'], d)).length, 1)
})

test('5 revise_partial: ONE small GPT call returns only the failing pieces; title restored; scope + assets reported; unmappable issues ask for the legacy full revise', async () => {
  const p = lock(), d = DRAFT(); d.title = '바뀐 제목입니다 정말로'
  const qc = { ...QC_PASS, status: 'revision_required', issues: [iss('repeat_video', 'chapter 1 / segment 2'), iss('title_promise', 'title')] }
  const r = await call(qcHandler, { mode: 'revise_partial', input: { draft: d, qc, approvedPromise: p, handoff: {} } }, () => ({ items: [{ target: 'c1s2', text: '월세와 보험료가 자동이체로 같은 날 빠집니다.', visualHint: 'v2', factStatus: 'interpretation' }] }))
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].body.text.format.name, 'longform_partial_revision')
  assert.ok(r.calls[0].body.input.includes('c1s2') && !r.calls[0].body.input.includes('하나씩 해지하면'), 'only the target (and its neighbours) are sent, not the whole script')
  assert.equal(r.json.scope, 'partial'); assert.deepEqual(r.json.revisedTargets, ['c1s2']); assert.equal(r.json.draft.title, p.title); assert.equal(r.json.promiseId, p.promiseId)
  assert.equal(r.json.draft.chapters[0].segments[1].text, '월세와 보험료가 자동이체로 같은 날 빠집니다.'); assert.deepEqual(r.json.draft.chapters[1], d.chapters[1])
  assert.ok(r.json.qcScope.includes('chapter 1 / segment 3'))
  // title-only failure: fixed deterministically, ZERO model calls
  const t = await call(qcHandler, { mode: 'revise_partial', input: { draft: d, qc: { ...QC_PASS, status: 'revision_required', issues: [iss('title_promise', 'title')] }, approvedPromise: p } })
  assert.equal(t.calls.length, 0); assert.equal(t.json.draft.title, p.title); assert.deepEqual(t.json.revisedTargets, [])
  // unmappable -> full revise needed; no model call
  const u = await call(qcHandler, { mode: 'revise_partial', input: { draft: d, qc: { ...QC_PASS, status: 'revision_required', issues: [iss('logic', '전체 구조')] }, approvedPromise: p } })
  assert.equal(u.json.scope, 'manual_required'); assert.equal(u.calls.length, 0); assert.match(u.json.reason, /automatic whole-script rewrite is not performed/)
  // whole-draft rewrite with an approved promise needs the user's explicit confirmation (never automatic)
  const noConfirm = await call(qcHandler, { mode: 'revise', input: { draft: d, qc, approvedPromise: p, handoff: {} } }, () => d)
  assert.equal(noConfirm.status, 409); assert.equal(noConfirm.json.error.code, 'FULL_REWRITE_NOT_CONFIRMED'); assert.equal(noConfirm.calls.length, 0)
  const confirmed = await call(qcHandler, { mode: 'revise', input: { draft: d, qc, approvedPromise: p, confirmFullRewrite: true, handoff: {} } }, () => d)
  assert.equal(confirmed.status, 200); assert.equal(confirmed.calls.length, 1)
  // legacy revise path (no promise) is unchanged (whole-draft schema)
  const legacy = await call(qcHandler, { mode: 'revise', input: { draft: d, qc, handoff: {} } }, () => d)
  assert.equal(legacy.json.draft.title, d.title); assert.equal(legacy.calls[0].body.text.format.name, 'longform_script_revision')
})

test('6 scoped re-QC: only the revised scope is re-judged, but earlier unresolved required issues outside it are kept (never silently dropped to PASS); deterministic promise checks are never scoped away', async () => {
  const p = lock(), d = DRAFT(), scope = rescopeLocations(['c1s2'], d)
  const prior = [iss('immersion', 'chapter 2 / segment 2'), iss('repeat_video', 'chapter 1 / segment 2'), iss('logic', '전체 구조')]
  const r = await call(qcHandler, { input: { draft: d, approvedPromise: p, qcScope: scope, priorIssues: prior, handoff: {} } }, () => ({ ...QC_PASS, issues: [iss('immersion', 'chapter 2 / segment 1')] }))
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const locs = r.json.qc.issues.map((x: any) => `${x.category}@${x.location}`).sort()
  assert.deepEqual(locs, ['immersion@chapter 2 / segment 2', 'logic@전체 구조'], 'outside-scope prior issues carried over; the in-scope prior one (c1s2) was re-judged and is gone; the new out-of-scope model finding is not counted')
  assert.ok(r.json.qc.issues.every((x: any) => x.carriedOver)); assert.equal(r.json.qc.status, 'revision_required'); assert.equal(r.json.qc.promise.carriedOver, 2)
  // nothing left unresolved -> pass
  const clean = await call(qcHandler, { input: { draft: d, approvedPromise: p, qcScope: scope, priorIssues: [iss('repeat_video', 'chapter 1 / segment 2')], handoff: {} } }, () => QC_PASS)
  assert.equal(clean.json.qc.status, 'pass'); assert.equal(clean.json.qc.promise.promiseId, p.promiseId); assert.equal(clean.json.qc.issues.length, 0)
  // a scoped re-check without the previous issues is refused (it cannot know what is still open)
  const noPrior = await call(qcHandler, { input: { draft: d, approvedPromise: p, qcScope: scope, handoff: {} } }, () => QC_PASS)
  assert.equal(noPrior.status, 400); assert.equal(noPrior.json.error.code, 'PRIOR_ISSUES_REQUIRED'); assert.equal(noPrior.calls.length, 0)
  // deterministic check (a must-show term vanished from the script) stays even though 'hook' is outside the scope
  const broken = DRAFT(); broken.hook = '월급 이야기'; broken.chapters[1].segments[0].text = '정리해야 합니다.'; broken.chapters[0].segments[0].text = '내역을 봅니다.'
  const det = await call(qcHandler, { input: { draft: broken, approvedPromise: p, qcScope: scope, priorIssues: [], handoff: {} } }, () => QC_PASS)
  assert.equal(det.json.qc.status, 'revision_required'); assert.ok(det.json.qc.issues.some((x: any) => x.deterministic && x.category === 'title_promise'))
  assert.equal(checkDraftAgainstPromise(d, p).length, 0)
})

test('6b partial revision must return EVERY requested segment; a half-fixed script is an error, not a success', async () => {
  const p = lock(), d = DRAFT()
  const qc = { ...QC_PASS, status: 'revision_required', issues: [iss('immersion', 'hook'), iss('repeat_video', 'chapter 1 / segment 2')] }
  const half = await call(reviseHandler, { input: { partial: true, draft: d, qc, approvedPromise: p, handoff: {} } }, () => ({ items: [{ target: 'hook', text: '새 훅 자동이체', visualHint: '', factStatus: 'interpretation' }] }))
  assert.equal(half.status, 502); assert.equal(half.json.ok, false); assert.equal(half.json.error.code, 'PARTIAL_INCOMPLETE'); assert.deepEqual(half.json.error.missing, ['c1s2']); assert.equal(half.json.draft, undefined)
  const empty = await call(qcHandler, { mode: 'revise_partial', input: { draft: d, qc, approvedPromise: p, handoff: {} } }, () => ({ items: [{ target: 'hook', text: '새 훅', visualHint: '', factStatus: 'interpretation' }, { target: 'c1s2', text: '   ', visualHint: '', factStatus: 'interpretation' }] }))
  assert.equal(empty.status, 502); assert.deepEqual(empty.json.error.missing, ['c1s2'])
})

test('7 final check: the finished video keeps the approved title, thumbnail lines and delivers the core event; missing inputs never pass', () => {
  const p = lock(), ok = finalPromiseCheck(p, { title: p.title, thumbnailLines: ['월급이', '사라진 이유'], narration: '통장 내역을 보면 자동이체가 먼저 빠집니다.' })
  assert.deepEqual([ok.ok, ok.promiseId, ok.failures, ok.method, ok.verifiesVideoContent], [true, p.promiseId, [], 'text_match', false])
  const bad = finalPromiseCheck(p, { title: '다른 제목', thumbnailLines: ['엉뚱한 문구'], narration: '월급 이야기' })
  assert.deepEqual(bad.failures.map((f) => f.code).sort(), ['PROMISE_NOT_DELIVERED', 'PROMISE_NOT_DELIVERED', 'THUMBNAIL_CHANGED', 'THUMBNAIL_CHANGED', 'TITLE_CHANGED'])
  assert.deepEqual(finalPromiseCheck(p, {}).failures.map((f) => f.code).sort(), ['MISSING_NARRATION', 'MISSING_THUMBNAIL', 'MISSING_TITLE'])
  assert.equal(finalPromiseCheck({ ...p, title: '위조된 제목입니다' }, { title: p.title, thumbnailLines: p.thumbnail.lines, narration: 'x' }).failures[0].code, 'PROMISE_INVALID')
})

test('8 job API tasks promise_lock / promise_final_check: auth, POST only, no database', async () => {
  const handler = createJobsHttp({ getStore: async () => { throw new Error('no db needed') }, blobs: {} as any, sourceExists: async () => true })
  const run = async (method: string, body: any, key = 'k'.repeat(32)) => { let status = 0, json: any; await handler({ method, headers: key ? { 'x-sync-key': key } : {}, query: method === 'GET' ? body : {}, body } as any, { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } } as any); return { status, json } }
  assert.equal((await run('POST', { taskType: 'promise_lock', ...INPUT }, '')).status, 401)
  assert.equal((await run('GET', { taskType: 'promise_lock' })).status, 405)
  const locked = await run('POST', { taskType: 'promise_lock', ...INPUT }); assert.equal(locked.status, 200); assert.equal(verifyPromise(locked.json.promise), true); assert.match(locked.json.promise.signature, /^[0-9a-f]{64}$/)
  const saved = { a: process.env.TITLE_PROMISE_SECRET, b: process.env.OPENAI_API_KEY, c: process.env.ANTHROPIC_API_KEY }
  delete process.env.TITLE_PROMISE_SECRET; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY
  try { assert.equal((await run('POST', { taskType: 'promise_lock', ...INPUT })).status, 503, 'no signing secret -> no approval can be issued') }
  finally { process.env.TITLE_PROMISE_SECRET = saved.a!; process.env.OPENAI_API_KEY = saved.b!; process.env.ANTHROPIC_API_KEY = saved.c! }
  assert.equal((await run('POST', { taskType: 'promise_lock', ...INPUT, coreEvent: '' })).status, 400)
  const chk = await run('POST', { taskType: 'promise_final_check', approvedPromise: locked.json.promise, title: INPUT.title, thumbnailLines: INPUT.thumbnail.lines, narration: '통장 내역과 자동이체' })
  assert.equal(chk.status, 200); assert.equal(chk.json.check.ok, true)
})

test('9 Claude is the default fixer: partial request sends ONLY the failing pieces to Anthropic, keeps the approved title, and the legacy whole-draft path is unchanged', async () => {
  const p = lock(), d = DRAFT(); d.title = '바뀐 제목입니다 정말로'
  const qc = { ...QC_PASS, status: 'revision_required', issues: [iss('immersion', 'hook'), iss('title_promise', 'title')] }
  const r = await call(reviseHandler, { input: { partial: true, draft: d, qc, approvedPromise: p, handoff: {} } }, () => ({ items: [{ target: 'hook', text: '월급날 통장 내역을 열면 자동이체가 먼저 가져갑니다.', visualHint: '', factStatus: 'interpretation' }] }))
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.calls.length, 1); assert.ok(r.calls[0].url.includes('anthropic'))
  assert.ok(r.calls[0].body.messages[0].content.includes(p.promiseId) && !r.calls[0].body.messages[0].content.includes('하나씩 해지하면'), 'promise in the prompt; whole script not sent')
  assert.equal(r.json.provider, 'Anthropic'); assert.equal(r.json.scope, 'partial'); assert.deepEqual(r.json.revisedTargets, ['hook']); assert.equal(r.json.draft.title, p.title)
  assert.deepEqual(r.json.draft.chapters, d.chapters, 'every chapter/segment (and its visualHint asset text) preserved'); assert.deepEqual(r.json.qcScope.sort(), ['hook', 'title'])
  const full = await call(reviseHandler, { input: { partial: true, draft: d, qc: { ...QC_PASS, status: 'revision_required', issues: [iss('logic', '전체 구조')] }, approvedPromise: p } })
  assert.equal(full.json.scope, 'manual_required'); assert.equal(full.calls.length, 0)
  const noConfirm = await call(reviseHandler, { input: { draft: d, qc, approvedPromise: p, handoff: {} } }, () => d)
  assert.equal(noConfirm.status, 409); assert.equal(noConfirm.json.error.code, 'FULL_REWRITE_NOT_CONFIRMED'); assert.equal(noConfirm.calls.length, 0, 'no paid call without explicit confirmation')
  assert.equal((await call(reviseHandler, { input: { draft: d, qc, approvedPromise: p, confirmFullRewrite: true, handoff: {} } }, () => d)).status, 200)
  const legacy = await call(reviseHandler, { input: { draft: d, qc, handoff: {} } }, () => d)
  assert.equal(legacy.status, 200); assert.equal(legacy.json.revisionCount, 1); assert.equal(legacy.json.scope, undefined, 'no partial flag -> old whole-draft behaviour')
})
