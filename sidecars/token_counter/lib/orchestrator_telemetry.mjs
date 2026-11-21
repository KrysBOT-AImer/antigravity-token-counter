import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_TELEMETRY_STALE_MS = 10 * 60 * 1000;
export const VALID_ORCHESTRATOR_ZONES = new Set(['green', 'yellow', 'red', 'hard']);
export const DEFAULT_ORCHESTRATOR_THRESHOLDS = Object.freeze({
  fork_max: 60_000,
  yellow: 64_000,
  red: 120_000,
  hard: 160_000,
});
export const DEFAULT_COMPACT_RECOMMENDED_TOKENS = 80_000;

const REQUIRED_THRESHOLD_KEYS = ['fork_max', 'yellow', 'red', 'hard'];

function parsePositiveIntEnv(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function extractValidThresholds(thresholds) {
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    return null;
  }
  for (const key of REQUIRED_THRESHOLD_KEYS) {
    const val = thresholds[key];
    if (!Number.isFinite(val) || val <= 0) return null;
  }
  return {
    fork_max: Math.round(thresholds.fork_max),
    yellow: Math.round(thresholds.yellow),
    red: Math.round(thresholds.red),
    hard: Math.round(thresholds.hard),
  };
}

/**
 * Resolve default Orchestrator v2.1.0 thresholds with optional env overrides.
 */
export function resolveDefaultOrchestratorThresholds(env = process.env) {
  const result = { ...DEFAULT_ORCHESTRATOR_THRESHOLDS };
  if (!env || typeof env !== 'object') return result;

  const forkMax = parsePositiveIntEnv(env.ORCHESTRATOR_FORK_MAX_TOKENS);
  if (forkMax !== null) result.fork_max = forkMax;

  const hardMax = parsePositiveIntEnv(env.ORCHESTRATOR_HARD_CONTEXT_TOKENS);
  if (hardMax !== null) result.hard = hardMax;

  return result;
}

/**
 * Check whether the Orchestrator plugin is installed and enabled next to appDataDir.
 * Fails closed (false) if appDataDir is missing or plugin.json is absent;
 * defaults to true when plugin.json exists unless config.json explicitly sets enabled: false.
 */
export function isOrchestratorPluginEnabled(appDataDir) {
  if (!appDataDir || typeof appDataDir !== 'string' || !appDataDir.trim()) return false;
  try {
    const configDir = join(dirname(appDataDir), 'config');
    const pluginJsonPath = join(configDir, 'plugins', 'orchestrator', 'plugin.json');
    if (!existsSync(pluginJsonPath)) return false;

    const configPath = join(configDir, 'config.json');
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw);
      if (cfg?.plugins?.orchestrator?.enabled === false) return false;
    } catch {
      // Missing or unreadable config.json defaults to enabled when plugin.json exists.
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize a conversation ID to match orchestrator_guard.py filename rules.
 * Returns null if empty or invalid (e.g. path traversal or separators).
 */
export function sanitizeTelemetryConvId(convId) {
  if (convId === null || convId === undefined) return null;
  const raw = String(convId).trim();
  if (
    !raw ||
    raw === '.' ||
    raw === '..' ||
    raw.includes('..') ||
    raw.includes('/') ||
    raw.includes('\\')
  ) {
    return null;
  }
  const safe = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  if (!safe || safe === '.' || safe === '..') return null;
  return safe;
}

/**
 * Resolve the orchestrator_telemetry directory inside appDataDir.
 */
export function resolveOrchestratorTelemetryDir(appDataDir) {
  if (!appDataDir || typeof appDataDir !== 'string' || !appDataDir.trim()) return null;
  return join(appDataDir, 'sidecar_data', 'token-counter', 'orchestrator_telemetry');
}

/**
 * Resolve the telemetry JSON path for a given conversation ID.
 */
export function orchestratorTelemetryPathFor(appDataDir, convId) {
  const dir = resolveOrchestratorTelemetryDir(appDataDir);
  if (!dir) return null;
  const safeId = sanitizeTelemetryConvId(convId);
  if (!safeId) return null;
  return join(dir, `${safeId}.json`);
}

/**
 * Fail-open stat for a conversation's orchestrator telemetry file.
 */
export function statOrchestratorTelemetry(appDataDir, convId) {
  const filePath = orchestratorTelemetryPathFor(appDataDir, convId);
  if (!filePath) return null;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    return { mtimeMs: st.mtimeMs, size: st.size, path: filePath };
  } catch {
    return null;
  }
}

/**
 * Strictly read, validate, and freshness-check an orchestrator telemetry file.
 * Returns a normalized object or null if missing, invalid, or stale.
 */
export function readOrchestratorTelemetry(
  appDataDir,
  convId,
  { nowMs = Date.now(), maxAgeMs = DEFAULT_TELEMETRY_STALE_MS } = {}
) {
  const filePath = orchestratorTelemetryPathFor(appDataDir, convId);
  if (!filePath) return null;

  let obj;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    obj = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.schema_version !== 1) return null;
  if (typeof obj.zone !== 'string' || !VALID_ORCHESTRATOR_ZONES.has(obj.zone)) return null;
  if (!Number.isFinite(obj.active_tokens) || obj.active_tokens < 0) return null;
  if (typeof obj.fork_eligible !== 'boolean') return null;
  if (typeof obj.compact_recommended !== 'boolean') return null;
  if (typeof obj.timestamp !== 'string') return null;

  const tsMs = Date.parse(obj.timestamp);
  if (!Number.isFinite(tsMs)) return null;
  const ageMs = Math.max(0, nowMs - tsMs);
  if (ageMs > maxAgeMs) return null;

  const validThresholds = extractValidThresholds(obj.thresholds);
  if (!validThresholds) return null;

  return {
    schema_version: 1,
    conversation_id: typeof obj.conversation_id === 'string' ? obj.conversation_id : String(convId),
    timestamp: obj.timestamp,
    ageMs,
    active_tokens: Math.round(obj.active_tokens),
    source: typeof obj.source === 'string' ? obj.source : 'unknown',
    zone: obj.zone,
    fork_eligible: obj.fork_eligible,
    compact_recommended: obj.compact_recommended,
    thresholds: validThresholds,
  };
}

/**
 * Read thresholds from the last telemetry file regardless of staleness.
 * Returns normalized thresholds or null if missing or invalid.
 */
export function readLastKnownOrchestratorThresholds(appDataDir, convId) {
  const filePath = orchestratorTelemetryPathFor(appDataDir, convId);
  if (!filePath) return null;

  let obj;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    obj = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.schema_version !== 1) return null;
  return extractValidThresholds(obj.thresholds);
}

/**
 * Derive Orchestrator v2.1.0 telemetry directly from live transcript token counts.
 */
export function deriveOrchestratorTelemetry(
  convId,
  activeTokens,
  { thresholds, timestamp, nowMs = Date.now(), env = process.env } = {}
) {
  const tokens = Number.isFinite(activeTokens) && activeTokens >= 0 ? Math.round(activeTokens) : 0;
  const resolvedThresholds =
    extractValidThresholds(thresholds) || resolveDefaultOrchestratorThresholds(env);

  let zone = 'green';
  if (tokens >= resolvedThresholds.hard) zone = 'hard';
  else if (tokens >= resolvedThresholds.red) zone = 'red';
  else if (tokens >= resolvedThresholds.yellow) zone = 'yellow';

  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const isoTs =
    typeof timestamp === 'string' && timestamp.trim()
      ? timestamp
      : new Date(safeNowMs).toISOString();

  return {
    schema_version: 1,
    conversation_id: String(convId),
    timestamp: isoTs,
    ageMs: 0,
    active_tokens: tokens,
    source: 'derived_transcript',
    zone,
    fork_eligible: tokens <= resolvedThresholds.fork_max,
    compact_recommended: tokens >= DEFAULT_COMPACT_RECOMMENDED_TOKENS,
    thresholds: resolvedThresholds,
  };
}
