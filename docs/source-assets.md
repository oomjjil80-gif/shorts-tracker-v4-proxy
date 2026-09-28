# Source Asset Registry v1

The existing Douyin browser-v1 and other-platform Cobalt resolvers are unchanged.
After downloading a video, the server probes its actual bytes with MediaInfo,
stores the original unmodified file in the existing private Blob store, then
writes an immutable private JSON record. Collection succeeds only after both writes.

## Durable storage

Records: `source-assets/v1/production/{sourceAssetId}.json`.
Preview/development use separate namespaces. No expiry, in-memory database,
mutable latest pointer, browser storage, or additional provisioned service is used.
IDs contain a reverse millisecond timestamp and random UUID. Blob's documented
lexicographic listing therefore returns newest records first with cursor pagination.
Concurrent writes cannot overwrite each other. All metadata comes from the server;
clients cannot register arbitrary Blob paths or overwrite assets.

Each record includes sourceAssetId, original collector id, platform (original
hostname for compatibility), originalUrl, blobPath, filename, bytes, duration in
seconds, width/height in pixels, createdAt, collectedAt, contentType, SHA-256,
video/audio codec, and the available original title/videoId/resolver metadata.
Signed playback URLs are never persisted in the registry. Records and MP4s are
private; the existing read-write token stays only in server environment variables.
This is the existing Tracker project's shared workspace, not a multi-tenant user
database. The API keeps its existing access model and allowed frontend origins.

## API

Production endpoint: `https://shorts-tracker-v4-proxy.vercel.app/api/story`
Use POST JSON with Content-Type application/json:

```json
{"taskType":"source_collect","sourceUrl":"https://platform.example/video/..."}
```

Response: `{ok:true,needsSelection:false,sourceAssetId,source:{...metadata}}`.
Cobalt multi-item picker responses stay unchanged and have no asset until collected.

```json
{"taskType":"source_latest","limit":10}
```

Response: `{ok:true,source:<latest or null>,sources:[...],hasMore,cursor}`.
Pass cursor for the next page. Limit defaults to 10, allowed range 1–50.

```json
{"taskType":"source_asset","sourceAssetId":"src_..."}
```

Response: `{ok:true,source:{...metadata}}`. Unknown valid IDs return HTTP 404.

```json
{"taskType":"source_playback","sourceAssetId":"src_..."}
```

Response: `{ok:true,sourceAssetId,playbackUrl,validUntil}`. Fetch playbackUrl with
**GET** (including Range GET for seeking). It expires after one hour. HEAD is not
covered by this GET signature. Request another URL when it expires. The previous
`{taskType:"source_playback",blobPath:"source-collector/..."}` contract still works.

The three read operations also accept GET query parameters, for tools that cannot
send POST: `/api/story?taskType=source_latest`,
`/api/story?taskType=source_asset&sourceAssetId=src_...`, and
`/api/story?taskType=source_playback&sourceAssetId=src_...`.
Their responses use `Cache-Control: private, no-store`.

## Agent workflow

1. Call source_latest, independent of the user's browser/localStorage.
2. Select the intended sourceAssetId by originalUrl/title/time.
3. Call source_asset by that ID to retrieve the permanent metadata.
4. Call source_playback by that ID and GET the MP4.
5. Check byte count/SHA-256 against the record; analyze this exact original.

New sources are automatically registered. Previous local-only items/Episodes
remain usable through blobPath, but are not automatically backfilled. No user's
existing Episode is rewritten. Frontend cached records, activeSource, Episode
sourceMedia, Source-first plan, and source-video cuts preserve sourceAssetId.

## Verification

`node --import tsx --test tools/source-collector.test.ts tools/source-assets.test.ts`
tests storage failure gating, immutable concurrent records, pagination, namespace
isolation, invalid IDs/paths, and existing collector contracts.

`NODE_USE_ENV_PROXY=1 node tools/source-collector-e2e.mjs <original-source-url>`
performs real collection → ID metadata → ID playback → MP4 GET and hash → latest
lookup → GET read API → legacy playback → unsigned-Blob denial. It writes ignored
E2E evidence without signed credentials. Use ffprobe/full ffmpeg decode on its
downloaded playback.mp4, and verify the Production Source Collector UI separately.
