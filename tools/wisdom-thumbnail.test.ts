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
import { standInPortrait, measureThumbnail, assertThumbnail, rgb, cover } from './thumbnailMeasure.js'
import { withWisdomThumbnail } from '../worker/stages/wisdomThumbnail.js'

const pkgExec: any = { stage: 'PACKAGE', estimateUsd: () => 0, inputHash: () => 'x', run: async ({ blobs }: any) => { const s = await putAddressed(blobs, 'packages', { schema: 'shorts-package/1', finalRenderRef: 'renders/a.mp4' }); return { outputRef: s.path, outputHash: 'h', result: { packageRef: s.path } } } }

test('copy rules: never the title, 2-3 meaning units, meaning colours', () => {
  assert.deepEqual(thumbnailCopyErrors([{ text: '혼자가', color: 'white' }, { text: '편해지는', color: 'purple' }, { text: '진짜 이유', color: 'red' }], '나이 들수록 혼자가 편해지는 이유'), [])
  assert.ok(thumbnailCopyErrors([{ text: '나이 들수록', color: 'white' }, { text: '혼자가 편해지는 이유', color: 'yellow' }], '나이 들수록 혼자가 편해지는 이유').includes('copies_title'))
  assert.ok(thumbnailCopyErrors([{ text: '인생', color: 'white' }, { text: '지혜', color: 'yellow' }], 't').includes('colors.monotone'))
  assert.match(thumbnailFigure('세네카가 말하는 시간', 'old man'), /^Seneca, Roman Stoic/)
  assert.match(thumbnailFigure('쇼펜하우어가 말하는 고독', 'old man'), /^Arthur Schopenhauer/)
  assert.equal(thumbnailFigure('나이 들수록 멀리할 사람', 'a calm sage'), 'a calm sage')
})

test('REAL: Wisdom SHORTS thumbnail (Schopenhauer topic) through the PACKAGE decorator', async () => {
  const d = await mkdtemp(join(tmpdir(), 'wthumb-')), blobs: any = createMemoryBlobStore()
  const portrait = join(d, 'p.jpg'); await standInPortrait(portrait, { side: 'right', tint: [150, 165, 205], bg: [14, 20, 34] })
  const script = await putAddressed(blobs, 'generative-scripts', { schema: 'wisdom-script/1', title: '쇼펜하우어가 말하는 나이 들수록 혼자가 편한 이유', hook: '왜 나이 들수록 혼자가 편할까', beats: [{ narration: '쇼펜하우어는 고독을 두려워하지 말라고 했습니다' }] })
  const brief = await putAddressed(blobs, 'generative-briefs', { text: '쇼펜하우어가 말하는 나이 들수록 혼자가 편한 이유' })
  const prompts: string[] = []
  const ex = withWisdomThumbnail(pkgExec, { apiKey: 'k', copy: async () => ({ lines: [{ text: '혼자가', color: 'white' }, { text: '편해지는', color: 'purple' }, { text: '진짜 이유', color: 'red' }], figure: 'old man' }), image: async (p: string) => { prompts.push(p); return { bytes: await readFile(portrait), contentType: 'image/jpeg', provider: 'standin', model: 'still' } } })
  const r: any = await ex.run({ job: { id: 'j', profile: 'wisdom', planRef: brief.path }, blobs, previous: async (s: string) => (s === 'PLAN' ? { result: { scriptRef: script.path } } : null), signal: new AbortController().signal } as any)
  assert.ok(r.result.thumbnailRef, JSON.stringify(r.result))
  assert.match(prompts[0], /Arthur Schopenhauer/) // named thinker is the hero, not a generic elderly man
  const pkg: any = await blobs.getJson(r.result.packageRef); assert.equal(pkg.thumbnailRef, r.result.thumbnailRef)
  const out = join(d, 'thumb.jpg'); writeFileSync(out, blobs.binaries.get(r.result.thumbnailRef))
  const m = measureThumbnail(await rgb(out), await cover(portrait), pkg.thumbnailLines)
  console.log('THUMB_SHORTS ' + JSON.stringify(m))
  if (process.env.LONGFORM_SAMPLE_OUT) { mkdirSync(process.env.LONGFORM_SAMPLE_OUT, { recursive: true }); writeFileSync(join(process.env.LONGFORM_SAMPLE_OUT, 'thumbnail-shorts-schopenhauer.jpg'), blobs.binaries.get(r.result.thumbnailRef)) }
  assertThumbnail(m, 'shorts')
  // a non-wisdom package is untouched
  const plain: any = await ex.run({ job: { id: 'j2', profile: 'source_shorts' }, blobs, previous: async () => null, signal: new AbortController().signal } as any)
  assert.equal(plain.result.thumbnailRef, undefined)
})

test('a failing thumbnail never blocks the Shorts package', async () => {
  const blobs: any = createMemoryBlobStore()
  const ex = withWisdomThumbnail(pkgExec, { apiKey: 'k', copy: async () => { throw new Error('provider down') } })
  const r: any = await ex.run({ job: { id: 'j', profile: 'wisdom' }, blobs, previous: async () => ({ result: { scriptRef: (await putAddressed(blobs, 's', { title: 't', beats: [] })).path } }), signal: new AbortController().signal } as any)
  assert.ok(r.result.packageRef); assert.match(r.result.thumbnailError, /provider down/)
})
