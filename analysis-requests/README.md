# Assistant source-analysis requests

Dropping a JSON file here triggers the existing Production Source Collector and creates a temporary GitHub Actions artifact containing the collected MP4, ffprobe metadata, 2-fps frame extraction, and mono WAV audio.

Request shape:

```json
{"sourceUrl":"https://..."}
```

This is an assistant-access bridge only. It reuses the existing Collector; it does not add a second downloader.
