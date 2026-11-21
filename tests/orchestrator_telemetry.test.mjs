import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_TELEMETRY_STALE_MS,
  orchestratorTelemetryPathFor,
  readOrchestratorTelemetry,
  resolveOrchestratorTelemetryDir,
  sanitizeTelemetryConvId,
  statOrchestratorTelemetry,
} from '../sidecars/token_counter/lib/orchestrator_telemetry.mjs';

function makeValidPayload(overrides = {}) {
  return {
    schema_version: 1,
    conversation_id: 'main-1',
    timestamp: '2026-11-21T12:00:00.000Z',
    active_tokens: 72500,
    source: 'transcript_usage',
    zone: 'yellow',
    fork_eligible: false,
    compact_recommended: false,
    thresholds: {
      fork_max: 60000,
      yellow: 60000,
      red: 110000,
      hard: 160000,
    },
    ...overrides,
  };
}

test('orchestrator_telemetry: sanitizeTelemetryConvId rejects traversal and caps length to 128', () => {
  assert.equal(sanitizeTelemetryConvId(null), null);
  assert.equal(sanitizeTelemetryConvId(undefined), null);
  assert.equal(sanitizeTelemetryConvId(''), null);
  assert.equal(sanitizeTelemetryConvId('   '), null);
  assert.equal(sanitizeTelemetryConvId('.'), null);
  assert.equal(sanitizeTelemetryConvId('..'), null);
  assert.equal(sanitizeTelemetryConvId('../etc/passwd'), null);
  assert.equal(sanitizeTelemetryConvId('foo/bar'), null);
  assert.equal(sanitizeTelemetryConvId('foo\\bar'), null);
  assert.equal(sanitizeTelemetryConvId('foo..bar'), null);

  assert.equal(sanitizeTelemetryConvId('conv:123$abc'), 'conv_123_abc');
  assert.equal(sanitizeTelemetryConvId('valid_id-1.2'), 'valid_id-1.2');

  const longId = 'conv_' + 'a'.repeat(200);
  const sanitized = sanitizeTelemetryConvId(longId);
  assert.equal(sanitized.length, 128);
  assert.equal(sanitized, longId.slice(0, 128));
});

test('orchestrator_telemetry: valid schema_version 1 payload returns normalized fields and ageMs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tc-otel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = resolveOrchestratorTelemetryDir(root);
  mkdirSync(dir, { recursive: true });
  const filePath = orchestratorTelemetryPathFor(root, 'main-1');
  const payload = makeValidPayload();
  writeFileSync(filePath, JSON.stringify(payload), 'utf-8');

  const nowMs = Date.parse('2026-11-21T12:00:30.000Z');
  const result = readOrchestratorTelemetry(root, 'main-1', { nowMs });

  assert.deepEqual(result, {
    schema_version: 1,
    conversation_id: 'main-1',
    timestamp: '2026-11-21T12:00:00.000Z',
    ageMs: 30_000,
    active_tokens: 72500,
    source: 'transcript_usage',
    zone: 'yellow',
    fork_eligible: false,
    compact_recommended: false,
    thresholds: {
      fork_max: 60000,
      yellow: 60000,
      red: 110000,
      hard: 160000,
    },
  });

  const st = statOrchestratorTelemetry(root, 'main-1');
  assert.ok(st && st.size > 0 && st.path === filePath);
});

test('orchestrator_telemetry: staleness boundary (600_000ms valid, 600_001ms / 11min null)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tc-otel-stale-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = resolveOrchestratorTelemetryDir(root);
  mkdirSync(dir, { recursive: true });
  const ts = '2026-11-21T12:00:00.000Z';
  const tsMs = Date.parse(ts);
  writeFileSync(
    orchestratorTelemetryPathFor(root, 'main-1'),
    JSON.stringify(makeValidPayload({ timestamp: ts })),
    'utf-8'
  );

  assert.equal(DEFAULT_TELEMETRY_STALE_MS, 600_000);

  // Exact boundary: ageMs === 600_000 -> valid
  const atBoundary = readOrchestratorTelemetry(root, 'main-1', {
    nowMs: tsMs + 600_000,
  });
  assert.ok(atBoundary);
  assert.equal(atBoundary.ageMs, 600_000);

  // Just past boundary: ageMs === 600_001 -> null
  assert.equal(
    readOrchestratorTelemetry(root, 'main-1', { nowMs: tsMs + 600_001 }),
    null
  );

  // 11 minutes old -> null
  assert.equal(
    readOrchestratorTelemetry(root, 'main-1', { nowMs: tsMs + 11 * 60 * 1000 }),
    null
  );
});

test('orchestrator_telemetry: invalid or missing payloads fail open with null', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tc-otel-bad-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = resolveOrchestratorTelemetryDir(root);
  mkdirSync(dir, { recursive: true });
  const nowMs = Date.parse('2026-11-21T12:01:00.000Z');

  // Missing file
  assert.equal(readOrchestratorTelemetry(root, 'missing-id', { nowMs }), null);
  assert.equal(statOrchestratorTelemetry(root, 'missing-id'), null);

  const cases = [
    ['corrupt', '{not valid json'],
    ['array', '[]'],
    ['schema2', JSON.stringify(makeValidPayload({ schema_version: 2 }))],
    ['badzone', JSON.stringify(makeValidPayload({ zone: 'purple' }))],
    ['neg_tokens', JSON.stringify(makeValidPayload({ active_tokens: -5 }))],
    ['bad_fork', JSON.stringify(makeValidPayload({ fork_eligible: 'yes' }))],
    ['bad_compact', JSON.stringify(makeValidPayload({ compact_recommended: 1 }))],
    ['bad_ts', JSON.stringify(makeValidPayload({ timestamp: 'not-a-date' }))],
    ['missing_thresh', JSON.stringify(makeValidPayload({ thresholds: null }))],
    [
      'non_num_thresh',
      JSON.stringify(
        makeValidPayload({
          thresholds: { fork_max: '60000', yellow: 60000, red: 110000, hard: 160000 },
        })
      ),
    ],
    [
      'zero_thresh',
      JSON.stringify(
        makeValidPayload({
          thresholds: { fork_max: 0, yellow: 60000, red: 110000, hard: 160000 },
        })
      ),
    ],
  ];

  for (const [id, content] of cases) {
    writeFileSync(orchestratorTelemetryPathFor(root, id), content, 'utf-8');
    assert.equal(
      readOrchestratorTelemetry(root, id, { nowMs }),
      null,
      `expected null for invalid case: ${id}`
    );
  }
});
