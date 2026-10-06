// Wisdom click thumbnails measured on the produced JPEG: 16:9, figure RIGHT / text LEFT with no overlap, nothing
// clipped, no full-frame dark box (only a feathered shade behind the text), meaning colours, readable at phone size,
// copy that is not the title. Image/copy providers are local stand-ins; composition is the production code.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryBlobStore, putAddressed } from '../lib/jobs/blobs.js'
import { thumbnailCopyErrors, thumbnailFigure } from '../lib/generative/wisdomThumbnail.js'
import { standInPortrait, standInPortraitTall, measureTallThumbnail, assertTallThumbnail, rgb, cover } from './thumbnailMeasure.js'
import { probe } from '../lib/media/ffmpeg.js'
import { LONGFORM_THUMB, SHORTS_THUMB, thumbnailAss } from '../lib/generative/wisdomThumbnail.js'
import { withWisdomThumbnail } from '../worker/stages/wisdomThumbnail.js'
import { uploadMetadataErrors } from '../lib/generative/uploadPackage.js'

// Example A: a Wisdom Shorts script as PLAN stores it, and the publish kit the model returns for it
const A_SCRIPT = { schema: 'wisdom-script/1', title: '나이 들수록 설명하지 말아야 할 5가지', hook: '나이가 들수록 말을 아끼는 사람이 더 단단해 보입니다.',
  beats: [
    { narration: '나이가 들수록 말을 아끼는 사람이 더 단단해 보입니다. 특히 이 다섯 가지는 굳이 설명하지 않는 게 좋습니다.' },
    { narration: '첫째, 나의 선택을 모두에게 이해시키려 하지 마세요. 결과가 대신 말해 줍니다.' },
    { narration: '둘째, 거절의 이유를 길게 늘어놓지 마세요. 변명이 길수록 상대는 협상하려 듭니다.' },
    { narration: '셋째, 내 사생활과 재산은 설명할수록 비교와 간섭의 재료가 됩니다.' },
    { narration: '넷째, 오해를 받을 때마다 해명하지 마세요. 시간이 지나면 행동이 증명합니다.' },
    { narration: '하지만 마지막 다섯째가 가장 중요합니다. 나를 떠난 사람에게 붙잡는 이유를 설명하지 마세요. 침묵도 하나의 대답입니다.' }
  ] }
const A_KIT = {
  lines: [{ text: '설명할수록', color: 'white' }, { text: '손해 보는', color: 'red' }, { text: '5가지', color: 'yellow' }] as any,
  figure: 'a calm Korean elder in his sixties, silver hair, dark coat, quiet confident gaze',
  metadata: {
    title: '나이 들수록 설명하면 손해 보는 5가지｜말을 아끼는 사람이 단단한 이유',
    description: '나이가 들수록 모든 걸 해명하려는 습관이 오히려 관계를 피곤하게 만듭니다. 선택, 거절, 사생활, 오해, 그리고 떠난 사람 앞에서 왜 침묵이 더 강한 대답이 되는지 다섯 가지 장면으로 정리했습니다. 말을 줄이고도 존중받는 태도를 찾고 있다면 끝까지 보세요.',
    tags: ['말을 아끼는 법', '거절하는 법', '해명하지 않기', '중년 인간관계', '사생활 지키기', '오해 대처법', '침묵의 힘', '단단한 사람', '인간관계 조언'],
    hashtags: ['#말을아끼는법', '#거절하는법', '#인간관계', '#지혜'],
    pinnedComment: '다섯 가지 중에서 가장 설명하고 싶어지는 건 무엇인가요? 거절할 때인가요, 오해받을 때인가요?'
  }
}
// what the old phone-side code produced for the same script (narration prefix, title words, fixed hashtags, generic comment)
function oldPhoneSide(script: any) {
  const narr = script.beats.map((b: any) => b.narration).join(' '), title = script.title
  const words = title.replace(/[^\w가-힣 ]+/g, ' ').split(/\s+/).filter((x: string) => x.length >= 2).slice(0, 7)
  return { title, description: (narr.length > 240 ? narr.slice(0, 240).trim() + '…' : narr), tags: [...new Set([...words, '지혜', '인생', '철학'])].slice(0, 12), hashtags: ['#지혜', '#인생', '#철학'], pinnedComment: '오늘 이야기에서 가장 마음에 남은 문장은 무엇인가요? 여러분의 생각도 댓글로 남겨주세요.' }
}

const pkgExec: any = { stage: 'PACKAGE', estimateUsd: () => 0, inputHash: () => 'x', run: async ({ blobs }: any) => { const s = await putAddressed(blobs, 'packages', { schema: 'shorts-package/1', finalRenderRef: 'renders/a.mp4' }); return { outputRef: s.path, outputHash: 'h', result: { packageRef: s.path } } } }

test('copy rules: never the title, 2-3 meaning units, meaning colours', () => {
  assert.deepEqual(thumbnailCopyErrors([{ text: '혼자가', color: 'white' }, { text: '편해지는', color: 'purple' }, { text: '진짜 이유', color: 'red' }], '나이 들수록 혼자가 편해지는 이유'), [])
  assert.ok(thumbnailCopyErrors([{ text: '나이 들수록', color: 'white' }, { text: '혼자가 편해지는 이유', color: 'yellow' }], '나이 들수록 혼자가 편해지는 이유').includes('copies_title'))
  assert.ok(thumbnailCopyErrors([{ text: '인생', color: 'white' }, { text: '지혜', color: 'yellow' }], 't').includes('colors.monotone'))
  assert.match(thumbnailFigure('세네카가 말하는 시간', 'old man'), /^Seneca, Roman Stoic/)
  assert.match(thumbnailFigure('쇼펜하우어가 말하는 고독', 'old man'), /^Arthur Schopenhauer/)
  assert.equal(thumbnailFigure('나이 들수록 멀리할 사람', 'a calm sage'), 'a calm sage')
})

test('REAL: Wisdom SHORTS thumbnail (Schopenhauer topic) through the PACKAGE decorator: 9:16 1080x1920 portrait', async () => {
  const d = await mkdtemp(join(tmpdir(), 'wthumb-')), blobs: any = createMemoryBlobStore()
  const portrait = join(d, 'p.jpg'); await standInPortraitTall(portrait, { tint: [150, 165, 205], bg: [14, 20, 34] })
  const script = await putAddressed(blobs, 'generative-scripts', { schema: 'wisdom-script/1', title: '쇼펜하우어가 말하는 나이 들수록 혼자가 편한 이유', hook: '왜 나이 들수록 혼자가 편할까', beats: [{ narration: '쇼펜하우어는 고독을 두려워하지 말라고 했습니다' }] })
  const brief = await putAddressed(blobs, 'generative-briefs', { text: '쇼펜하우어가 말하는 나이 들수록 혼자가 편한 이유' })
  const prompts: string[] = []
  const ex = withWisdomThumbnail(pkgExec, { apiKey: 'k', kit: async () => ({ lines: [{ text: '혼자가', color: 'white' }, { text: '편해지는', color: 'purple' }, { text: '진짜 이유', color: 'red' }], figure: 'old man', metadata: A_KIT.metadata }), image: async (p: string) => { prompts.push(p); return { bytes: await readFile(portrait), contentType: 'image/jpeg', provider: 'standin', model: 'still' } } })
  const r: any = await ex.run({ job: { id: 'j', profile: 'wisdom', planRef: brief.path }, blobs, previous: async (s: string) => (s === 'PLAN' ? { result: { scriptRef: script.path } } : null), signal: new AbortController().signal } as any)
  assert.ok(r.result.thumbnailRef, JSON.stringify(r.result))
  assert.match(prompts[0], /Arthur Schopenhauer/) // named thinker is the hero, not a generic elderly man
  assert.match(prompts[0], /^Tall 9:16 vertical YouTube Shorts thumbnail/); assert.doesNotMatch(prompts[0], /16:9/)
  const pkg: any = await blobs.getJson(r.result.packageRef); assert.equal(pkg.thumbnailRef, r.result.thumbnailRef)
  const out = join(d, 'thumb.jpg'); writeFileSync(out, blobs.binaries.get(r.result.thumbnailRef))
  const info = await probe(out)
  assert.deepEqual([info.width, info.height], [1080, 1920], 'the Shorts thumbnail JPEG is 1080x1920 (ffprobe)')
  const m = measureTallThumbnail(await rgb(out, 1080, 1920), await cover(portrait, 1080, 1920), pkg.thumbnailLines)
  console.log('THUMB_SHORTS ' + JSON.stringify({ ...m, size: [info.width, info.height] }))
  if (process.env.LONGFORM_SAMPLE_OUT) { mkdirSync(process.env.LONGFORM_SAMPLE_OUT, { recursive: true }); writeFileSync(join(process.env.LONGFORM_SAMPLE_OUT, 'thumbnail-shorts-schopenhauer.jpg'), blobs.binaries.get(r.result.thumbnailRef)) }
  assertTallThumbnail(m, 'shorts')
  // a non-wisdom package is untouched
  const plain: any = await ex.run({ job: { id: 'j2', profile: 'source_shorts' }, blobs, previous: async () => null, signal: new AbortController().signal } as any)
  assert.equal(plain.result.thumbnailRef, undefined)
})

test('a failing thumbnail never blocks the Shorts package', async () => {
  const blobs: any = createMemoryBlobStore()
  const ex = withWisdomThumbnail(pkgExec, { apiKey: 'k', kit: async () => { throw new Error('provider down') } })
  const r: any = await ex.run({ job: { id: 'j', profile: 'wisdom' }, blobs, previous: async () => ({ result: { scriptRef: (await putAddressed(blobs, 's', { title: 't', beats: [] })).path } }), signal: new AbortController().signal } as any)
  assert.ok(r.result.packageRef); assert.match(r.result.kitError, /provider down/)
})

test('EXAMPLE A: Wisdom Shorts "나이 들수록 설명하지 말아야 할 5가지" upload package (real PACKAGE decorator, validation and repair)', async () => {
  const d = await mkdtemp(join(tmpdir(), 'wkitA-'))
  const blobs: any = createMemoryBlobStore()
  const narration = A_SCRIPT.beats.map((b) => b.narration).join(' ')
  // the old phone-side text for the same video is rejected on every point it used to fake
  const old = uploadMetadataErrors(oldPhoneSide(A_SCRIPT), { narration, format: 'shorts' })
  for (const k of ['description.copies_script', 'tags.title_words', 'hashtags.fixed_set', 'pinnedComment.generic']) assert.ok(old.includes(k), `old method should fail ${k}: ${old}`)
  assert.deepEqual(uploadMetadataErrors(A_KIT.metadata, { narration, format: 'shorts' }), [])
  const portrait = join(d, 'p.jpg'); await standInPortrait(portrait, { side: 'right', tint: [190, 175, 150], bg: [20, 18, 16] })
  const script = await putAddressed(blobs, 'generative-scripts', A_SCRIPT)
  const brief = await putAddressed(blobs, 'generative-briefs', { text: '나이 들수록 설명하지 말아야 할 5가지' })
  const job = { id: 'job_example_a', profile: 'wisdom', planRef: brief.path }
  let calls = 0
  const ex = withWisdomThumbnail(pkgExec, { apiKey: 'k', kit: async (inp: any) => { calls++; return calls === 1 ? { ...A_KIT, metadata: oldPhoneSide(A_SCRIPT) } : A_KIT }, image: async () => ({ bytes: await readFile(portrait), contentType: 'image/jpeg', provider: 'standin', model: 'still' }) })
  const r: any = await ex.run({ job: { ...job, planRef: brief.path }, blobs, previous: async (st: string) => (st === 'PLAN' ? { result: { scriptRef: script.path } } : null), signal: new AbortController().signal } as any)
  assert.equal(calls, 2, 'the first (old-style) kit is rejected and repaired once')
  assert.equal(r.result.uploadReady, true); assert.ok(r.result.thumbnailRef)
  const pkg: any = await blobs.getJson(r.result.packageRef)
  assert.equal(pkg.metadata.title, A_KIT.metadata.title)
  assert.match(pkg.metadata.description, /\n\n#말을아끼는법 #거절하는법 #인간관계 #지혜$/)
  const out = { topic: '나이 들수록 설명하지 말아야 할 5가지', format: 'Wisdom Shorts', upload: pkg.metadata, thumbnailLines: pkg.thumbnailLines, oldMethodRejectedFor: old }
  console.log('EXAMPLE_A ' + JSON.stringify(out))
  if (process.env.LONGFORM_SAMPLE_OUT) { mkdirSync(process.env.LONGFORM_SAMPLE_OUT, { recursive: true }); writeFileSync(join(process.env.LONGFORM_SAMPLE_OUT, 'upload-example-A-shorts.json'), JSON.stringify(out, null, 2)); writeFileSync(join(process.env.LONGFORM_SAMPLE_OUT, 'thumbnail-example-A-shorts.jpg'), blobs.binaries.get(r.result.thumbnailRef)) }
})

test('thumbnail canvases are separate contracts: Shorts 9:16 1080x1920, Longform 16:9 1280x720 (text placed per canvas)', () => {
  assert.deepEqual([SHORTS_THUMB.w, SHORTS_THUMB.h, LONGFORM_THUMB.w, LONGFORM_THUMB.h], [1080, 1920, 1280, 720])
  const lines: any = [{ text: '혼자가', color: 'white' }, { text: '편해지는', color: 'purple' }, { text: '진짜 이유', color: 'red' }]
  const s = thumbnailAss(lines, SHORTS_THUMB), l = thumbnailAss(lines, LONGFORM_THUMB)
  assert.match(s.ass, /PlayResX: 1080\nPlayResY: 1920/); assert.match(l.ass, /PlayResX: 1280\nPlayResY: 720/)
  assert.ok(s.block.y1 <= 1920 * 0.45 && s.block.x1 <= 1080 - 20, JSON.stringify(s.block)) // upper band of the portrait
  assert.ok(l.block.x1 <= 1280 * 0.62 && Math.abs((l.block.y0 + l.block.y1) / 2 - 360) <= 2, JSON.stringify(l.block)) // left, vertically centred
  assert.ok(s.fs > l.fs) // sized for its own canvas
})
