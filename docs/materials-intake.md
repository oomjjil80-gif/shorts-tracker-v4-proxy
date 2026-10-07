# 소재 보관함 auto intake

A scheduled GPT task registers the day's curated materials, and they show up in the Tracker 소재 보관함. Nobody has to paste anything.

- Storage is the existing R2 bucket (the same `JobBlobStore` the jobs use). Everything lives in one index file, `materials/v1/production/index.json`.
- There is no new database and no queue.

## Setup (Railway service, once)

| Variable | Value |
|---|---|
| `MATERIALS_INTAKE_TOKEN` | A random secret of at least 24 characters, given only to the scheduled task. Never put it in the frontend. |

If the token is not set, intake answers `503 INTAKE_NOT_CONFIGURED`, so the endpoint stays closed.

## Register materials (scheduled task, e.g. 07:00)

```
POST https://<railway-api>/api/materials/intake
Authorization: Bearer <MATERIALS_INTAKE_TOKEN>
Content-Type: application/json

{ "materials": [
  { "materialKind": "source_video", "title": "…", "sourceUrl": "https://www.tiktok.com/…", "summary": "…", "reviewStatus": "approved" },
  { "materialKind": "topic", "title": "…", "summary": "…", "channelKey": "economy_current", "sources": [{ "name": "…", "url": "…" }] }
] }
```

**Required fields**

- `materialKind` is either `source_video` (영상소재) or `topic` (일반소재).
- `title` is required.
- `sourceUrl` is also required when the kind is `source_video`.

**Other fields** follow SPT-IDEA-1:

- `summary`, `sources`, `channelKey`, `contentFormat`, `productionProfile`, `category`, `keywords`
- `scores`, `reviewStatus`
- `whyNow`, `viewerValue`, `verifiedFacts`, `claimsToVerify`, `hookCandidates`, `riskNote`
- `topicKey`

A request may carry at most 200 items.

**Duplicates are never stored:**

- A `source_video` with the same video URL as an existing one is skipped. Before comparing, the host is lower-cased, `www.` and `m.` are dropped, and tracking parameters are removed.
- A `topic` with the same title as an existing one is skipped, or the same `topicKey` when one is given. Titles are compared without case, spaces or punctuation.
- Sending the same request again stores nothing new.

**Response:**

```
{ ok, saved: [{ id, title, materialKind }], duplicates: [...], invalid: [{ index, reason }], total }
```

## Read (the Tracker browser)

`GET /api/materials` uses the browser's existing `X-Sync-Key` header and returns `{ ok, materials: [...] }`.

소재 보관함 shows these materials together with the ones saved in the browser:

- `source_video` appears on the 영상소재 tab and `topic` on the 일반소재 tab.
- A local record always wins, and nothing is copied or migrated.
