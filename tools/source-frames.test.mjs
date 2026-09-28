import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { extractSourceFrame, extractSourceFrames, extractSourceContactSheet, parseSecondsList } from '../lib/sourceFrames.js';

test('parseSecondsList clamps to duration, dedupes, sorts and caps the batch size', () => {
  assert.deepEqual(parseSecondsList('4,1,1,-2,999', 10), [0, 1, 4, 9.85]);
  assert.deepEqual(parseSecondsList([2, 5, 'not-a-number'], 10), [2, 5]);
  const many = Array.from({ length: 50 }, (_, i) => i).join(',');
  assert.equal(parseSecondsList(many, 200).length, 30);
});

// A real, small synthetic MP4 built with the same bundled ffmpeg binary the
// Function uses - this exercises the actual extraction code path (spawn,
// /tmp copy+chmod, seek, scale, encode), not a mock of ffmpeg itself.
async function makeSyntheticVideo() {
  const { default: ffmpegPath } = await import('ffmpeg-static');
  const path = '/tmp/source-frames-test.mp4';
  execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=10:duration=6', '-pix_fmt', 'yuv420p', path], { stdio: 'ignore' });
  return path;
}

async function depsForBytes(bytes) {
  return { get: async () => ({ blob: { size: bytes.length }, stream: Readable.toWeb(Readable.from(bytes)) }) };
}

test('extractSourceFrame returns a real JPEG for an in-range timestamp', async () => {
  const path = await makeSyntheticVideo();
  const bytes = await readFile(path);
  const deps = await depsForBytes(bytes);
  const source = { blobPath: 'source-collector/test.mp4', bytes: bytes.length, duration: 6 };
  const jpeg = await extractSourceFrame(source, 3, deps);
  assert.equal(jpeg.subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.ok(jpeg.length > 500, 'expected a non-trivial JPEG payload');
});

test('extractSourceFrame clamps an out-of-range second instead of failing', async () => {
  const path = await makeSyntheticVideo();
  const bytes = await readFile(path);
  const deps = await depsForBytes(bytes);
  const source = { blobPath: 'source-collector/test.mp4', bytes: bytes.length, duration: 6 };
  const jpeg = await extractSourceFrame(source, 999, deps);
  assert.equal(jpeg.subarray(0, 3).toString('hex'), 'ffd8ff');
});

test('extractSourceFrames returns one JPEG per requested second, in order', async () => {
  const path = await makeSyntheticVideo();
  const bytes = await readFile(path);
  const deps = await depsForBytes(bytes);
  const source = { blobPath: 'source-collector/test.mp4', bytes: bytes.length, duration: 6 };
  const frames = await extractSourceFrames(source, [0, 2, 4], deps);
  assert.deepEqual(frames.map((f) => f.second), [0, 2, 4]);
  for (const f of frames) assert.equal(f.jpeg.subarray(0, 3).toString('hex'), 'ffd8ff');
});

test('extractSourceContactSheet tiles the whole clip into one JPEG', async () => {
  const path = await makeSyntheticVideo();
  const bytes = await readFile(path);
  const deps = await depsForBytes(bytes);
  const source = { blobPath: 'source-collector/test.mp4', bytes: bytes.length, duration: 6 };
  const sheet = await extractSourceContactSheet(source, 2, deps);
  assert.equal(sheet.jpeg.subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.equal(sheet.tileCount, 3);
  assert.equal(sheet.cols * sheet.rows >= sheet.tileCount, true);
});
