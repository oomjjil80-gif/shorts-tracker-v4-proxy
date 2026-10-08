// Longform title thumbnail: the exact final title (never cut / summarised / changed), wrapped + shrunk to fit, the ink
// measured inside the canvas; the background shows the scene the title is about and asks for no text. No AI calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeTitleThumbnail, sameTitle, normTitle, titleSceneIndex, thumbnailBackgroundPrompt, TITLE_THUMB } from '../lib/generative/titleThumbnail.js'
import { probe, runOk } from '../lib/media/ffmpeg.js'
import { STYLE_APPROVAL } from '../lib/generative/styleApproval.js'

const bg = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'style-examples', 'yadam', 'oriental_painterly.jpg')

test('the thumbnail text is the final title exactly; long titles wrap and shrink; the ink stays inside the frame; too long = an error, never a cut', async () => {
  const background = await readFile(bg)
  const titles = ['썩은 메주', '만만하게 보이지 않는 사람들의 5가지 태도', '5년 만에 친정 가는 며느리에게 시어머니가 썩은 메주만 지워 보낸 이유', '시집온 지 5년 만에 처음 친정에 가던 며느리가 시어머니에게 받은 썩은 메주 한 덩이에 숨겨진 놀라운 비밀과 그날 밤 벌어진 일', 'Why "Small" Habits Win — 작은 습관이 이기는 이유 (2026)']
  let lastFs = Infinity
  for (const t of titles) {
    const r = await composeTitleThumbnail({ background, title: t })
    assert.ok(sameTitle(r.lines, t), `${t}: every character, in order`); assert.equal(r.lines.join(' '), normTitle(t), 'word for word (spaces kept)')
    const S = TITLE_THUMB.safe
    assert.ok(r.ink.x0 >= S.left && r.ink.y0 >= S.top && r.ink.x1 <= TITLE_THUMB.w - S.right && r.ink.y1 <= TITLE_THUMB.h - S.bottom, `${t}: ink ${JSON.stringify(r.ink)}`)
    assert.ok(r.fs >= TITLE_THUMB.minPx && r.lines.length <= TITLE_THUMB.maxLines)
    const f = join((await import('node:os')).tmpdir(), `title-thumb-${Date.now()}.jpg`); await (await import('node:fs/promises')).writeFile(f, r.bytes)
    const info = await probe(f); assert.deepEqual([info.width, info.height], [1280, 720])
    if (t.length > 30) { assert.ok(r.fs < lastFs || r.lines.length > 1, 'longer title -> more lines / smaller type'); lastFs = r.fs }
  }
  // a single unbreakable run longer than a line is split between characters, still the same text
  const mono = '가'.repeat(26), m = await composeTitleThumbnail({ background, title: mono })
  assert.ok(sameTitle(m.lines, mono) && m.lines.length >= 2)
  // impossible at the smallest size: an error, not a shortened title
  await assert.rejects(() => composeTitleThumbnail({ background, title: '아주 긴 제목 '.repeat(40) }), (e: any) => e.code === 'THUMB_TITLE_OVERFLOW' && /never shortened/.test(e.message))
  await assert.rejects(() => composeTitleThumbnail({ background, title: '  ' }), /no title/)
  void runOk
})

test('the background is the scene the title is about (never the ending), with no text; Wisdom Shorts LOCK is untouched', () => {
  const scenes = [
    { id: 's1', text: '평화로운 마을의 아침, 우물가' },
    { id: 's2', text: '시어머니가 며느리에게 썩은 메주를 지워 보낸다' },
    { id: 's3', text: '장터에서 도둑으로 몰린다' },
    { id: 's4', text: '메주 속 금가락지, 시어머니의 진심이 밝혀진다 메주 메주 시어머니' },
    { id: 's5', text: '친정 식구들이 구원받는다' }
  ]
  assert.equal(titleSceneIndex('시어머니가 썩은 메주만 지워 보낸 이유', scenes, 2), 1)
  assert.equal(titleSceneIndex('아무 관련 없는 말', scenes, 2), 2, 'no shared word -> the fallback scene')
  assert.ok(titleSceneIndex('금가락지 진심 밝혀진다 친정 구원', scenes, 0) <= 3, 'the last 20% (reveal / ending) is never the thumbnail')
  const p = thumbnailBackgroundPrompt('썩은 메주의 비밀', 'SCENE PROMPT')
  assert.match(p, /ABSOLUTELY NO text, letters/); assert.match(p, /not muddy/); assert.match(p, /SCENE PROMPT$/); assert.match(p, /썩은 메주의 비밀/)
  assert.equal(STYLE_APPROVAL.wisdom.enabled, false)
})
