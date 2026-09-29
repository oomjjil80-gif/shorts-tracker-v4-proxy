// Deterministic synthetic test source (no network, no binary fixtures in git): 576x1024 @30fps, 12s, AAC.
//  0-3s testsrc2 | 3-6s smptebars | 6-9s yuvtestsrc (audio silent) | 9-12s rgbtestsrc. Optional black hole in 4-5.5s.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runOk } from '../../lib/media/ffmpeg.js'

export async function makeSyntheticSource(out: string, o: { withBlack?: boolean; noAudio?: boolean } = {}) {
  mkdirSync(dirname(out), { recursive: true })
  const size = 's=576x1024:r=30'
  const seg = (src: string, i: number) => `${src}=${size}:d=3,format=yuv420p,setsar=1[v${i}]`
  const black = o.withBlack ? `;[v1]drawbox=x=0:y=0:w=576:h=1024:color=black:t=fill:enable='between(t,1,2.5)'[v1b]` : ''
  const cat = o.withBlack ? '[v0][v1b][v2][v3]' : '[v0][v1][v2][v3]'
  const graph = `${[seg('testsrc2', 0), seg('smptebars', 1), seg('yuvtestsrc', 2), seg('rgbtestsrc', 3)].join(';')}${black};${cat}concat=n=4:v=1:a=0[v]`
  const args = ['-y', '-filter_complex', graph]
  if (!o.noAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=12,volume=volume='if(between(t,6,9),0,0.5)':eval=frame`)
  args.push('-map', '[v]')
  if (!o.noAudio) args.push('-map', '0:a')
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', '30')
  if (!o.noAudio) args.push('-c:a', 'aac', '-b:a', '128k')
  args.push('-movflags', '+faststart', '-t', '12', out)
  await runOk(args)
  return out
}
