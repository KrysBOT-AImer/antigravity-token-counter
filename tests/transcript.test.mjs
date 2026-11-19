import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  clearGenMetadataCache,
  extractModelFromGenMetadataBlob,
  readSessionModelFromGenMetadata,
} from '../sidecars/token_counter/lib/gen_metadata.mjs';
import { DEFAULT_SETTINGS } from '../sidecars/token_counter/lib/settings.mjs';
import {
  computeMetrics,
  createTranscriptReader,
  downsampleSeries,
  extractModelFromSettingsChange,
} from '../sidecars/token_counter/lib/transcript.mjs';

function stepLine(obj) {
  return JSON.stringify(obj) + '\n';
}

const LEGACY_MANUAL_SETTINGS = {
  ...DEFAULT_SETTINGS,
  thresholdMode: 'manual',
  cautionThreshold: 70000,
  dumbZoneThreshold: 100000,
  gaugeCeiling: 150000,
};

test('transcript: calculates exact input + cache_read, cache expiry, and dual-model carry-forward', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-transcript-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const trPath = join(dir, 'transcript.jsonl');
  const lines = [
    stepLine({
      step_index: 0,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      created_at: '2026-11-19T20:00:00Z',
      content: '<USER_REQUEST>\nBuild a token counter plugin for Antigravity\n</USER_REQUEST>',
    }),
    stepLine({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      model: 'gemini-4-hydrogen-high',
      input_tokens: 18500,
      cache_read_tokens: 0,
      output_tokens: 1200,
      created_at: '2026-11-19T20:00:05Z',
    }),
    stepLine({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      model: 'gemini-4-hydrogen-high',
      input_tokens: 4500,
      cache_read_tokens: 18500,
      output_tokens: 600,
      created_at: '2026-11-19T20:00:15Z',
    }),
    // Cache expiry >3m: cache_read_tokens drops to 0, input_tokens holds full prompt; model omitted (carry forward)
    stepLine({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      input_tokens: 72000,
      cache_read_tokens: 0,
      output_tokens: 800,
      created_at: '2026-11-19T20:05:00Z',
    }),
  ].join('');

  writeFileSync(trPath, lines, 'utf-8');
  const reader = createTranscriptReader();
  const parsed = reader.readTranscript(trPath);
  const { metrics, series, firstUserPrompt, effectiveThresholds } = computeMetrics(
    parsed,
    LEGACY_MANUAL_SETTINGS
  );

  assert.equal(firstUserPrompt, 'Build a token counter plugin for Antigravity');
  assert.equal(series.length, 3);
  assert.equal(series[0].contextTokens, 18500);
  assert.equal(series[0].delta, 0);
  assert.equal(series[1].contextTokens, 23000);
  assert.equal(series[1].delta, 4500);
  assert.equal(series[2].contextTokens, 72000);
  assert.equal(series[2].delta, 49000);
  assert.equal(series[2].model, 'gemini-4-hydrogen-high');

  assert.equal(metrics.contextTokens, 72000);
  assert.equal(metrics.uncachedInput, 72000);
  assert.equal(metrics.cacheRead, 0);
  assert.equal(metrics.outputTokens, 800);
  assert.equal(metrics.cacheHitRate, 0);
  assert.equal(metrics.zone, 'caution');
  assert.equal(metrics.pctOfDumbZone, 72);
  assert.equal(metrics.headroomToDumbZone, 28000);
  assert.equal(metrics.overLimitBy, 0);
  assert.equal(effectiveThresholds.source, 'manual');
  assert.equal(metrics.stepCount, 3);
  assert.equal(metrics.lastStepIndex, 3);
  assert.equal(metrics.peakAllTime, 72000);
  assert.equal(metrics.peakCurrentEpoch, 72000);

  // Under auto-profile for gemini-4-hydrogen-high (90K/130K/200K), 72K is safe
  const autoDerived = computeMetrics(parsed, DEFAULT_SETTINGS);
  assert.equal(autoDerived.effectiveThresholds.profileId, 'hydrogen');
  assert.equal(autoDerived.metrics.zone, 'safe');
  assert.equal(autoDerived.metrics.headroomToDumbZone, 58000);
});

test('transcript: handles CHECKPOINT compaction, pending state, signed headroom, and epoch reset', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-compaction-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const trPath = join(dir, 'transcript.jsonl');
  writeFileSync(
    trPath,
    [
      stepLine({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        model: 'model-a',
        input_tokens: 10000,
        cache_read_tokens: 170000,
        output_tokens: 500,
        created_at: '2026-11-19T20:01:00Z',
      }),
      stepLine({
        step_index: 2,
        type: 'CHECKPOINT',
        source: 'SYSTEM',
        content: '# Resuming from a compaction\nSummary follows...',
        input_tokens: 180000,
        cache_read_tokens: 0,
        created_at: '2026-11-19T20:02:00Z',
      }),
    ].join(''),
    'utf-8'
  );

  const reader = createTranscriptReader();
  const pendingParsed = reader.readTranscript(trPath);
  const pending = computeMetrics(pendingParsed, DEFAULT_SETTINGS);

  assert.equal(pending.metrics.contextTokens, 180000);
  assert.equal(pending.metrics.zone, 'dumb');
  assert.equal(pending.metrics.headroomToDumbZone, -5000);
  assert.equal(pending.metrics.overLimitBy, 5000);
  assert.equal(pending.metrics.postCompactionPending, true);
  assert.equal(pending.metrics.compactionCount, 1);
  assert.deepEqual(pending.metrics.lastCompaction, {
    stepIndex: 2,
    ts: '2026-11-19T20:02:00Z',
    preContext: 180000,
    postContext: null,
  });

  // Post-compaction turns arrive incrementally
  appendFileSync(
    trPath,
    [
      stepLine({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        model: 'model-a',
        input_tokens: 18000,
        cache_read_tokens: 0,
        output_tokens: 300,
        created_at: '2026-11-19T20:02:10Z',
      }),
      stepLine({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        model: 'model-a',
        input_tokens: 2000,
        cache_read_tokens: 20000,
        output_tokens: 400,
        created_at: '2026-11-19T20:02:20Z',
      }),
    ].join(''),
    'utf-8'
  );

  const postParsed = reader.readTranscript(trPath);
  const post = computeMetrics(postParsed, DEFAULT_SETTINGS);

  assert.equal(post.metrics.postCompactionPending, false);
  assert.equal(post.metrics.contextTokens, 22000);
  assert.equal(post.metrics.zone, 'safe');
  assert.equal(post.metrics.headroomToDumbZone, 153000);
  assert.equal(post.metrics.overLimitBy, 0);
  assert.equal(post.metrics.peakCurrentEpoch, 22000);
  assert.equal(post.metrics.peakAllTime, 180000);
  assert.deepEqual(post.metrics.lastCompaction, {
    stepIndex: 2,
    ts: '2026-11-19T20:02:00Z',
    preContext: 180000,
    postContext: 18000,
  });
  assert.equal(post.metrics.avgDeltaPerTurn, 4000);
  assert.equal(post.metrics.estimatedTurnsToDumbZone, Math.ceil((175000 - 22000) / 4000));
});

test('transcript: resilient to torn trailing lines and non-newline EOF during incremental reads', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-torn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const trPath = join(dir, 'transcript.jsonl');
  const reader = createTranscriptReader();

  // Write complete line 0 + torn partial line 1
  writeFileSync(
    trPath,
    stepLine({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      input_tokens: 10000,
      cache_read_tokens: 0,
      output_tokens: 100,
    }) + '{"step_index":1,"type":"PLANNER_RESPO',
    'utf-8'
  );

  const first = computeMetrics(reader.readTranscript(trPath), DEFAULT_SETTINGS);
  assert.equal(first.series.length, 1);
  assert.equal(first.metrics.contextTokens, 10000);

  // Finish line 1 WITHOUT trailing newline
  appendFileSync(
    trPath,
    'NSE","input_tokens":2000,"cache_read_tokens":10000,"output_tokens":150}',
    'utf-8'
  );
  const second = computeMetrics(reader.readTranscript(trPath), DEFAULT_SETTINGS);
  assert.equal(second.series.length, 2);
  assert.equal(second.metrics.contextTokens, 12000);

  // Append newline + line 2; ensure line 1 is NOT duplicated
  appendFileSync(
    trPath,
    '\n' +
      stepLine({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        input_tokens: 3000,
        cache_read_tokens: 12000,
        output_tokens: 200,
      }),
    'utf-8'
  );
  const third = computeMetrics(reader.readTranscript(trPath), DEFAULT_SETTINGS);
  assert.equal(third.series.length, 3);
  assert.deepEqual(
    third.series.map((p) => p.stepIndex),
    [0, 1, 2]
  );
  assert.equal(third.metrics.contextTokens, 15000);
});

test('transcript: child detection handles late fork signature, non-explicit child, and ignores tool/user text', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-child-detect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reader = createTranscriptReader();

  // 1. Forked swarm worker with 40+ copied parent lines + late SYSTEM_MESSAGE at line 44
  const forkedPath = join(dir, 'forked.jsonl');
  const forkedLines = [
    stepLine({
      step_index: 0,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      content: 'Original main prompt',
    }),
  ];
  for (let i = 1; i <= 43; i++) {
    forkedLines.push(
      stepLine({
        step_index: i,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        input_tokens: 1000,
        cache_read_tokens: 10000,
        output_tokens: 100,
      })
    );
  }
  forkedLines.push(
    stepLine({
      step_index: 44,
      type: 'SYSTEM_MESSAGE',
      source: 'SYSTEM',
      content: "You are @planner. Everything before this turn is @coordinator's memory from the main session.",
    })
  );
  writeFileSync(forkedPath, forkedLines.join(''), 'utf-8');
  const parsedForked = reader.readTranscript(forkedPath);
  assert.equal(parsedForked.isChildTranscript, true);
  assert.equal(computeMetrics(parsedForked).isChildTranscript, true);

  // 2. Non-forked child starting with SYSTEM_MESSAGE + PLANNER_RESPONSE (zero USER_EXPLICIT)
  const nonForkedPath = join(dir, 'non-forked.jsonl');
  writeFileSync(
    nonForkedPath,
    [
      stepLine({
        step_index: 0,
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        content: 'You are a background researcher.',
      }),
      stepLine({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        input_tokens: 5000,
        cache_read_tokens: 0,
        output_tokens: 200,
      }),
    ].join(''),
    'utf-8'
  );
  const parsedNonForked = reader.readTranscript(nonForkedPath);
  assert.equal(parsedNonForked.isChildTranscript, true);

  // 3. Main session reading transcript.mjs or discussing <swarm_worker> in TOOL_RESPONSE / USER_INPUT -> NOT a child
  const mainPath = join(dir, 'main-with-markers.jsonl');
  writeFileSync(
    mainPath,
    [
      stepLine({
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content: 'Inspect <swarm_worker> and <subagent_reminder> handling in transcript.mjs',
      }),
      stepLine({
        step_index: 1,
        type: 'TOOL_RESPONSE',
        source: 'TOOL',
        content: "const MARKERS = ['<subagent_reminder>', '<swarm_worker>', '<fork_notice>'];",
      }),
      stepLine({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        input_tokens: 20000,
        cache_read_tokens: 0,
        output_tokens: 500,
      }),
    ].join(''),
    'utf-8'
  );
  const parsedMain = reader.readTranscript(mainPath);
  assert.equal(parsedMain.isChildTranscript, false);
  assert.equal(computeMetrics(parsedMain).isChildTranscript, false);
});

test('transcript: downsamples series > 500 points preserving pre/post compaction boundaries and tail', () => {
  // Space PLANNER_RESPONSE stepIndex by 2 so CHECKPOINT.stepIndex (e.g. 201) sits strictly between two responses
  const series = [];
  for (let i = 0; i < 650; i++) {
    series.push({
      stepIndex: i * 2,
      ts: null,
      contextTokens: 1000 + i * 100,
      uncachedInput: 100,
      cacheRead: 900 + i * 100,
      outputTokens: 50,
      delta: i === 0 ? 0 : 100,
      model: 'm',
    });
  }
  const compactions = [{ stepIndex: 201 }, { stepIndex: 351 }];
  const sampled = downsampleSeries(series, compactions, 500);
  assert.ok(sampled.length <= 500);
  // Pre-compaction (200) and post-compaction (202) for checkpoint 201 must both survive
  assert.equal(sampled.some((p) => p.stepIndex === 200), true);
  assert.equal(sampled.some((p) => p.stepIndex === 202), true);
  // Pre-compaction (350) and post-compaction (352) for checkpoint 351 must both survive
  assert.equal(sampled.some((p) => p.stepIndex === 350), true);
  assert.equal(sampled.some((p) => p.stepIndex === 352), true);
  assert.deepEqual(
    sampled.slice(-250).map((p) => p.stepIndex),
    series.slice(-250).map((p) => p.stepIndex)
  );
});

test('transcript: handles unlinked files safely (TOCTOU) and evicts least-recently-used entries', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-lru-toctou-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const reader = createTranscriptReader({ maxCacheEntries: 3 });
  const paths = [];
  for (let i = 0; i < 3; i++) {
    const p = join(dir, `t${i}.jsonl`);
    writeFileSync(
      p,
      stepLine({ step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 1000 * (i + 1), cache_read_tokens: 0 }),
      'utf-8'
    );
    paths.push(p);
    assert.ok(reader.readTranscript(p));
  }

  // Re-access t0 so t1 becomes the least-recently-used entry
  assert.ok(reader.readTranscript(paths[0]));

  const p3 = join(dir, 't3.jsonl');
  writeFileSync(
    p3,
    stepLine({ step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 4000, cache_read_tokens: 0 }),
    'utf-8'
  );
  assert.ok(reader.readTranscript(p3));

  assert.equal(reader.size(), 3);
  assert.equal(reader.has(paths[0]), true);
  assert.equal(reader.has(paths[1]), false);
  assert.equal(reader.has(paths[2]), true);
  assert.equal(reader.has(p3), true);

  // Unlinking a cached file returns null without throwing and evicts from cache
  unlinkSync(paths[0]);
  assert.equal(reader.readTranscript(paths[0]), null);
  assert.equal(reader.has(paths[0]), false);
});

// Minimal protobuf wire encoder helpers for unit tests
function encodeVarint(value) {
  let v = BigInt(value);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeFieldBytes(fieldNumber, payload) {
  const tag = encodeVarint((BigInt(fieldNumber) << 3n) | 2n);
  const len = encodeVarint(payload.length);
  return Buffer.concat([tag, len, payload]);
}

function encodeFieldString(fieldNumber, str) {
  return encodeFieldBytes(fieldNumber, Buffer.from(str, 'utf-8'));
}

function encodeFieldVarint(fieldNumber, value) {
  return Buffer.concat([encodeVarint((BigInt(fieldNumber) << 3n) | 0n), encodeVarint(value)]);
}

function encodeFieldFixed64(fieldNumber) {
  return Buffer.concat([encodeVarint((BigInt(fieldNumber) << 3n) | 1n), Buffer.alloc(8, 0xaa)]);
}

function encodeFieldFixed32(fieldNumber) {
  return Buffer.concat([encodeVarint((BigInt(fieldNumber) << 3n) | 5n), Buffer.alloc(4, 0xbb)]);
}

test('transcript: extracts <USER_SETTINGS_CHANGE> models, dotted versions, ignores None/quotes, and tracks mid-session switches', (t) => {
  // 1. Standard block with dotted version number
  assert.equal(
    extractModelFromSettingsChange(
      '<USER_REQUEST>\nhi\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment on this change.\n</USER_SETTINGS_CHANGE>'
    ),
    'Gemini 3.8 Flash (High)'
  );

  // 2. Fallback line-ending period without "No need to comment"
  assert.equal(
    extractModelFromSettingsChange(
      '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Hydrogen (High).\n</USER_SETTINGS_CHANGE>'
    ),
    'Gemini 4 Hydrogen (High)'
  );

  // 3. Ignores non-tag user quotes
  assert.equal(
    extractModelFromSettingsChange(
      '<USER_REQUEST>\nThe user changed setting `Model Selection` from None to Gemini 4 Carbon (High). No need to comment.\n</USER_REQUEST>'
    ),
    ''
  );

  // 4. Ignores 'None' and takes last non-empty block when multiple appear
  assert.equal(
    extractModelFromSettingsChange(
      '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Hydrogen (High). No need to comment.\n</USER_SETTINGS_CHANGE>\n' +
        '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Hydrogen (High) to Orchestrator (Carbon). No need to comment.\n</USER_SETTINGS_CHANGE>'
    ),
    'Orchestrator (Carbon)'
  );
  assert.equal(
    extractModelFromSettingsChange(
      '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Neon (Medium). No need to comment.\n</USER_SETTINGS_CHANGE>\n' +
        '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Neon (Medium) to None. No need to comment.\n</USER_SETTINGS_CHANGE>'
    ),
    'Gemini 4 Neon (Medium)'
  );
  assert.equal(
    extractModelFromSettingsChange(
      '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Hydrogen (High) to None. No need to comment.\n</USER_SETTINGS_CHANGE>'
    ),
    ''
  );

  // 5. Chronological mid-session model switch & fallback priority
  const dir = mkdtempSync(join(tmpdir(), 'tc-model-switch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trPath = join(dir, 'transcript.jsonl');

  writeFileSync(
    trPath,
    [
      stepLine({
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content:
          '<USER_REQUEST>\nStart\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Hydrogen (High). No need to comment.\n</USER_SETTINGS_CHANGE>',
      }),
      stepLine({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        input_tokens: 15000,
        cache_read_tokens: 0,
        output_tokens: 200,
      }),
    ].join(''),
    'utf-8'
  );

  const reader = createTranscriptReader();
  const m1 = computeMetrics(reader.readTranscript(trPath), DEFAULT_SETTINGS, {
    fallbackModel: 'gemini-4-carbon-high',
    modelSource: 'gen_metadata',
  });
  assert.equal(m1.metrics.model, 'Gemini 4 Hydrogen (High)');
  assert.equal(m1.metrics.modelSource, 'settings_change');
  assert.equal(m1.effectiveThresholds.profileId, 'hydrogen');

  // Switch mid-session via USER_SETTINGS_CHANGE followed by PLANNER_RESPONSE without model
  appendFileSync(
    trPath,
    [
      stepLine({
        step_index: 2,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content:
          '<USER_REQUEST>\nSwitch\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Hydrogen (High) to Orchestrator (Carbon). No need to comment.\n</USER_SETTINGS_CHANGE>',
      }),
      stepLine({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        input_tokens: 25000,
        cache_read_tokens: 15000,
        output_tokens: 300,
      }),
    ].join(''),
    'utf-8'
  );

  const m2 = computeMetrics(reader.readTranscript(trPath), DEFAULT_SETTINGS);
  assert.equal(m2.metrics.model, 'Orchestrator (Carbon)');
  assert.equal(m2.metrics.modelSource, 'settings_change');
  assert.equal(m2.effectiveThresholds.profileId, 'orchestrator-carbon');

  // Explicit PLANNER_RESPONSE.model overrides settings_change
  appendFileSync(
    trPath,
    stepLine({
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      model: 'gemini-4-neon-medium',
      input_tokens: 30000,
      cache_read_tokens: 20000,
      output_tokens: 300,
    }),
    'utf-8'
  );
  const m3 = computeMetrics(reader.readTranscript(trPath), DEFAULT_SETTINGS);
  assert.equal(m3.metrics.model, 'gemini-4-neon-medium');
  assert.equal(m3.metrics.modelSource, 'transcript');
  assert.equal(m3.effectiveThresholds.profileId, 'neon');

  // Transcript without any model signal uses Tier 2 gen_metadata fallback or Tier 3 none
  const noModelPath = join(dir, 'no-model.jsonl');
  writeFileSync(
    noModelPath,
    stepLine({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      input_tokens: 10000,
      cache_read_tokens: 0,
      output_tokens: 100,
    }),
    'utf-8'
  );
  const noModelParsed = reader.readTranscript(noModelPath);
  const withFallback = computeMetrics(noModelParsed, DEFAULT_SETTINGS, {
    fallbackModel: 'gemini-4-hydrogen-tiered-high',
    modelSource: 'gen_metadata',
  });
  assert.equal(withFallback.metrics.model, 'gemini-4-hydrogen-tiered-high');
  assert.equal(withFallback.metrics.modelSource, 'gen_metadata');
  assert.equal(withFallback.effectiveThresholds.profileId, 'hydrogen');

  const withoutFallback = computeMetrics(noModelParsed, DEFAULT_SETTINGS);
  assert.equal(withoutFallback.metrics.model, '');
  assert.equal(withoutFallback.metrics.modelSource, 'none');
  assert.equal(withoutFallback.effectiveThresholds.source, 'fallback');
});

test('gen_metadata: decodes protobuf blobs safely across wire types and malformed inputs', () => {
  // 1. Standard blob with wire types 0 (varint including 64-bit), 1 (fixed64), 2 (bytes), 5 (fixed32)
  const f1 = Buffer.concat([
    encodeFieldVarint(2, 123456789012345n),
    encodeFieldFixed64(4),
    encodeFieldFixed32(5),
    encodeFieldString(19, 'gemini-4-hydrogen-tiered-high'),
    encodeFieldString(21, 'Gemini 4 Hydrogen (High)'),
  ]);
  const f3 = Buffer.concat([
    encodeFieldVarint(1, 42n),
    encodeFieldString(28, 'gemini-4-hydrogen-high'),
  ]);
  const blob = Buffer.concat([
    encodeFieldBytes(1, f1),
    encodeFieldBytes(2, Buffer.from('ignored')),
    encodeFieldBytes(3, f3),
  ]);

  assert.deepEqual(extractModelFromGenMetadataBlob(blob), {
    modelId: 'gemini-4-hydrogen-tiered-high',
    requestModelId: 'gemini-4-hydrogen-high',
    displayLabel: 'Gemini 4 Hydrogen (High)',
    bestModel: 'gemini-4-hydrogen-tiered-high',
  });

  // 2. Empty f1.f19 falls back to f3.f28, then f1.f21
  const f1Empty19 = Buffer.concat([
    encodeFieldString(19, ''),
    encodeFieldString(21, 'Gemini 4 Neon (Medium)'),
  ]);
  const blobFallbackReq = Buffer.concat([
    encodeFieldBytes(1, f1Empty19),
    encodeFieldBytes(3, encodeFieldString(28, 'gemini-4-neon-medium')),
  ]);
  assert.deepEqual(extractModelFromGenMetadataBlob(blobFallbackReq), {
    modelId: '',
    requestModelId: 'gemini-4-neon-medium',
    displayLabel: 'Gemini 4 Neon (Medium)',
    bestModel: 'gemini-4-neon-medium',
  });

  const blobOnlyLabel = encodeFieldBytes(1, encodeFieldString(21, 'Orchestrator (Carbon)'));
  assert.deepEqual(extractModelFromGenMetadataBlob(blobOnlyLabel), {
    modelId: '',
    requestModelId: '',
    displayLabel: 'Orchestrator (Carbon)',
    bestModel: 'Orchestrator (Carbon)',
  });

  // 3. Malformed / truncated / invalid inputs never throw
  const malformedInputs = [
    null,
    undefined,
    Buffer.alloc(0),
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), // >10 byte varint
    Buffer.from([0x0a, 0x7f, 0x01, 0x02]), // length exceeds buffer
    Buffer.from([0x0b, 0x01]), // wire type 3 (unsupported)
    Buffer.from([0x00]), // field number 0 (invalid)
    Buffer.concat([encodeFieldBytes(1, Buffer.from([0x9a, 0x01, 0x50]))]), // truncated nested length
  ];
  for (const bad of malformedInputs) {
    const res = extractModelFromGenMetadataBlob(bad);
    assert.deepEqual(res, {
      modelId: '',
      requestModelId: '',
      displayLabel: '',
      bestModel: '',
    });
  }
});

test('gen_metadata: reads SQLite DB read-only, invalidates cache on WAL update, and clears cache cleanly', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-gen-meta-'));
  t.after(() => {
    clearGenMetadataCache();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  clearGenMetadataCache();
  const convDir = join(dir, 'conversations');
  mkdirSync(convDir, { recursive: true });

  const convId = 'session-wal-1';
  const dbPath = join(convDir, `${convId}.db`);

  const blob1 = Buffer.concat([
    encodeFieldBytes(
      1,
      Buffer.concat([
        encodeFieldString(19, 'gemini-4-hydrogen-tiered-high'),
        encodeFieldString(21, 'Gemini 4 Hydrogen (High)'),
      ])
    ),
  ]);

  let first;
  let hit;
  let second;
  const writer = new DatabaseSync(dbPath);
  try {
    writer.exec('PRAGMA journal_mode = WAL;');
    writer.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));');
    writer.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, blob1, blob1.length);

    first = readSessionModelFromGenMetadata(dir, convId);
    assert.ok(first);
    assert.equal(first.model, 'gemini-4-hydrogen-tiered-high');
    assert.equal(first.displayLabel, 'Gemini 4 Hydrogen (High)');
    assert.ok(first.cacheSig);

    // Cache hit returns identical cacheSig
    hit = readSessionModelFromGenMetadata(dir, convId);
    assert.deepEqual(hit, first);

    // Update via WAL without checkpointing: cacheSig must change and newest idx wins
    const blob2 = Buffer.concat([
      encodeFieldBytes(1, encodeFieldString(21, 'Orchestrator (Carbon)')),
      encodeFieldBytes(3, encodeFieldString(28, 'gemini-pro-orchestrator-carbon')),
    ]);
    writer.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(2, blob2, blob2.length);

    second = readSessionModelFromGenMetadata(dir, convId);
  } finally {
    writer.close();
  }

  assert.ok(second);
  assert.equal(second.model, 'gemini-pro-orchestrator-carbon');
  assert.equal(second.displayLabel, 'Orchestrator (Carbon)');
  assert.notEqual(second.cacheSig, first.cacheSig);

  // Missing DB and unsafe convId return null
  assert.equal(readSessionModelFromGenMetadata(dir, 'does-not-exist'), null);
  assert.equal(readSessionModelFromGenMetadata(dir, '../evil'), null);
  clearGenMetadataCache();
});

test('transcript: handles CRLF incremental and torn-line parsing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-transcript-crlf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const trPath = join(dir, 'transcript.jsonl');
  const line1 =
    JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      model: 'gemini-4-neon-medium',
      input_tokens: 1000,
      cache_read_tokens: 4000,
      output_tokens: 100,
    }) + '\r\n';
  const line2Full =
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      model: 'gemini-4-neon-medium',
      input_tokens: 2000,
      cache_read_tokens: 8000,
      output_tokens: 200,
    }) + '\r\n';

  // Write line1 + torn prefix of line2
  const tornSplit = 25;
  writeFileSync(trPath, line1 + line2Full.slice(0, tornSplit), 'utf-8');

  const reader = createTranscriptReader();
  const m1 = computeMetrics(reader.readTranscript(trPath), DEFAULT_SETTINGS);
  assert.equal(m1.metrics.contextTokens, 5000);
  assert.equal(m1.series.length, 1);

  // Complete line2 with CRLF
  appendFileSync(trPath, line2Full.slice(tornSplit), 'utf-8');
  const m2 = computeMetrics(reader.readTranscript(trPath), DEFAULT_SETTINGS);
  assert.equal(m2.metrics.contextTokens, 10000);
  assert.equal(m2.series.length, 2);
});

test('transcript: st.ino === 0n (FAT32/exFAT) uses birthtimeNs + headFingerprint for cache hit and replacement detection', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-transcript-zero-ino-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const trPath = join(dir, 'transcript.jsonl');
  const step1 = stepLine({
    step_index: 0,
    type: 'PLANNER_RESPONSE',
    source: 'MODEL',
    model: 'gemini-4-hydrogen-high',
    input_tokens: 1000,
    cache_read_tokens: 2000,
    output_tokens: 50,
  });
  const step2 = stepLine({
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    source: 'MODEL',
    model: 'gemini-4-hydrogen-high',
    input_tokens: 1500,
    cache_read_tokens: 3500,
    output_tokens: 60,
  });
  writeFileSync(trPath, step1, 'utf-8');

  const fixedBirthNs = 1_700_000_000_000_000_000n;
  let statCalls = 0;
  const reader = createTranscriptReader({
    statFn(p) {
      statCalls += 1;
      const real = statSync(p, { bigint: true });
      return {
        ...real,
        ino: 0n,
        birthtimeNs: fixedBirthNs,
      };
    },
  });

  // Initial read
  const first = reader.readTranscript(trPath);
  const mFirst = computeMetrics(first, DEFAULT_SETTINGS);
  assert.equal(mFirst.metrics.contextTokens, 3000);
  assert.equal(mFirst.series.length, 1);

  // Cache hit with identical size, mtimeNs, birthtimeNs, and ino === 0n
  const hit = reader.readTranscript(trPath);
  assert.equal(hit, first);
  assert.equal(statCalls, 2);

  // Append step2 (prefix unchanged) -> incremental resume
  appendFileSync(trPath, step2, 'utf-8');
  const mAppended = computeMetrics(reader.readTranscript(trPath), DEFAULT_SETTINGS);
  assert.equal(mAppended.metrics.contextTokens, 5000);
  assert.equal(mAppended.series.length, 2);

  // Replace file with different prefix (larger size, same birthtimeNs, ino === 0n) -> must reparse from offset 0
  const replacement =
    stepLine({
      step_index: 0,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      content: 'new session prompt',
    }) +
    stepLine({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      model: 'gemini-4-carbon-high',
      input_tokens: 10000,
      cache_read_tokens: 15000,
      output_tokens: 120,
    });
  writeFileSync(trPath, replacement, 'utf-8');

  const mReplaced = computeMetrics(reader.readTranscript(trPath), DEFAULT_SETTINGS);
  assert.equal(mReplaced.metrics.model, 'gemini-4-carbon-high');
  assert.equal(mReplaced.metrics.contextTokens, 25000);
  assert.equal(mReplaced.series.length, 1);
});

test('gen_metadata: does not cache transient SQLite lock errors and recovers on next poll', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-gen-meta-lock-'));
  t.after(() => {
    clearGenMetadataCache();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  clearGenMetadataCache();
  const convDir = join(dir, 'conversations');
  mkdirSync(convDir, { recursive: true });

  const convId = 'session-lock-1';
  const dbPath = join(convDir, `${convId}.db`);
  const blob = Buffer.concat([
    encodeFieldBytes(1, encodeFieldString(19, 'gemini-4-neon-medium')),
  ]);

  const writer = new DatabaseSync(dbPath);
  try {
    writer.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));');
    writer.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, blob, blob.length);

    // Hold an exclusive write lock so the read-only probe hits SQLITE_BUSY
    writer.exec('BEGIN EXCLUSIVE;');
    const duringLock = readSessionModelFromGenMetadata(dir, convId);
    assert.equal(duringLock, null);

    // Release the lock without modifying the DB file; next poll must NOT serve a cached null
    writer.exec('ROLLBACK;');
  } finally {
    writer.close();
  }

  const afterUnlock = readSessionModelFromGenMetadata(dir, convId);
  assert.ok(afterUnlock);
  assert.equal(afterUnlock.model, 'gemini-4-neon-medium');
  clearGenMetadataCache();
});

test('transcript: preserves Orchestrator model across internal worker turns while keeping exact per-turn tokens', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-worker-preserve-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const trPath = join(dir, 'transcript.jsonl');
  writeFileSync(
    trPath,
    [
      stepLine({
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content: 'Run multi-step task',
      }),
      stepLine({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        model: 'gemini-pro-orchestrator-neon',
        input_tokens: 10000,
        cache_read_tokens: 50000,
        output_tokens: 400,
      }),
      // Internal worker turn must NOT overwrite Orchestrator (Neon), and must keep exact token readings
      stepLine({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        model: 'gemini-flash-worker-agy',
        input_tokens: 2000,
        cache_read_tokens: 18000,
        output_tokens: 150,
      }),
    ].join(''),
    'utf-8'
  );

  const reader = createTranscriptReader();
  const parsed = reader.readTranscript(trPath);
  const res = computeMetrics(parsed, DEFAULT_SETTINGS);

  assert.equal(res.metrics.model, 'gemini-pro-orchestrator-neon');
  assert.equal(res.metrics.modelSource, 'transcript');
  assert.equal(res.effectiveThresholds.profileId, 'orchestrator-neon');
  assert.equal(res.series.length, 2);
  assert.equal(res.series[0].contextTokens, 60000);
  assert.equal(res.series[1].contextTokens, 20000);
  assert.equal(res.series[1].uncachedInput, 2000);
  assert.equal(res.series[1].cacheRead, 18000);
  assert.equal(res.series[1].outputTokens, 150);
  assert.equal(res.series[1].delta, -40000);
  assert.equal(res.metrics.contextTokens, 20000);

  // Genuine mid-session <USER_SETTINGS_CHANGE> still overrides immediately, even if worker turns follow
  appendFileSync(
    trPath,
    [
      stepLine({
        step_index: 3,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content:
          '<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from Orchestrator (Neon) to Gemini 4 Carbon (High). No need to comment.</USER_SETTINGS_CHANGE>',
      }),
      stepLine({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        model: 'gemini-flash-worker-agy',
        input_tokens: 5000,
        cache_read_tokens: 25000,
        output_tokens: 200,
      }),
    ].join(''),
    'utf-8'
  );

  const switched = computeMetrics(reader.readTranscript(trPath), DEFAULT_SETTINGS);
  assert.equal(switched.metrics.model, 'Gemini 4 Carbon (High)');
  assert.equal(switched.metrics.modelSource, 'settings_change');
  assert.equal(switched.effectiveThresholds.profileId, 'carbon');
  assert.equal(switched.metrics.contextTokens, 30000);
});

test('transcript: standalone worker model maps to hydrogen and prefers non-worker gen_metadata fallback', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-worker-fallback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const trPath = join(dir, 'transcript.jsonl');
  writeFileSync(
    trPath,
    stepLine({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      model: 'gemini-flash-worker-agy',
      input_tokens: 4000,
      cache_read_tokens: 6000,
      output_tokens: 100,
    }),
    'utf-8'
  );

  const reader = createTranscriptReader();
  const parsed = reader.readTranscript(trPath);

  const standalone = computeMetrics(parsed, DEFAULT_SETTINGS);
  assert.equal(standalone.metrics.model, 'gemini-flash-worker-agy');
  assert.equal(standalone.metrics.modelSource, 'transcript');
  assert.equal(standalone.effectiveThresholds.profileId, 'hydrogen');
  assert.equal(standalone.effectiveThresholds.source, 'model');

  const withParentFallback = computeMetrics(parsed, DEFAULT_SETTINGS, {
    fallbackModel: 'gemini-pro-orchestrator-argon',
    modelSource: 'gen_metadata',
  });
  assert.equal(withParentFallback.metrics.model, 'gemini-pro-orchestrator-argon');
  assert.equal(withParentFallback.metrics.modelSource, 'gen_metadata');
  assert.equal(withParentFallback.effectiveThresholds.profileId, 'orchestrator-argon');
});

test('gen_metadata: skips trailing internal worker rows to recover parent orchestrator model', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-gen-meta-worker-'));
  t.after(() => {
    clearGenMetadataCache();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  clearGenMetadataCache();
  const convDir = join(dir, 'conversations');
  mkdirSync(convDir, { recursive: true });

  const convId = 'session-worker-scan';
  const dbPath = join(convDir, `${convId}.db`);
  const parentBlob = Buffer.concat([
    encodeFieldBytes(1, encodeFieldString(19, 'gemini-pro-orchestrator-argon')),
  ]);
  const workerBlob = Buffer.concat([
    encodeFieldBytes(1, encodeFieldString(19, 'gemini-flash-worker-agy')),
  ]);

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));');
    const insert = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
    insert.run(1, parentBlob, parentBlob.length);
    insert.run(2, workerBlob, workerBlob.length);
    insert.run(3, workerBlob, workerBlob.length);
  } finally {
    db.close();
  }

  const res = readSessionModelFromGenMetadata(dir, convId);
  assert.ok(res);
  assert.equal(res.model, 'gemini-pro-orchestrator-argon');

  // If only worker rows exist, return the newest worker row
  const workerOnlyId = 'session-worker-only';
  const workerDb = new DatabaseSync(join(convDir, `${workerOnlyId}.db`));
  try {
    workerDb.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));');
    workerDb
      .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
      .run(1, workerBlob, workerBlob.length);
  } finally {
    workerDb.close();
  }

  const workerRes = readSessionModelFromGenMetadata(dir, workerOnlyId);
  assert.ok(workerRes);
  assert.equal(workerRes.model, 'gemini-flash-worker-agy');
  clearGenMetadataCache();
});
