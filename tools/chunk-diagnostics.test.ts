// 청크 본문 수신 완료·중단과 R2 PUT 시작·종료 진단 로그. 인증정보·요청 본문·저장소 경로(작업공간 해시)는 기록하지 않는다. 무료·로컬.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import express from 'express'
import { createChunkRequestDiagnostics } from '../lib/chunkDiagnostics.js'
import { putIfAbsent } from '../lib/objectStorage.js'

const SECRET_KEY = 'sync-key-SECRET-for-diagnostics-test-0123456789', BODY_SECRET = 'BODY-SECRET-PAYLOAD-must-not-be-logged'
function capture() {
  const lines: any[] = [], original = console.log
  console.log = (...a: any[]) => { try { const o = JSON.parse(String(a[0])); if (o?.tag === 'chunk-diag') { lines.push(o); return } } catch { /* not ours */ } original(...a) }
  return { lines, restore() { console.log = original } }
}
async function withServer(fn: (port: number, seen: { bodies: number }) => Promise<void>) {
  const app = express(), seen = { bodies: 0 }
  app.use('/api/sync', createChunkRequestDiagnostics({ sampleMs: 15 }))
  app.use('/api/sync', express.raw({ type: 'application/octet-stream', limit: '3mb' }))
  app.post('/api/sync/start', (req, res) => { seen.bodies++; res.status(200).json({ ok: true, size: Buffer.isBuffer(req.body) ? req.body.length : 0 }) })
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try { await fn((server.address() as any).port, seen) } finally { await new Promise((r) => server.close(r)) }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('청크 본문 수신이 끝나면 시작·수신 완료·응답이 순서대로 한 줄씩 남고, 인증정보·본문·헤더는 없다', async () => {
  const cap = capture()
  try {
    await withServer(async (port) => {
      const body = Buffer.from(BODY_SECRET.repeat(50))
      const res = await fetch(`http://127.0.0.1:${port}/api/sync/start?episodeId=ep_diag000001&op=chunk&slot=u${'a'.repeat(32)}&index=3`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-sync-key': SECRET_KEY, authorization: 'Bearer TOKEN-SECRET' }, body })
      assert.equal(res.status, 200); await wait(30)
    })
    assert.deepEqual(cap.lines.map((l) => l.event), ['body-start', 'body-received', 'response'])
    assert.deepEqual([cap.lines[0].episodeId, cap.lines[0].index, cap.lines[0].declared], ['ep_diag000001', 3, BODY_SECRET.length * 50])
    assert.equal(cap.lines[2].status, 200); assert.equal(cap.lines[2].bodyReceived, true)
    const all = JSON.stringify(cap.lines); for (const s of [SECRET_KEY, BODY_SECRET, 'TOKEN-SECRET', 'u' + 'a'.repeat(32)]) assert.ok(!all.includes(s), `진단 로그에 노출됨: ${s.slice(0, 10)}…`)
  } finally { cap.restore() }
})

test('본문을 다 받기 전에 연결이 끊기면(모바일 499 상황) body-aborted와 경과 시간·선언 크기가 남고 본문 처리는 일어나지 않는다', async () => {
  const cap = capture()
  try {
    await withServer(async (port, seen) => {
      await new Promise<void>((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          const declared = 1_000_000
          sock.write(`POST /api/sync/start?episodeId=ep_diag000002&op=chunk&index=7 HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: ${declared}\r\nX-Sync-Key: ${SECRET_KEY}\r\n\r\n`)
          setTimeout(() => sock.write(Buffer.alloc(20_000, 1)), 30) // 일부만 보내고
          setTimeout(() => { sock.destroy(); resolve() }, 90)     // 연결을 끊는다
        })
        sock.on('error', () => {})
      })
      await wait(100); assert.equal(seen.bodies, 0, '불완전한 본문은 처리되지 않는다')
    })
    const events = cap.lines.map((l) => l.event); assert.ok(events.includes('body-start') && events.includes('body-aborted'), JSON.stringify(events)); assert.ok(!events.includes('body-received'))
    const aborted = cap.lines.find((l) => l.event === 'body-aborted'); assert.equal(aborted.episodeId, 'ep_diag000002'); assert.equal(aborted.index, 7); assert.equal(aborted.declared, 1_000_000)
    assert.ok(aborted.ms >= 80 && aborted.bytesAfterStart > 0 && aborted.bytesAfterStart < 1_000_000 && aborted.stalledMs >= 0 && aborted.stalledMs <= aborted.ms, JSON.stringify(aborted))
    assert.equal(cap.lines.filter((l) => l.event === 'body-aborted').length, 1, '중단은 한 번만 기록된다')
    assert.ok(!JSON.stringify(cap.lines).includes(SECRET_KEY))
  } finally { cap.restore() }
})

test('청크가 아닌 요청은 기록하지 않고, 형식이 맞지 않는 식별자는 값 없이 null로 남는다', async () => {
  const cap = capture()
  try {
    await withServer(async (port) => {
      await fetch(`http://127.0.0.1:${port}/api/sync/start?op=start&episodeId=ep_diag000003`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x' })
      await fetch(`http://127.0.0.1:${port}/api/sync/start?episodeId=${encodeURIComponent(SECRET_KEY)}&op=chunk&index=${encodeURIComponent(SECRET_KEY)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x' })
      await wait(30)
    })
    assert.equal(cap.lines.filter((l) => l.event === 'body-start').length, 1, '청크 요청만 기록')
    assert.deepEqual([cap.lines[0].episodeId, cap.lines[0].index], [null, null]); assert.ok(!JSON.stringify(cap.lines).includes(SECRET_KEY))
  } finally { cap.restore() }
})

test('R2 청크 PUT의 시작·종료 시점이 청크 번호·크기·상태·경과 시간으로 남고, 저장소 경로(작업공간 해시)와 본문은 없다', async () => {
  const cap = capture(), saved: Record<string, string | undefined> = {}, realFetch = globalThis.fetch
  const env = { R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', R2_BUCKET: 'tracker', R2_ACCESS_KEY_ID: 'AKIDTEST', R2_SECRET_ACCESS_KEY: 'secret' }
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v }
  const workspaceHash = 'f'.repeat(64)
  globalThis.fetch = (async () => { await wait(25); return new Response('', { status: 200, headers: { etag: '"e1"' } }) }) as any
  try {
    const ok = await putIfAbsent(`tracker-sync/${workspaceHash}/episodes/ep_diag000004/u${'b'.repeat(32)}/chunk-3.bin`, Buffer.from(BODY_SECRET) as unknown as string, 'application/octet-stream')
    assert.equal(ok, true)
    await putIfAbsent(`tracker-sync/${workspaceHash}/episodes/ep_diag000004/manifest.json`, '{}') // 청크가 아닌 객체는 기록하지 않는다
    assert.deepEqual(cap.lines.map((l) => l.event), ['r2-put-start', 'r2-put-end'])
    assert.deepEqual([cap.lines[0].index, cap.lines[0].bytes], [3, BODY_SECRET.length]); assert.equal(cap.lines[1].status, 200); assert.ok(cap.lines[1].ms >= 20)
    const all = JSON.stringify(cap.lines); for (const s of [workspaceHash, BODY_SECRET, 'ep_diag000004', 'secret', 'AKIDTEST']) assert.ok(!all.includes(s), `노출됨: ${s.slice(0, 10)}…`)
    // 저장소 연결 실패도 종료 시점이 남는다
    globalThis.fetch = (async () => { await wait(10); throw Object.assign(new TypeError('fetch failed'), { name: 'TypeError' }) }) as any
    cap.lines.length = 0
    await assert.rejects(putIfAbsent(`tracker-sync/${workspaceHash}/episodes/ep_diag000004/u${'c'.repeat(32)}/chunk-5.bin`, Buffer.from('x') as unknown as string))
    assert.deepEqual(cap.lines.map((l) => l.event), ['r2-put-start', 'r2-put-failed']); assert.equal(cap.lines[1].error, 'TypeError')
  } finally { globalThis.fetch = realFetch; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }; cap.restore() }
})
