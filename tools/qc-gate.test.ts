import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGate, runCheck, runGate } from '../lib/qc/gate.js'

const c = (id: string, status: any, required = true) => ({ id, required, status, evidence: null })

test('T8 required FAIL -> BLOCK', () => {
  const g = evaluateGate([c('a', 'PASS'), c('b', 'FAIL')])
  assert.equal(g.decision, 'BLOCK'); assert.deepEqual(g.reasons, ['FAIL: b'])
})

test('T9 required UNKNOWN -> BLOCK (never treated as PASS)', () => {
  const g = evaluateGate([c('a', 'PASS'), c('b', 'UNKNOWN')])
  assert.equal(g.decision, 'BLOCK'); assert.equal(g.counts.unknown, 1)
  // garbage / missing statuses normalise to UNKNOWN
  for (const status of [undefined, null, 'pass', 'OK', true, 1, '']) assert.equal(evaluateGate([{ id: 'x', required: true, status: status as any }]).decision, 'BLOCK')
})

test('T10 all required PASS -> PASS; optional failures do not block', () => {
  const g = evaluateGate([c('a', 'PASS'), c('b', 'PASS'), c('opt', 'FAIL', false), c('opt2', 'UNKNOWN', false)])
  assert.equal(g.decision, 'PASS'); assert.deepEqual(g.reasons, [])
  assert.deepEqual(g.counts, { pass: 2, fail: 1, unknown: 1, requiredPass: 2, requiredTotal: 2 })
})

test('T11 zero checks (or only optional checks) can never PASS', () => {
  assert.equal(evaluateGate([]).decision, 'BLOCK')
  assert.equal(evaluateGate(undefined as any).decision, 'BLOCK')
  assert.equal(evaluateGate([c('opt', 'PASS', false)]).decision, 'BLOCK')
  assert.match(evaluateGate([]).reasons[0], /NO_REQUIRED_CHECKS/)
  assert.equal(evaluateGate([c('a', 'PASS'), c('a', 'PASS')]).decision, 'BLOCK', 'duplicate ids are ambiguous evidence')
})

test('exceptions, timeouts and verdict-less results become UNKNOWN, never PASS', async () => {
  const thrown = await runCheck('t', true, () => { throw new Error('boom') })
  assert.equal(thrown.status, 'UNKNOWN'); assert.match(String((thrown.evidence as any).error), /boom/)
  const rejected = await runCheck('r', true, async () => { throw new Error('model returned invalid JSON') })
  assert.equal(rejected.status, 'UNKNOWN')
  const timedOut = await runCheck('slow', true, () => new Promise(() => {}), { timeoutMs: 20 })
  assert.equal(timedOut.status, 'UNKNOWN'); assert.match(String((timedOut.evidence as any).error), /timed out/)
  const noVerdict = await runCheck('n', true, (() => ({ status: 'maybe' })) as any)
  assert.equal(noVerdict.status, 'UNKNOWN')
  const undef = await runCheck('u', true, (() => undefined) as any)
  assert.equal(undef.status, 'UNKNOWN')
  const ok = await runCheck('ok', true, () => ({ status: 'PASS', evidence: { n: 1 } }))
  assert.deepEqual([ok.status, ok.evidence], ['PASS', { n: 1 }])
  const gate = await runGate([() => Promise.resolve(ok), () => runCheck('x', true, () => { throw new Error('nope') })])
  assert.equal(gate.decision, 'BLOCK')
})
