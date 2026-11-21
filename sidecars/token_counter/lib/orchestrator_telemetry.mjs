import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_TELEMETRY_STALE_MS = 10 * 60 * 1000;
export const VALID_ORCHESTRATOR_ZONES = new Set(['green', 'yellow', 'red', 'hard']);

const REQUIRED_THRESHOLD_KEYS = ['fork_max', 'yellow', 'red', 'hard'];

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

  if (!obj.thresholds || typeof obj.thresholds !== 'object' || Array.isArray(obj.thresholds)) {
    return null;
  }
  for (const key of REQUIRED_THRESHOLD_KEYS) {
    const val = obj.thresholds[key];
    if (!Number.isFinite(val) || val <= 0) return null;
  }

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
    thresholds: {
      fork_max: Math.round(obj.thresholds.fork_max),
      yellow: Math.round(obj.thresholds.yellow),
      red: Math.round(obj.thresholds.red),
      hard: Math.round(obj.thresholds.hard),
    },
  };
}
