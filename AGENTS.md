# Tracker execution rules (mandatory for AI coding agents)

Goal: ship a verified user-visible fix quickly. Avoid work-for-work, repeated audits, and unnecessary AI/API usage.

## 1. Classify change before testing
- **NARROW** (copy, metadata, single validator/prompt, single isolated module): run only directly affected tests and typecheck if TypeScript changed. Do not run the full test suite locally by default.
- **FEATURE** (multiple connected modules): run related module/integration tests and typecheck. Add one focused regression test for the reported failure.
- **CORE/RISKY** (shared job state machine, persistence schema, auth, billing, deployment, cross-profile behavior): run the full suite once when justified.
- Existing GitHub required CI checks remain mandatory for merge. Do not bypass, disable, or weaken CI checks to save time. Avoid duplicating the same suite locally and in CI without a reason.

## 2. Hard execution budget
- Before work: identify the exact symptom, affected path, one acceptance check, and rollback/stop condition.
- Max **one initial test run + one rerun** of a given test after a change. If still failing, stop and report the exact blocker; do not loop blindly.
- Do not wait/poll for CI repeatedly. Start CI once; inspect the result when available. Do not create background waiting loops that consume agent time.
- A pre-existing unrelated failure is reported with evidence and separated from the change; do not repair it under the same task.
- No broad refactoring, additional features, or unrelated cleanup while fixing a narrow issue.
- Avoid repeated multi-agent handoffs and independent re-audits unless the change is high risk or a concrete blocker exists.

## 3. Completion is production evidence, not green tests
- Report these as distinct states: CODE READY, FOCUSED TEST PASS, CI PASS, MERGED, DEPLOYED, PRODUCTION VERIFIED.
- Never say DONE until the exact user-visible acceptance criterion is observed in production.
- For metadata-only recovery, check all expected fields and verify original video/thumbnail references remain unchanged.
- HTTP 200 alone is insufficient: inspect response semantics and persisted read-back.
- Do not rerender video, image, thumbnail, or TTS to repair metadata.

## 4. Paid calls and one-shot recovery
- First reproduce validation failures with a deterministic, zero-cost fixture and focused test.
- Before a paid production recovery, confirm correct deployment SHA, authentication route, and pre-recovery state.
- One POST only, with automatic retries disabled; on timeout, GET the persisted state before considering another request.
- Do not expose credentials in logs or chat. Prefer existing secrets in GitHub Actions.
- Record actual API calls and verified cost when available; never report estimates as actual charges.
- Obtain user authorization for any new paid action or risky production mutation not already approved.

## 5. Response and handoff
- Keep updates short: what changed, focused tests, production state, next single action.
- A handoff is only for an actual blocked dependency; include precise commit/PR, job ID, failing criterion, and action.
- Do not claim success for an unexecuted step. No extra audits after acceptance.

This document guides agent behavior; it does not replace repository branch protections, required CI, or production safety gates.
