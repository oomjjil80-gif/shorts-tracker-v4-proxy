# Source Collector verification

Douyin uses `lib/douyinResolver.ts`, which runs the public player in Chromium.
Instagram and the other existing platforms continue through Cobalt in
`lib/sourceCollector.ts`. Douyin does not need a Cobalt setting or key.

The browser resolver waits for the requested video ID's CDN stream. The initial
player asset on `douyinstatic.com` is not a source video and must not be stored.
Browser and Puppeteer versions are pinned together. There is no external public
download API, stored test-video URL, borrowed cookie, or signature service.

Douyin Blob filenames use the ASCII video ID. The Chinese title is stored in
`source.title`; placing it in the Blob pathname caused signed-token scope
validation to fail during the actual preview E2E check.

Collection checks HTTPS sources, media hosts and redirect destinations, size,
nonempty bytes, and the MP4 signature before storing Douyin data in private Blob.
Browser verification challenges fail explicitly; the resolver does not solve them.
`DOUYIN_PLAYER_TIMEOUT` means the player did not supply a matching stream in time.

## Checks

```sh
npm ci
node --import tsx --test tools/source-collector.test.ts
npx tsc --noEmit
```

Run the real acceptance test against the deployment being evaluated:

```sh
TRACKER_API_BASE=https://shorts-tracker-v4-proxy.vercel.app \
E2E_OUTPUT_DIR=.e2e/production-douyin \
node tools/source-collector-e2e.mjs https://www.douyin.com/video/7686048214555031878
```

This submits only `sourceUrl` to `source_collect`, requires `ok:true`,
`needsSelection:false`, a `blobPath` and positive byte count, then calls
`source_playback` and downloads the resulting URL. It checks GET 200, exact byte
count and MP4 signature, records HEAD status, and saves a SHA-256 and report.
Temporary signed playback credentials are not logged or written to the report.

Inspect the retrieved media too:

```sh
ffprobe -v error -show_entries format=duration,size:stream=codec_name,codec_type,width,height \
  -of json .e2e/production-douyin/playback.mp4
ffmpeg -v error -i .e2e/production-douyin/playback.mp4 -f null -
```

Repeat the E2E command with a known working Instagram URL as a regression check.
Deployment `READY` and fixture tests alone are not acceptance. Report completion
only after the actual production collection, Blob write and playback GET pass.
Raw recordings and temporary test outputs stay in ignored `.e2e/`.
