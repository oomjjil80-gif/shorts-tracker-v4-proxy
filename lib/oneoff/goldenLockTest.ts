// ONE-OFF TEST (branch yv5-run only, never merged) — PR #180 FINAL PAID GEMINI TEST: the implemented Golden Style path
// (goldenStyle.ts goldenImage) with the FIRST-IMAGE CHARACTER LOCK. step 1 = the first picture (Golden reference alone);
// steps 2-3 = later pictures [Golden reference (style), the step-1 picture (the people)]. Only this repository's GitHub
// Actions token, only before the deadline; one Gemini request per call, never retried.
import type { Request, Response } from 'express'
import { goldenImage, goldenSpec, identityOf } from '../generative/goldenStyle.js'

const REPO = 'oomjjil80-gif/shorts-tracker-v4-proxy'
const DEADLINE = Date.parse('2026-10-10T18:00:00Z')
export const LOCK_TEST_STYLE = 'golden-3' as const
export const LOCK_TEST_SCENES = [
  '조선시대 낡은 한옥 앞마당에서 젊은 여인이 작은 보자기를 할머니에게 건넵니다. 할머니는 놀라움과 고마움이 섞인 표정으로 받아 듭니다. 뒤에는 돌담과 기와집이 보입니다.',
  '같은 젊은 여인과 할머니가 어두운 부엌 아궁이 앞에 나란히 앉아 함께 밥을 짓습니다. 할머니가 여인의 손을 잡고 환하게 웃습니다.',
  '해 질 녘 마을 어귀 돌담길에서 같은 젊은 여인이 할머니를 부축하며 천천히 함께 걸어갑니다. 두 사람의 얼굴이 잘 보입니다.'
]

async function callerIsThisRepo(auth: string): Promise<boolean> {
  const token = /^Bearer (\S+)$/.exec(auth)?.[1]
  if (!token) return false
  const r = await fetch('https://api.github.com/installation/repositories', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'golden-lock-test' } }).catch(() => null)
  if (!r?.ok) return false
  const j: any = await r.json().catch(() => null)
  return Array.isArray(j?.repositories) && j.repositories.some((x: any) => x?.full_name === REPO)
}

export async function handleGoldenLockTest(req: Request, res: Response) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' })
  if (Date.now() > DEADLINE) return res.status(410).json({ ok: false, error: 'expired', paidCalls: 0 })
  if (!(await callerIsThisRepo(String(req.headers.authorization || '')))) return res.status(403).json({ ok: false, error: 'forbidden', paidCalls: 0 })
  const step = Number((req.body as any)?.step)
  if (![1, 2, 3].includes(step)) return res.status(400).json({ ok: false, error: 'step must be 1..3', paidCalls: 0 })
  const lockData = String((req.body as any)?.identity?.data || '')
  if (step === 1 && lockData) return res.status(400).json({ ok: false, error: 'the first picture has no lock', paidCalls: 0 })
  if (step > 1 && !lockData) return res.status(400).json({ ok: false, error: 'a later picture needs the first picture (lock)', paidCalls: 0 })
  const identity = lockData ? identityOf(Buffer.from(lockData, 'base64')) : null
  if (identity && (req.body as any)?.identity?.sha256 !== identity.sha256) return res.status(400).json({ ok: false, error: 'lock sha256 mismatch', paidCalls: 0 })
  const key = process.env.GEMINI_API_KEY || ''
  if (!key) return res.status(503).json({ ok: false, error: 'GEMINI_API_KEY is not configured', paidCalls: 0 })
  const t0 = Date.now()
  try {
    const made = await goldenImage(goldenSpec(LOCK_TEST_STYLE), LOCK_TEST_SCENES[step - 1], '16:9', key, fetch, identity)
    return res.status(200).json({ ok: true, paidCalls: 1, ms: Date.now() - t0, model: made.model, contentType: made.contentType, inputs: identity ? 3 : 2, lockSha256: identity?.sha256 ?? null, b64: made.bytes.toString('base64') })
  } catch (e: any) {
    return res.status(502).json({ ok: false, paidCalls: 1, ms: Date.now() - t0, status: e?.status ?? null, code: e?.code ?? null, cause: String(e?.cause?.code || e?.cause?.message || '').slice(0, 200) || null, error: String(e?.message || e).replace(/AIza[0-9A-Za-z_-]+/g, '[key]').slice(0, 400) })
  }
}
