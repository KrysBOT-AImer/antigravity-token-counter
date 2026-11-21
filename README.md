# Token Counter (Antigravity 2.0 Plugin)

[![Antigravity 2.0](https://img.shields.io/badge/Antigravity_2.0-Aux_Pane_Plugin-blue)](https://github.com/KrysBOT-AImer/antigravity-token-counter)
[![Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen)](sidecars/token_counter/package.json)
[![Runtime](https://img.shields.io/badge/Runtime-Node_24%2B_%2F_agy--node-informational)](sidecars/token_counter/sidecar.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Live main-session context token monitor for **Antigravity 2.0**, built to help you avoid context rot and model-specific "Dumb Zone" thresholds in real time without adding a single token to your conversation.

---

## Zero-Context-Rot Architecture

This plugin is an **Aux Pane UI sidecar only** (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`). It intentionally ships **no** `rules/`, `hooks.json`, `skills/`, or `mcp_config.json`, so it adds **0 tokens** to your conversation's context window.

It runs with **zero external dependencies** on Antigravity's bundled `agy-node` runtime (Node 24+ with built-in `node:sqlite` and `sidecar_sdk`)—no `npm install` or external CDNs required.

---

## Key Features

- **Orchestrator v2.1.0 Telemetry Integration**:
  - Reads strict-validated, freshness-checked (`<= 10 min`) guard telemetry from `sidecar_data/token-counter/orchestrator_telemetry/<conv_id>.json`, exposes it on `/api/metrics` + `/api/watch`, and renders a strict guard-mirror 4-zone Hero Card (`green` / `yellow` / `red` / `hard`) with Fork-Gate (`60K`) / Compact (`80K`) pills and a Hard-Gate `/compact` banner.
  - **Resilient Derived-Transcript Fallback**: When the `orchestrator` plugin is installed and enabled (`config/plugins/orchestrator/plugin.json`), automatically derives live `derived_transcript` telemetry from `transcript.jsonl` (`64K / 120K / 160K`, `60K` Fork Gate, or last-known guard thresholds) during `0`-tool conversations, idle gaps (`> 10 min`), and post-`/compact` turns until the next tool call updates guard telemetry (returning `orchestrator: null` when Orchestrator is disabled or uninstalled).
- **Bohemian Art Nouveau UI**:
  - Crisp Flat-Tonal Minimalism across `2700K` dark and `4000K` light themes.

- **Exact Context Telemetry & Compaction Tracking**:
  - Parses `<appDataDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` incrementally and computes exact context held by the model on each `PLANNER_RESPONSE` step:
    ```text
    contextTokens = input_tokens + cache_read_tokens
    ```
  - Detects `CHECKPOINT` compaction steps (`# Resuming from a compaction`), marks compaction boundaries on the chart (preserving pre/post boundaries during downsampling), and resets current-epoch peak and burn-rate calculations.

- **4-Layer Main-Session-Only Isolation**:
  1. **SQLite ancestry & cross-platform lock tracking**: Queries `<appDataDir>/conversation_summaries.db` via `node:sqlite` and detects active sessions cross-platform:
     - **Linux**: Reads `/proc/locks` (`FLOCK` inode matching) and reuses a cached read-only SQLite handle invalidated by `BigInt` file stats.
     - **Windows**: Uses a non-destructive share-lock probe (`openSync('r+')`) plus recent lock/transcript activity liveness, opening and closing SQLite handles per query so Antigravity can rotate or vacuum databases without `EBUSY` errors.
     - Excludes subagents and swarm workers (`nesting_depth >= 1`) and resolves child tabs up to their root main session.
  2. **On-disk ancestry fallback**: Reads `.system_generated/.parent_id_cache.json`, `subagents/*.json`, and `swarm/members.json` when SQLite rows are absent or unavailable.
  3. **Transcript signature verification**: Inspects `SYSTEM_MESSAGE` / `SYSTEM` steps across the transcript for swarm, fork, or subagent signatures and non-explicit child sessions, falling back to an active Main Session rather than leaking child metrics.
  4. **Waiting-orchestrator boost**: In `Auto-Follow Active` mode, waiting main orchestrator sessions with active child workers are prioritized over idle or child-free sessions.

- **Fast, Workspace-Scoped Session Auto-Switching**:
  - Supports **Current Tab**, **Auto-Follow Active**, and **Recent Main Sessions** pinning (up to the 25 most recent main sessions).
  - Enforces strict `workspaceUris` scoping so sessions from other workspaces do not bleed into the current workspace view.
  - Uses `events/*.json` (`rootConversationId`) and nanosecond-precision `annotations/*.pbtxt` (`last_user_view_time`) for instant tab-switch detection.
  - Uses `fs.watch` + `/api/watch` long-polling for instant UI refresh (with a `1500 ms` polling fallback).

- **Stable Dual-Model Orchestrator Detection**:
  - Preserves parent model identity and thresholds for `Orchestrator (Neon)`, `Orchestrator (Carbon)`, and `Orchestrator (Argon)` across internal `gemini-flash-worker-agy` execution turns while continuing to display exact per-turn context token counts.

- **Model-Aware Threshold Profiles & `/compact` Quick-Copy**:
  - Defaults to **Auto (Model Profile)** using a 3-tier model detection pipeline:
    1. `PLANNER_RESPONSE.model` in `transcript.jsonl`
    2. `<USER_SETTINGS_CHANGE>` model-selection events in `USER_INPUT` steps (including mid-session model switches)
    3. `<appDataDir>/conversations/<cid>.db` (`gen_metadata` protobuf fields)
  - Supports **Manual Override** in the Settings drawer with quick presets and custom thresholds (`1,000 – 2,000,000`, gauge ceiling up to `5,000,000`).
  - Displays a `/compact` quick-copy alert banner when the Dumb Zone threshold is reached.

---

## Model Profile Table

In `Auto` mode, thresholds are automatically selected from the detected model (matching `sidecars/token_counter/lib/settings.mjs`):

| Profile | Model Pattern | Caution | Dumb Zone | Gauge Ceiling |
| :--- | :--- | ---: | ---: | ---: |
| **Hydrogen** | `gemini-4-hydrogen*` / `Gemini 4 Hydrogen (*)` / `Orchestrator (Hydrogen)` / standalone `gemini-flash-worker-agy` | 90,000 | 130,000 | 200,000 |
| **Orchestrator (Neon)** | `gemini-pro-orchestrator-neon*` / `Orchestrator (Neon)` | 120,000 | 175,000 | 250,000 |
| **Orchestrator (Argon)** | `gemini-pro-orchestrator-argon*` / `gemini-pro-orchestrator-g1-pro*` / `Orchestrator (Argon)` | 120,000 | 175,000 | 250,000 |
| **Neon** | `gemini-4-neon*` / `Gemini 4 Neon (*)` | 140,000 | 200,000 | 300,000 |
| **Orchestrator (Carbon)** | `gemini-pro-orchestrator` / `*-carbon*` / `Orchestrator (Carbon)` | 150,000 | 200,000 | 300,000 |
| **Carbon** | `gemini-4-carbon*` / `Gemini 4 Carbon (*)` | 160,000 | 220,000 | 320,000 |
| **Default Fallback** | Unrecognized models | 120,000 | 175,000 | 250,000 |

---

## Installation

### Option 1: From GitHub Release Bundle

1. Download the latest release archive (`antigravity-token-counter-v1.0.0.tar.gz` or `.zip`) from the [Releases](https://github.com/KrysBOT-AImer/antigravity-token-counter/releases) page.
2. Extract it into Antigravity's global plugins directory as `token-counter`:

   **Linux / macOS:**
   ```bash
   mkdir -p "$HOME/.gemini/config/plugins/token-counter"
   tar -xzf antigravity-token-counter-v1.0.0.tar.gz -C "$HOME/.gemini/config/plugins/token-counter" --strip-components=1
   ```

   **Windows (PowerShell):**
   ```powershell
   New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.gemini\config\plugins" | Out-Null
   Expand-Archive -Path "antigravity-token-counter-v1.0.0.zip" -DestinationPath "$env:USERPROFILE\.gemini\config\plugins\token-counter" -Force
   ```

### Option 2: From Source (Symlink / Junction)

Clone the repository and link it into Antigravity's global plugins directory:

**Linux / macOS:**
```bash
ln -sfn "<path-to-antigravity-token-counter>" "$HOME/.gemini/config/plugins/token-counter"
```

**Windows (PowerShell — no Administrator privileges or Developer Mode required):**
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.gemini\config\plugins" | Out-Null
New-Item -ItemType Junction -Path "$env:USERPROFILE\.gemini\config\plugins\token-counter" -Target "<path-to-antigravity-token-counter>"
```

### Enabling the Plugin

1. Reload or restart Antigravity 2.0 if it is already running.
2. Open **Plugins Manager** and enable **Token Counter**.
3. Open the **Token Counter** panel in the **Aux Pane**.

---

## Configuration & Persistence

User preferences persist automatically in `ANTIGRAVITY_EXECUTABLE_DATA_DIR/settings.json` (with legacy fallback migration if an older config exists).

```json
{
  "trackingMode": "current_tab",
  "pinnedSessionId": null,
  "thresholdMode": "auto",
  "cautionThreshold": 120000,
  "dumbZoneThreshold": 175000,
  "gaugeCeiling": 250000
}
```

| Field | Values / Range | Default | Description |
| :--- | :--- | :--- | :--- |
| `trackingMode` | `"current_tab"` \| `"auto_follow"` \| `"pinned"` | `"current_tab"` | Session selection mode. |
| `pinnedSessionId` | `string \| null` | `null` | Target conversation UUID when `trackingMode` is `"pinned"`. |
| `thresholdMode` | `"auto"` \| `"manual"` | `"auto"` | Automatic model-profile thresholds or manual override. |
| `cautionThreshold` | `1,000 – 2,000,000` | `120000` | Caution threshold (used in `manual` mode; must be `< dumbZoneThreshold`). |
| `dumbZoneThreshold` | `1,000 – 2,000,000` | `175000` | Dumb Zone alert threshold (used in `manual` mode; must be `> cautionThreshold`). |
| `gaugeCeiling` | `1,000 – 5,000,000` | `250000` | Chart/gauge upper bound (must be `>= dumbZoneThreshold`). |

---

## Sidecar HTTP API Reference

The sidecar serves its Aux Pane UI and local JSON API over loopback HTTP:

| Method & Path | Description |
| :--- | :--- |
| `GET /` | Serves `sidecars/token_counter/ui/index.html`. |
| `GET /styles.css` | Serves `sidecars/token_counter/ui/styles.css`. |
| `GET /app.js` | Serves `sidecars/token_counter/ui/app.js`. |
| `GET /api/metrics` | Returns current session telemetry, model detection, active thresholds, compaction epochs, and chart points. |
| `GET /api/sessions` | Returns up to 25 recent main sessions scoped to the active workspace(s). |
| `GET /api/settings` | Returns the current persisted settings from `settings.json`. |
| `POST /api/settings` | Validates, updates, and persists settings (`trackingMode`, `pinnedSessionId`, `thresholdMode`, thresholds). |
| `GET /api/watch` | Long-poll endpoint backed by `fs.watch` that resolves on transcript/event/annotation changes. |

---

## Project Structure

```text
.
├── assets/
│   └── logo.svg                     # Plugin icon
├── sidecars/
│   └── token_counter/
│       ├── lib/
│       │   ├── discovery.mjs        # 4-layer main-session isolation & workspace scoping
│       │   ├── gen_metadata.mjs     # SQLite gen_metadata protobuf model fallback
│       │   ├── settings.mjs         # Model profiles, thresholds & settings persistence
│       │   └── transcript.mjs       # Incremental transcript.jsonl & compaction parser
│       ├── ui/
│       │   ├── app.js               # Aux Pane client logic, chart & /api/watch loop
│       │   ├── index.html           # Aux Pane markup
│       │   └── styles.css           # Aux Pane styles
│       ├── main.mjs                 # Sidecar entrypoint, HTTP server & fs.watch bridge
│       ├── package.json             # ESM module manifest (zero dependencies)
│       └── sidecar.json             # Antigravity sidecar entrypoint config
├── tests/
│   ├── discovery.test.mjs
│   ├── server.test.mjs
│   ├── settings.test.mjs
│   └── transcript.test.mjs
├── CHANGELOG.md
├── LICENSE
├── README.md
└── plugin.json
```

---

## Development & Verification

Run syntax checks and the automated test suite using Antigravity's bundled `agy-node` runtime (or Node 24+ `node` on `PATH`):

### Linux / macOS

```bash
"$HOME/.config/Antigravity/bin/agy-node" --check sidecars/token_counter/ui/app.js
"$HOME/.config/Antigravity/bin/agy-node" --check sidecars/token_counter/main.mjs
"$HOME/.config/Antigravity/bin/agy-node" --test tests/*.test.mjs
```

### Windows (PowerShell)

```powershell
& "$env:LOCALAPPDATA\Programs\Antigravity\bin\agy-node.exe" --check sidecars\token_counter\ui\app.js
& "$env:LOCALAPPDATA\Programs\Antigravity\bin\agy-node.exe" --check sidecars\token_counter\main.mjs
& "$env:LOCALAPPDATA\Programs\Antigravity\bin\agy-node.exe" --test tests\*.test.mjs
```

If `node` (v24+) is on your `PATH`, you can substitute `node` for `agy-node`.

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
