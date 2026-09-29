// App/release constants Single Source of Truth.
export const APP_VERSION = "5.1.0";
export const DB_VERSION_DISPLAY = 2;
export const PRODUCTION_SCHEMA_VERSION = "2.1";

// Alpha 39 — 2026-09-15 SIMPLE PRODUCTION RESET.
// New production defaults to GPT MASTER storyboard + manual Gemini image handoff +
// CapCut narration + Tracker assembly. Legacy episodes remain readable through the old path.
// Alpha 70 — SOURCE-FIRST 원본 분석 결과 붙여넣기. 서버 ffmpeg frame extraction으로 분석한
// trim/beat 결과를 ep.sourceFirstPlan에 반영하는 공용(비-하드코딩) import 기능.
export const RELEASE_CHANNEL = "alpha";
export const RC_ITERATION = 70;
export const RELEASE_LABEL = RELEASE_CHANNEL === "stable" ? "Stable" : RELEASE_CHANNEL === "alpha" ? `Alpha ${RC_ITERATION}` : RELEASE_CHANNEL === "beta" ? `Beta ${RC_ITERATION}` : RELEASE_CHANNEL === "rc" ? `Release Candidate (RC ${RC_ITERATION})` : RELEASE_CHANNEL;

export const BACKUP_FORMAT_VERSION_LIGHT = "1.1";
export const BACKUP_FORMAT_VERSION_FULL = "1.0";
export const APP_DISPLAY_NAME = "Content Production Tracker";
