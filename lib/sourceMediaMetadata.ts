import mediaInfoFactory from 'mediainfo.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Read the collected bytes, never a platform page or client-supplied duration.
// A separate instance per request keeps concurrent Function calls independent.
export async function probeSourceMedia(bytes: Buffer) {
  const info = await mediaInfoFactory({
    format: 'object',
    locateFile: () => require.resolve('mediainfo.js/MediaInfoModule.wasm')
  })
  try {
    const result = await info.analyzeData(bytes.length, (size, offset) => bytes.subarray(offset, offset + size))
    const tracks = result.media?.track || []
    const video = tracks.find(t => t['@type'] === 'Video')
    const general = tracks.find(t => t['@type'] === 'General')
    const audio = tracks.find(t => t['@type'] === 'Audio')
    const duration = Number(general?.Duration || video?.Duration)
    const width = Number(video?.Width), height = Number(video?.Height)
    if (!video || !Number.isFinite(duration) || duration <= 0 || !width || !height) {
      throw new Error('Collected file has no readable video duration or dimensions')
    }
    return { duration, width, height, videoCodec: String(video.Format || ''), audioCodec: audio ? String(audio.Format || '') : null }
  } finally { info.close() }
}
