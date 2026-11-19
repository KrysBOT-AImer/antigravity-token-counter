import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  thresholdMode: 'auto',
  cautionThreshold: 120000,
  dumbZoneThreshold: 175000,
  gaugeCeiling: 250000,
  trackingMode: 'current',
  pinnedSessionId: '',
});

export const MIN_THRESHOLD = 1000;
export const MAX_THRESHOLD = 2000000;
export const MAX_CEILING = 5000000;
export const VALID_THRESHOLD_MODES = Object.freeze(['auto', 'manual']);
export const VALID_TRACKING_MODES = Object.freeze(['current', 'auto', 'pinned']);
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
let tmpSeq = 0;

export const MODEL_PROFILES = Object.freeze([
  Object.freeze({
    id: 'hydrogen',
    label: 'Hydrogen',
    cautionThreshold: 90000,
    dumbZoneThreshold: 130000,
    gaugeCeiling: 200000,
  }),
  Object.freeze({
    id: 'orchestrator-neon',
    label: 'Orchestrator (Neon)',
    cautionThreshold: 120000,
    dumbZoneThreshold: 175000,
    gaugeCeiling: 250000,
  }),
  Object.freeze({
    id: 'orchestrator-argon',
    label: 'Orchestrator (Argon)',
    cautionThreshold: 120000,
    dumbZoneThreshold: 175000,
    gaugeCeiling: 250000,
  }),
  Object.freeze({
    id: 'neon',
    label: 'Neon',
    cautionThreshold: 140000,
    dumbZoneThreshold: 200000,
    gaugeCeiling: 300000,
  }),
  Object.freeze({
    id: 'orchestrator-carbon',
    label: 'Orchestrator (Carbon)',
    cautionThreshold: 150000,
    dumbZoneThreshold: 200000,
    gaugeCeiling: 300000,
  }),
  Object.freeze({
    id: 'carbon',
    label: 'Carbon',
    cautionThreshold: 160000,
    dumbZoneThreshold: 220000,
    gaugeCeiling: 320000,
  }),
]);

export const DEFAULT_MODEL_PROFILE = Object.freeze({
  id: 'default',
  label: 'Default (Orchestrator-Neon)',
  cautionThreshold: 120000,
  dumbZoneThreshold: 175000,
  gaugeCeiling: 250000,
});

const PROFILE_BY_ID = Object.freeze(
  Object.fromEntries(MODEL_PROFILES.map((profile) => [profile.id, profile]))
);

/**
 * Resolve the settings.json path inside ANTIGRAVITY_EXECUTABLE_DATA_DIR or fallback.
 */
export function resolveSettingsPath({ dataDir } = {}) {
  const baseDir =
    dataDir ||
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'token-counter', 'token_counter', 'data');
  return join(baseDir, 'settings.json');
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function normalizeModelName(model) {
  return String(model || '')
    .trim()
    .replace(/^models\//i, '')
    .toLowerCase();
}

/**
 * Return true if `model` is an internal Antigravity worker model (e.g. `gemini-flash-worker-agy`).
 */
export function isInternalWorkerModel(model) {
  const norm = normalizeModelName(model);
  return norm === 'gemini-flash-worker-agy' || /^[a-z0-9._-]+-worker-agy$/.test(norm);
}

/**
 * Resolve effective thresholds for a model given user settings.
 * In `'manual'` mode, returns manual thresholds; in `'auto'` mode, matches
 * known model families with fallback to DEFAULT_MODEL_PROFILE.
 */
export function resolveEffectiveThresholds(model, settings = DEFAULT_SETTINGS) {
  const s = isPlainObject(settings) ? { ...DEFAULT_SETTINGS, ...settings } : DEFAULT_SETTINGS;
  if (s.thresholdMode === 'manual') {
    return {
      cautionThreshold: s.cautionThreshold,
      dumbZoneThreshold: s.dumbZoneThreshold,
      gaugeCeiling: s.gaugeCeiling,
      profileId: 'manual',
      profileLabel: 'Manual Override',
      source: 'manual',
    };
  }

  const norm = normalizeModelName(model);

  let matched = null;
  if (
    norm === 'gemini-pro-orchestrator-neon' ||
    norm.startsWith('gemini-pro-orchestrator-neon-') ||
    /^orchestrator\s*\(\s*neon\s*\)$/.test(norm)
  ) {
    matched = PROFILE_BY_ID['orchestrator-neon'];
  } else if (
    norm === 'gemini-pro-orchestrator-argon' ||
    norm.startsWith('gemini-pro-orchestrator-argon-') ||
    norm === 'gemini-pro-orchestrator-g1-pro' ||
    norm.startsWith('gemini-pro-orchestrator-g1-pro-') ||
    /^orchestrator\s*\(\s*argon\s*\)$/.test(norm)
  ) {
    matched = PROFILE_BY_ID['orchestrator-argon'];
  } else if (
    norm === 'gemini-pro-orchestrator' ||
    norm === 'gemini-pro-orchestrator-carbon' ||
    norm.startsWith('gemini-pro-orchestrator-carbon-') ||
    /^orchestrator\s*\(\s*carbon\s*\)$/.test(norm)
  ) {
    matched = PROFILE_BY_ID['orchestrator-carbon'];
  } else if (
    norm === 'gemini-4-hydrogen' ||
    norm.startsWith('gemini-4-hydrogen-') ||
    norm === 'gemini-pro-orchestrator-hydrogen' ||
    norm.startsWith('gemini-pro-orchestrator-hydrogen-') ||
    /^gemini\s+4\s+hydrogen(?:\s*\([^)]*\))?$/.test(norm) ||
    /^orchestrator\s*\(\s*hydrogen\s*\)$/.test(norm) ||
    isInternalWorkerModel(norm)
  ) {
    matched = PROFILE_BY_ID.hydrogen;
  } else if (
    norm === 'gemini-4-neon' ||
    norm.startsWith('gemini-4-neon-') ||
    /^gemini\s+4\s+neon(?:\s*\([^)]*\))?$/.test(norm)
  ) {
    matched = PROFILE_BY_ID.neon;
  } else if (
    norm === 'gemini-4-carbon' ||
    norm.startsWith('gemini-4-carbon-') ||
    /^gemini\s+4\s+carbon(?:\s*\([^)]*\))?$/.test(norm)
  ) {
    matched = PROFILE_BY_ID.carbon;
  }

  const profile = matched || DEFAULT_MODEL_PROFILE;
  return {
    cautionThreshold: profile.cautionThreshold,
    dumbZoneThreshold: profile.dumbZoneThreshold,
    gaugeCeiling: profile.gaugeCeiling,
    profileId: profile.id,
    profileLabel: profile.label,
    source: matched ? 'model' : 'fallback',
  };
}

/**
 * Validate and normalize a settings update merged onto `current`.
 * Returns `{ ok: true, settings }` or `{ ok: false, error }`.
 */
export function validateSettings(input, current = DEFAULT_SETTINGS) {
  if (!isPlainObject(input)) {
    return { ok: false, error: 'Settings payload must be a JSON object.' };
  }

  const base = isPlainObject(current) ? { ...DEFAULT_SETTINGS, ...current } : { ...DEFAULT_SETTINGS };

  const thresholdMode =
    input.thresholdMode !== undefined ? input.thresholdMode : base.thresholdMode;
  const cautionThreshold =
    input.cautionThreshold !== undefined ? input.cautionThreshold : base.cautionThreshold;
  const dumbZoneThreshold =
    input.dumbZoneThreshold !== undefined ? input.dumbZoneThreshold : base.dumbZoneThreshold;
  const trackingMode =
    input.trackingMode !== undefined ? input.trackingMode : base.trackingMode;
  const rawPinnedSessionId =
    input.pinnedSessionId !== undefined ? input.pinnedSessionId : base.pinnedSessionId;

  if (typeof thresholdMode !== 'string' || !VALID_THRESHOLD_MODES.includes(thresholdMode)) {
    return {
      ok: false,
      error: `thresholdMode must be one of: ${VALID_THRESHOLD_MODES.join(', ')}.`,
    };
  }

  if (
    !Number.isInteger(cautionThreshold) ||
    cautionThreshold < MIN_THRESHOLD ||
    cautionThreshold > MAX_THRESHOLD - 1
  ) {
    return {
      ok: false,
      error: `cautionThreshold must be an integer between ${MIN_THRESHOLD} and ${MAX_THRESHOLD - 1}.`,
    };
  }

  if (
    !Number.isInteger(dumbZoneThreshold) ||
    dumbZoneThreshold < MIN_THRESHOLD * 2 ||
    dumbZoneThreshold > MAX_THRESHOLD
  ) {
    return {
      ok: false,
      error: `dumbZoneThreshold must be an integer between ${MIN_THRESHOLD * 2} and ${MAX_THRESHOLD}.`,
    };
  }

  if (cautionThreshold >= dumbZoneThreshold) {
    return {
      ok: false,
      error: 'cautionThreshold must be strictly less than dumbZoneThreshold.',
    };
  }

  let gaugeCeiling;
  if (input.gaugeCeiling !== undefined && input.gaugeCeiling !== null) {
    if (!Number.isInteger(input.gaugeCeiling) || input.gaugeCeiling < MIN_THRESHOLD || input.gaugeCeiling > MAX_CEILING) {
      return {
        ok: false,
        error: `gaugeCeiling must be an integer between ${MIN_THRESHOLD} and ${MAX_CEILING}.`,
      };
    }
    gaugeCeiling =
      input.gaugeCeiling <= dumbZoneThreshold
        ? Math.min(MAX_CEILING, Math.round(dumbZoneThreshold * 1.5))
        : input.gaugeCeiling;
  } else {
    gaugeCeiling =
      !Number.isInteger(base.gaugeCeiling) || base.gaugeCeiling <= dumbZoneThreshold
        ? Math.min(MAX_CEILING, Math.round(dumbZoneThreshold * 1.5))
        : base.gaugeCeiling;
  }

  if (typeof trackingMode !== 'string' || !VALID_TRACKING_MODES.includes(trackingMode)) {
    return {
      ok: false,
      error: `trackingMode must be one of: ${VALID_TRACKING_MODES.join(', ')}.`,
    };
  }

  let pinnedSessionId = '';
  if (trackingMode === 'pinned') {
    const candidate = typeof rawPinnedSessionId === 'string' ? rawPinnedSessionId.trim() : '';
    if (!SAFE_ID_RE.test(candidate)) {
      return {
        ok: false,
        error: 'pinnedSessionId must be a valid conversation ID when trackingMode is pinned.',
      };
    }
    pinnedSessionId = candidate;
  }

  return {
    ok: true,
    settings: {
      thresholdMode,
      cautionThreshold,
      dumbZoneThreshold,
      gaugeCeiling,
      trackingMode,
      pinnedSessionId,
    },
  };
}

function migrateLegacySettings(raw) {
  if (!isPlainObject(raw) || raw.thresholdMode !== undefined) {
    return raw;
  }
  const hasAnyThreshold =
    raw.cautionThreshold !== undefined ||
    raw.dumbZoneThreshold !== undefined ||
    raw.gaugeCeiling !== undefined;
  if (!hasAnyThreshold) {
    return { ...raw, thresholdMode: 'auto' };
  }
  const isLegacyDefaults =
    raw.cautionThreshold === 70000 &&
    raw.dumbZoneThreshold === 100000 &&
    (raw.gaugeCeiling === undefined || raw.gaugeCeiling === 150000);
  if (isLegacyDefaults) {
    return {
      ...raw,
      thresholdMode: 'auto',
      cautionThreshold: DEFAULT_SETTINGS.cautionThreshold,
      dumbZoneThreshold: DEFAULT_SETTINGS.dumbZoneThreshold,
      gaugeCeiling: DEFAULT_SETTINGS.gaugeCeiling,
    };
  }
  return { ...raw, thresholdMode: 'manual' };
}

/**
 * Load persisted settings from disk, falling back to DEFAULT_SETTINGS if missing or invalid.
 */
export function loadSettings(options = {}) {
  const filePath = options.filePath || resolveSettingsPath(options);
  try {
    if (!existsSync(filePath)) {
      return { ...DEFAULT_SETTINGS };
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    const migrated = migrateLegacySettings(raw);
    const validated = validateSettings(migrated, DEFAULT_SETTINGS);
    return validated.ok ? validated.settings : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function isRetryableRenameError(err) {
  return err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
}

function renameWithRetrySync(src, dst, { renameFn = renameSync, maxRetries = 5, retryDelayMs = 25 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameFn(src, dst);
      return;
    } catch (err) {
      if (!isRetryableRenameError(err) || attempt >= maxRetries) {
        throw err;
      }
      const delay = retryDelayMs * (attempt + 1);
      if (delay > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
  }
}

/**
 * Atomically persist validated settings to disk.
 */
export function saveSettings(patch, options = {}) {
  const filePath = options.filePath || resolveSettingsPath(options);
  const current = options.current || loadSettings({ filePath });
  const validated = validateSettings(patch, current);
  if (!validated.ok) {
    return validated;
  }

  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `settings.json.tmp.${process.pid}.${Date.now()}.${++tmpSeq}`);
  try {
    writeFileSync(tmpPath, JSON.stringify(validated.settings, null, 2) + '\n', 'utf-8');
    renameWithRetrySync(tmpPath, filePath, {
      renameFn: options.renameFn,
      maxRetries: options.maxRetries,
      retryDelayMs: options.retryDelayMs,
    });
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }

  return { ok: true, settings: validated.settings };
}

/**
 * Stateful settings store with version tracking for ETag generation.
 */
export function createSettingsStore(options = {}) {
  const filePath = options.filePath || resolveSettingsPath(options);
  let settings = loadSettings({ filePath });
  let version = 1;

  return {
    path: filePath,
    get() {
      return { ...settings };
    },
    version() {
      return version;
    },
    update(patch) {
      const result = saveSettings(patch, { filePath, current: settings });
      if (!result.ok) {
        return result;
      }
      settings = result.settings;
      version += 1;
      return { ok: true, settings: { ...settings } };
    },
    reset() {
      return this.update({ ...DEFAULT_SETTINGS });
    },
  };
}
