import type { Request, Response, NextFunction } from 'express'

// 모바일 청크 전송 진단(499 조사용). 인증정보·요청 본문·헤더는 기록하지 않는다: 에피소드 ID(형식 검증)·청크 번호·선언된 크기·경과 시간·상태만 한 줄로 남긴다.
export function logChunkDiag(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ tag: 'chunk-diag', event, ...fields }))
}

const EPISODE_ID = /^ep_[a-z0-9]{8,40}$/i
const safeEpisodeId = (v: unknown) => (EPISODE_ID.test(String(v || '')) ? String(v) : null)
const safeIndex = (v: unknown) => (/^\d{1,5}$/.test(String(v ?? '')) ? Number(v) : null)

// 저장소 경로에서 청크 번호만 뽑는다(경로에는 작업공간 해시가 있으므로 경로 자체는 기록하지 않는다).
export function chunkIndexOfPath(path: string): number | null {
  const m = String(path).match(/\/chunk-(\d{1,5})\.bin$/)
  return m ? Number(m[1]) : null
}

// 청크 POST 한 건의 본문 수신 완료·중단을 기록한다. 본문 스트림을 읽거나 소비하지 않는다(이벤트 구독과 소켓 수신 바이트 표본만 사용).
// 연결이 끊긴 뒤에는 소켓의 수신 바이트를 읽을 수 없으므로, 수신 중에 표본을 떠 두었다가 중단 시 마지막 값과 '마지막으로 늘어난 뒤 경과 시간'을 남긴다.
// bytesAfterStart는 요청이 시작된 시점 이후 소켓이 더 받은 바이트(대략값: 시작 시점에 이미 버퍼에 있던 본문 앞부분은 빠진다).
export function createChunkRequestDiagnostics({ sampleMs = 1000 }: { sampleMs?: number } = {}) {
  return function chunkRequestDiagnostics(req: Request, res: Response, next: NextFunction) {
    if (req.method !== 'POST') return next()
    let url: URL
    try { url = new URL(String(req.originalUrl || req.url || '/'), 'http://diag.local') } catch { return next() }
    const isChunk = url.searchParams.get('op') === 'chunk' || /\/chunk\/?$/.test(url.pathname) || /\/chunk\/[^/]+\/\d+/.test(url.pathname)
    if (!isChunk) return next()
    const started = Date.now(), socketStart = req.socket?.bytesRead || 0
    const declared = Number(req.headers['content-length']) || null
    const who = { episodeId: safeEpisodeId(url.searchParams.get('episodeId')), index: safeIndex(url.searchParams.get('index')), declared }
    let received = false, aborted = false, lastBytes = 0, lastGrowthAt = started
    const sample = () => { const b = Math.max(0, (req.socket?.bytesRead || 0) - socketStart); if (b > lastBytes) { lastBytes = b; lastGrowthAt = Date.now() } }
    const timer = setInterval(sample, sampleMs); timer.unref?.()
    const stop = () => clearInterval(timer)
    logChunkDiag('body-start', who)
    req.on('end', () => { received = true; stop(); logChunkDiag('body-received', { ...who, ms: Date.now() - started }) })
    const abort = () => {
      if (received || aborted) return
      aborted = true; stop()
      logChunkDiag('body-aborted', { ...who, ms: Date.now() - started, bytesAfterStart: lastBytes, stalledMs: Date.now() - lastGrowthAt })
    }
    req.on('aborted', abort)
    req.on('close', () => { if (!req.complete) abort() })
    res.on('close', () => { stop(); logChunkDiag('response', { ...who, status: res.statusCode, bodyReceived: received, ms: Date.now() - started }) })
    next()
  }
}
export const chunkRequestDiagnostics = createChunkRequestDiagnostics()
