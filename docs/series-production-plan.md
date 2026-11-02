# Series production plan: existing Job/Worker integration

An opt-in `job_create.input.productionPlan` is validated before persistence, copied into the immutable generative brief and included in its hash and Job deduplication identity. The Job/recipe transaction, stage order and legacy briefs are unchanged. Edited plans create a new Job with a new idempotency key and fresh SCRIPT_APPROVAL; they never mutate a running or approved Job.

## Executable contract

Use the existing `senior_longform` or `yasa_longform` profile with `longform_script_approval`. A video plan has exactly one `script` step containing the complete existing Longform script in `config.script`, one `image` step per script scene (matching `sceneId` and order), one `voice` and one `render` step. Existing script validation, metadata, character and card rules apply. Image prompts come from the stored script scenes and existing visual-style resolver; voice/render settings come from the existing brief. Unsupported/ignored configuration is rejected. `maxCostUsd`, if provided, bounds the Job budget; scene count is validated.

Carousel, one-image Wisdom, reference-image/Golden or thumbnail-first plans and remaster/sleep combinations are rejected before writing or calling a provider. Their existing non-plan routes remain unchanged. This integration does not introduce a renderer or replace the existing profile rules.

## Execution and recovery

PLAN persists the supplied validated script. The existing server SCRIPT_APPROVAL hash gate must pass before ASSET. ASSET uses the existing Gemini image provider, image/TTS caches, narration assembler, per-call budget guard and usage ledger. Only a changed resolved scene input produces a new image. A repeated narration chunk shares its in-flight result.

Scene artifacts are scoped by workspace, plan ID, scene ID and input hash. An atomic durable `.started` claim precedes a provider call. The output bytes and existing Longform cache entry are saved before the immutable scene result. Worker restart recovers a completed result or a valid cache checkpoint. If a provider may have been called but there is no recoverable output, the stage fails with `SCENE_GENERATION_UNCERTAIN`, without automatic paid retry. This is an at-most-once safety stop, not a claim of exactly-once external API execution.

## Free verification

`tools/series-job-e2e.test.ts` uses the real Job HTTP handler, SQL store, recipe gate, worker loop and Longform PLAN/ASSET; only external HTTP responses and object storage are mocked. Object data survives reconstruction of the file-backed storage and Worker adapters. It verifies 3 images, an edit of scene 2, exactly 1 new image, unchanged scene 1/3 refs, TTS reuse, persisted output read-back, approval, budget, concurrent execution and interrupted-call recovery. No Production request or paid API call is required. Mock usage ledger dollars are estimates for fixtures, not real charges.
