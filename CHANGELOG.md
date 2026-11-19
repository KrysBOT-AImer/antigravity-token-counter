# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-20

### Added
- **Zero-Context-Rot Aux Pane UI**: Sidecar-only Antigravity 2.0 plugin (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) with zero `rules/`, `hooks.json`, `skills/`, or `mcp_config.json`, adding `0` tokens to conversation context.
- **Incremental Transcript Telemetry & Compaction Tracking**: Computes exact context usage (`input_tokens + cache_read_tokens`) from `transcript.jsonl`, detects `CHECKPOINT` compaction boundaries, marks pre/post compaction transitions on the chart, and resets current-epoch peak and burn-rate calculations.
- **4-Layer Main-Session-Only Isolation**: Combines SQLite ancestry & cross-platform lock tracking (`/proc/locks` on Linux, share-lock probe on Windows), on-disk ancestry fallbacks (`.parent_id_cache.json`, `subagents/*.json`, `swarm/members.json`), transcript signature verification, and waiting-orchestrator priority boosting.
- **Strict Workspace-Scoped Auto-Switching & Instant Push**: Supports `Current Tab`, `Auto-Follow Active`, and `Recent Main Sessions` pinning with strict `workspaceUris` scoping, nanosecond `annotations/*.pbtxt` precision, and `fs.watch` + `/api/watch` long-polling (with `1500 ms` polling fallback).
- **Dual-Model Orchestrator Detection**: Preserves parent model identity and thresholds for `Orchestrator (Neon)`, `Orchestrator (Carbon)`, and `Orchestrator (Argon)` across internal `gemini-flash-worker-agy` execution turns while tracking exact per-turn context tokens.
- **Model-Aware Profiles & Settings Persistence**: 3-tier model detection pipeline, `Auto` model-specific caution/dumb-zone thresholds (with `120K / 175K / 250K` default fallback), `Manual Override` presets and custom limits (`1,000–2,000,000`, ceiling up to `5,000,000`), `/compact` quick-copy alert banner, and persistence in `ANTIGRAVITY_EXECUTABLE_DATA_DIR/settings.json`.
- **Automated Test Suite**: 43 automated unit and integration tests covering transcript parsing, session discovery, settings/model profiles, and HTTP server endpoints.
