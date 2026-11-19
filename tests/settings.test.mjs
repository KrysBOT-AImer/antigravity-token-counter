import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createSettingsStore,
  DEFAULT_MODEL_PROFILE,
  DEFAULT_SETTINGS,
  isInternalWorkerModel,
  loadSettings,
  MODEL_PROFILES,
  resolveEffectiveThresholds,
  saveSettings,
  validateSettings,
} from '../sidecars/token_counter/lib/settings.mjs';

test('settings: returns defaults when file missing or corrupted', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const filePath = join(dir, 'settings.json');
  assert.deepEqual(loadSettings({ filePath }), DEFAULT_SETTINGS);

  writeFileSync(filePath, '{broken json', 'utf-8');
  assert.deepEqual(loadSettings({ filePath }), DEFAULT_SETTINGS);

  writeFileSync(filePath, JSON.stringify({ cautionThreshold: 120000, dumbZoneThreshold: 80000 }), 'utf-8');
  assert.deepEqual(loadSettings({ filePath }), DEFAULT_SETTINGS);
});

test('settings: validates bounds, types, pinnedSessionId, and auto-adjusts gaugeCeiling', () => {
  assert.equal(validateSettings(null).ok, false);
  assert.equal(validateSettings([]).ok, false);
  assert.equal(validateSettings({ cautionThreshold: 500 }).ok, false);
  assert.equal(validateSettings({ cautionThreshold: 2000000 }).ok, false);
  assert.equal(validateSettings({ cautionThreshold: 70000.5 }).ok, false);
  assert.equal(validateSettings({ cautionThreshold: NaN }).ok, false);
  assert.equal(validateSettings({ cautionThreshold: 100000, dumbZoneThreshold: 100000 }).ok, false);
  assert.equal(validateSettings({ cautionThreshold: 120000, dumbZoneThreshold: 100000 }).ok, false);
  assert.equal(validateSettings({ thresholdMode: 'unknown' }).ok, false);
  assert.equal(validateSettings({ trackingMode: 'pinned' }).ok, false);
  assert.equal(validateSettings({ trackingMode: 'pinned', pinnedSessionId: '../bad' }).ok, false);
  assert.equal(validateSettings({ gaugeCeiling: -100 }).ok, false);

  const valid = validateSettings({
    thresholdMode: 'manual',
    cautionThreshold: 50000,
    dumbZoneThreshold: 80000,
    gaugeCeiling: 80000,
    trackingMode: 'auto',
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.settings, {
    thresholdMode: 'manual',
    cautionThreshold: 50000,
    dumbZoneThreshold: 80000,
    gaugeCeiling: 120000,
    trackingMode: 'auto',
    pinnedSessionId: '',
  });

  const pinnedValid = validateSettings({
    trackingMode: 'pinned',
    pinnedSessionId: 'main-session-123',
  });
  assert.equal(pinnedValid.ok, true);
  assert.equal(pinnedValid.settings.trackingMode, 'pinned');
  assert.equal(pinnedValid.settings.pinnedSessionId, 'main-session-123');

  // Switching back to auto or current clears pinnedSessionId
  const backToAuto = validateSettings({ trackingMode: 'auto' }, pinnedValid.settings);
  assert.equal(backToAuto.ok, true);
  assert.equal(backToAuto.settings.pinnedSessionId, '');

  const backToCurrent = validateSettings({ trackingMode: 'current' }, pinnedValid.settings);
  assert.equal(backToCurrent.ok, true);
  assert.equal(backToCurrent.settings.pinnedSessionId, '');
});

test('settings: resolves all 6 model profiles, prefix stripping, fallback, and manual override', () => {
  assert.equal(MODEL_PROFILES.length, 6);
  assert.deepEqual(
    resolveEffectiveThresholds('gemini-4-hydrogen-high'),
    {
      cautionThreshold: 90000,
      dumbZoneThreshold: 130000,
      gaugeCeiling: 200000,
      profileId: 'hydrogen',
      profileLabel: 'Hydrogen',
      source: 'model',
    }
  );
  assert.equal(resolveEffectiveThresholds('gemini-4-hydrogen-tiered-high').profileId, 'hydrogen');
  assert.deepEqual(
    resolveEffectiveThresholds('gemini-pro-orchestrator-neon'),
    {
      cautionThreshold: 120000,
      dumbZoneThreshold: 175000,
      gaugeCeiling: 250000,
      profileId: 'orchestrator-neon',
      profileLabel: 'Orchestrator (Neon)',
      source: 'model',
    }
  );
  assert.deepEqual(
    resolveEffectiveThresholds('gemini-4-neon-medium'),
    {
      cautionThreshold: 140000,
      dumbZoneThreshold: 200000,
      gaugeCeiling: 300000,
      profileId: 'neon',
      profileLabel: 'Neon',
      source: 'model',
    }
  );
  assert.deepEqual(
    resolveEffectiveThresholds('gemini-pro-orchestrator'),
    {
      cautionThreshold: 150000,
      dumbZoneThreshold: 200000,
      gaugeCeiling: 300000,
      profileId: 'orchestrator-carbon',
      profileLabel: 'Orchestrator (Carbon)',
      source: 'model',
    }
  );
  assert.deepEqual(
    resolveEffectiveThresholds('models/gemini-4-carbon-high'),
    {
      cautionThreshold: 160000,
      dumbZoneThreshold: 220000,
      gaugeCeiling: 320000,
      profileId: 'carbon',
      profileLabel: 'Carbon',
      source: 'model',
    }
  );

  assert.deepEqual(
    resolveEffectiveThresholds('gemini-pro-orchestrator-argon'),
    {
      cautionThreshold: 120000,
      dumbZoneThreshold: 175000,
      gaugeCeiling: 250000,
      profileId: 'orchestrator-argon',
      profileLabel: 'Orchestrator (Argon)',
      source: 'model',
    }
  );
  assert.deepEqual(
    resolveEffectiveThresholds('gemini-flash-worker-agy'),
    {
      cautionThreshold: 90000,
      dumbZoneThreshold: 130000,
      gaugeCeiling: 200000,
      profileId: 'hydrogen',
      profileLabel: 'Hydrogen',
      source: 'model',
    }
  );

  // Unknown models and null fall back to DEFAULT_MODEL_PROFILE (120K / 175K / 250K)
  for (const unknown of ['gemini-unknown-model', null, '']) {
    assert.deepEqual(resolveEffectiveThresholds(unknown), {
      cautionThreshold: DEFAULT_MODEL_PROFILE.cautionThreshold,
      dumbZoneThreshold: DEFAULT_MODEL_PROFILE.dumbZoneThreshold,
      gaugeCeiling: DEFAULT_MODEL_PROFILE.gaugeCeiling,
      profileId: 'default',
      profileLabel: DEFAULT_MODEL_PROFILE.label,
      source: 'fallback',
    });
  }

  // Manual override ignores model profile
  assert.deepEqual(
    resolveEffectiveThresholds('gemini-4-carbon-high', {
      ...DEFAULT_SETTINGS,
      thresholdMode: 'manual',
      cautionThreshold: 50000,
      dumbZoneThreshold: 80000,
      gaugeCeiling: 120000,
    }),
    {
      cautionThreshold: 50000,
      dumbZoneThreshold: 80000,
      gaugeCeiling: 120000,
      profileId: 'manual',
      profileLabel: 'Manual Override',
      source: 'manual',
    }
  );
});

test('settings: migrates legacy v1.0.0 defaults to auto and custom legacy values to manual', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-settings-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const legacyDefaultPath = join(dir, 'legacy-default.json');
  writeFileSync(
    legacyDefaultPath,
    JSON.stringify({
      cautionThreshold: 70000,
      dumbZoneThreshold: 100000,
      gaugeCeiling: 150000,
      trackingMode: 'auto',
    }),
    'utf-8'
  );
  assert.deepEqual(loadSettings({ filePath: legacyDefaultPath }), {
    thresholdMode: 'auto',
    cautionThreshold: 120000,
    dumbZoneThreshold: 175000,
    gaugeCeiling: 250000,
    trackingMode: 'auto',
    pinnedSessionId: '',
  });

  const legacyCustomPath = join(dir, 'legacy-custom.json');
  writeFileSync(
    legacyCustomPath,
    JSON.stringify({
      cautionThreshold: 50000,
      dumbZoneThreshold: 80000,
      gaugeCeiling: 120000,
      trackingMode: 'current',
    }),
    'utf-8'
  );
  assert.deepEqual(loadSettings({ filePath: legacyCustomPath }), {
    thresholdMode: 'manual',
    cautionThreshold: 50000,
    dumbZoneThreshold: 80000,
    gaugeCeiling: 120000,
    trackingMode: 'current',
    pinnedSessionId: '',
  });
});

test('settings: atomically persists updates, increments store version, and resets cleanly', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-settings-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = createSettingsStore({ dataDir: dir });
  assert.deepEqual(store.get(), DEFAULT_SETTINGS);
  assert.equal(store.version(), 1);

  const bad = store.update({ cautionThreshold: 150000, dumbZoneThreshold: 100000 });
  assert.equal(bad.ok, false);
  assert.equal(store.version(), 1);

  const ok = store.update({
    thresholdMode: 'manual',
    cautionThreshold: 60000,
    dumbZoneThreshold: 90000,
    gaugeCeiling: 140000,
    trackingMode: 'pinned',
    pinnedSessionId: 'main-1',
  });
  assert.equal(ok.ok, true);
  assert.equal(store.version(), 2);
  assert.deepEqual(ok.settings, {
    thresholdMode: 'manual',
    cautionThreshold: 60000,
    dumbZoneThreshold: 90000,
    gaugeCeiling: 140000,
    trackingMode: 'pinned',
    pinnedSessionId: 'main-1',
  });

  // Reload from disk with fresh call
  const reloaded = loadSettings({ filePath: store.path });
  assert.deepEqual(reloaded, ok.settings);

  // Ensure no leftover tmp files
  const files = readdirSync(dir);
  assert.deepEqual(files, ['settings.json']);

  // Direct saveSettings helper works too
  const saved = saveSettings({ trackingMode: 'auto' }, { filePath: store.path });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.trackingMode, 'auto');
  assert.equal(saved.settings.pinnedSessionId, '');

  // store.reset() restores defaults
  const resetRes = store.reset();
  assert.equal(resetRes.ok, true);
  assert.deepEqual(store.get(), DEFAULT_SETTINGS);
});

test('settings: resolves human display names and orchestrator variants without false collisions', () => {
  const positiveCases = [
    ['Gemini 4 Hydrogen (High)', 'hydrogen', 90000, 130000, 200000],
    ['Gemini 4 Hydrogen (XHigh)', 'hydrogen', 90000, 130000, 200000],
    ['Gemini 4 Hydrogen', 'hydrogen', 90000, 130000, 200000],
    ['gemini-pro-orchestrator-hydrogen', 'hydrogen', 90000, 130000, 200000],
    ['gemini-pro-orchestrator-hydrogen-high', 'hydrogen', 90000, 130000, 200000],
    ['Orchestrator (Hydrogen)', 'hydrogen', 90000, 130000, 200000],
    ['Orchestrator (Neon)', 'orchestrator-neon', 120000, 175000, 250000],
    ['gemini-pro-orchestrator-neon-tiered', 'orchestrator-neon', 120000, 175000, 250000],
    ['Orchestrator (Argon)', 'orchestrator-argon', 120000, 175000, 250000],
    ['Orchestrator ( Argon )', 'orchestrator-argon', 120000, 175000, 250000],
    ['gemini-pro-orchestrator-argon', 'orchestrator-argon', 120000, 175000, 250000],
    ['gemini-pro-orchestrator-argon-high', 'orchestrator-argon', 120000, 175000, 250000],
    ['gemini-pro-orchestrator-g1-pro', 'orchestrator-argon', 120000, 175000, 250000],
    ['gemini-pro-orchestrator-g1-pro-high', 'orchestrator-argon', 120000, 175000, 250000],
    ['Orchestrator (Carbon)', 'orchestrator-carbon', 150000, 200000, 300000],
    ['gemini-pro-orchestrator-carbon', 'orchestrator-carbon', 150000, 200000, 300000],
    ['gemini-pro-orchestrator-carbon-high', 'orchestrator-carbon', 150000, 200000, 300000],
    ['Gemini 4 Neon (Medium)', 'neon', 140000, 200000, 300000],
    ['Gemini 4 Neon', 'neon', 140000, 200000, 300000],
    ['Gemini 4 Carbon (High)', 'carbon', 160000, 220000, 320000],
    ['Gemini 4 Carbon', 'carbon', 160000, 220000, 320000],
    ['  models/Orchestrator ( Carbon )  ', 'orchestrator-carbon', 150000, 200000, 300000],
    ['gemini-flash-worker-agy', 'hydrogen', 90000, 130000, 200000],
    ['models/gemini-flash-worker-agy', 'hydrogen', 90000, 130000, 200000],
    ['custom-flash-worker-agy', 'hydrogen', 90000, 130000, 200000],
  ];

  for (const [modelName, expectedId, caution, dumb, ceiling] of positiveCases) {
    const res = resolveEffectiveThresholds(modelName);
    assert.equal(res.profileId, expectedId, `Expected ${modelName} -> ${expectedId}`);
    assert.equal(res.cautionThreshold, caution);
    assert.equal(res.dumbZoneThreshold, dumb);
    assert.equal(res.gaugeCeiling, ceiling);
    assert.equal(res.source, 'model');
  }

  const negativeCases = [
    'Gemini 4 Argon (Medium)',
    'Gemini 3.8 Flash (High)',
    'gemini-3.5-flash-lite',
    'Orchestrator (Neon) extra',
    '',
    null,
    undefined,
  ];

  for (const unknown of negativeCases) {
    const res = resolveEffectiveThresholds(unknown);
    assert.equal(res.profileId, 'default', `Expected ${String(unknown)} -> default`);
    assert.equal(res.source, 'fallback');
    assert.equal(res.cautionThreshold, DEFAULT_MODEL_PROFILE.cautionThreshold);
    assert.equal(res.dumbZoneThreshold, DEFAULT_MODEL_PROFILE.dumbZoneThreshold);
    assert.equal(res.gaugeCeiling, DEFAULT_MODEL_PROFILE.gaugeCeiling);
  }
});

test('settings: isInternalWorkerModel detects worker models with normalization', () => {
  assert.equal(isInternalWorkerModel('gemini-flash-worker-agy'), true);
  assert.equal(isInternalWorkerModel('  models/GEMINI-FLASH-WORKER-AGY  '), true);
  assert.equal(isInternalWorkerModel('custom.sub_1-worker-agy'), true);
  assert.equal(isInternalWorkerModel('gemini-4-hydrogen'), false);
  assert.equal(isInternalWorkerModel('gemini-pro-orchestrator-neon'), false);
  assert.equal(isInternalWorkerModel('worker-agy'), false);
  assert.equal(isInternalWorkerModel(''), false);
  assert.equal(isInternalWorkerModel(null), false);
});

test('settings: retries transient EBUSY/EPERM rename errors and cleans up tmp files on failure', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-settings-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'settings.json');

  // Transient EBUSY followed by EPERM, then succeeds on 3rd attempt
  let attempts = 0;
  const saved = saveSettings(
    { trackingMode: 'auto' },
    {
      filePath,
      maxRetries: 3,
      retryDelayMs: 1,
      renameFn(src, dst) {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('resource busy');
          err.code = 'EBUSY';
          throw err;
        }
        if (attempts === 2) {
          const err = new Error('operation not permitted');
          err.code = 'EPERM';
          throw err;
        }
        renameSync(src, dst);
      },
    }
  );
  assert.equal(saved.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(readdirSync(dir), ['settings.json']);
  assert.equal(loadSettings({ filePath }).trackingMode, 'auto');

  // Exhausted retries clean up tmp file and rethrow
  let exhaustedAttempts = 0;
  assert.throws(
    () =>
      saveSettings(
        { trackingMode: 'current' },
        {
          filePath,
          maxRetries: 2,
          retryDelayMs: 1,
          renameFn() {
            exhaustedAttempts += 1;
            const err = new Error('still busy');
            err.code = 'EBUSY';
            throw err;
          },
        }
      ),
    (err) => err?.code === 'EBUSY'
  );
  assert.equal(exhaustedAttempts, 3);
  assert.deepEqual(readdirSync(dir), ['settings.json']);

  // Non-retryable error (ENOENT) fails immediately without retrying and cleans up tmp file
  let nonRetryAttempts = 0;
  assert.throws(
    () =>
      saveSettings(
        { trackingMode: 'current' },
        {
          filePath,
          maxRetries: 5,
          retryDelayMs: 1,
          renameFn() {
            nonRetryAttempts += 1;
            const err = new Error('no such file');
            err.code = 'ENOENT';
            throw err;
          },
        }
      ),
    (err) => err?.code === 'ENOENT'
  );
  assert.equal(nonRetryAttempts, 1);
  assert.deepEqual(readdirSync(dir), ['settings.json']);
});
