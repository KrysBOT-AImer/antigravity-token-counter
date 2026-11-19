import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  closeCachedDbs,
  findAppDataDir,
  getDiscoverySource,
  listMainSessions,
  listMainSessionsWithMeta,
  normalizeWorkspaceUri,
  readActiveLockIds,
  readLatestViewedSession,
  resolveEventsDir,
  resolveRootMainSession,
  resolveTargetSession,
  workspaceBasename,
  workspaceMatches,
} from '../sidecars/token_counter/lib/discovery.mjs';
import { clearGenMetadataCache } from '../sidecars/token_counter/lib/gen_metadata.mjs';

function createMockDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      last_modified_time TEXT NOT NULL,
      workspace_uris TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      agent_name TEXT NOT NULL DEFAULT '',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      not_fully_idle INTEGER NOT NULL DEFAULT 0,
      killed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE conversation_parents (
      conversation_id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
  return db;
}

function writeTranscript(appDataDir, convId, lines) {
  const dir = join(appDataDir, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'transcript.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf-8'
  );
}

test('discovery: excludes subagents/killed, walks multi-hop parents, and detects FLOCK-only /proc/locks', (t) => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'tc-discovery-'));
  t.after(() => {
    closeCachedDbs();
    rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  mkdirSync(join(appDataDir, 'brain'), { recursive: true });
  mkdirSync(join(appDataDir, 'presence'), { recursive: true });
  const dataDir = join(appDataDir, 'sidecar_data', 'token-counter', 'token_counter', 'data');
  mkdirSync(dataDir, { recursive: true });

  assert.equal(
    findAppDataDir({ env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir } }),
    appDataDir
  );

  const dbPath = join(appDataDir, 'conversation_summaries.db');
  const db = createMockDb(dbPath);

  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, last_modified_time, workspace_uris,
      status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    'main-active-1',
    'Main Active Session',
    '2026-11-19 20:10:00+00:00',
    '["file:///workspace/Token%20counter/"]',
    'CASCADE_RUN_STATUS_RUNNING',
    '',
    '',
    0,
    1,
    0
  );
  insert.run(
    'main-older-2',
    'Older Other Workspace',
    '2026-11-19 19:00:00+00:00',
    '["file:///tmp/other/"]',
    'CASCADE_RUN_STATUS_IDLE',
    '',
    '',
    0,
    0,
    0
  );
  insert.run(
    'main-killed-3',
    'Killed Main',
    '2026-11-19 20:20:00+00:00',
    '',
    'CASCADE_RUN_STATUS_IDLE',
    '',
    '',
    0,
    0,
    1
  );
  insert.run(
    'child-planner-1',
    '',
    '2026-11-19 20:11:00+00:00',
    '',
    'CASCADE_RUN_STATUS_IDLE',
    'planner',
    'main-active-1',
    1,
    0,
    0
  );
  insert.run(
    'grandchild-scout-2',
    '',
    '2026-11-19 20:12:00+00:00',
    '',
    'CASCADE_RUN_STATUS_IDLE',
    'scout',
    'child-planner-1',
    2,
    0,
    0
  );
  db.close();

  writeTranscript(appDataDir, 'main-active-1', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 15000, cache_read_tokens: 30000, output_tokens: 200 },
  ]);
  writeTranscript(appDataDir, 'main-older-2', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 130000, cache_read_tokens: 0, output_tokens: 100 },
  ]);

  // Create lock files and matching mock /proc/locks (FLOCK matched, POSIX ignored)
  const lockFile1 = join(appDataDir, 'presence', 'main-active-1.lock');
  const lockFile2 = join(appDataDir, 'presence', 'main-older-2.lock');
  writeFileSync(lockFile1, '', 'utf-8');
  writeFileSync(lockFile2, '', 'utf-8');
  const ino1 = statSync(lockFile1).ino;
  const ino2 = statSync(lockFile2).ino;
  const mockLocks = join(appDataDir, 'mock_proc_locks');
  writeFileSync(
    mockLocks,
    `1: FLOCK  ADVISORY  WRITE 1234 00:24:${ino1} 0 EOF\n` +
      `2: POSIX  ADVISORY  WRITE 5678 00:24:${ino2} 0 EOF\n`,
    'utf-8'
  );

  const locks = readActiveLockIds({ appDataDir, locksPath: mockLocks });
  assert.equal(locks.has('main-active-1'), true);
  assert.equal(locks.has('main-older-2'), false);

  const { sessions, discoverySource } = listMainSessionsWithMeta({
    appDataDir,
    locksPath: mockLocks,
  });
  assert.equal(discoverySource, 'sqlite');
  assert.deepEqual(
    sessions.map((s) => s.id),
    ['main-active-1', 'main-older-2']
  );
  assert.equal(sessions[0].isActiveLock, true);
  assert.equal(sessions[0].contextTokens, 45000);
  assert.equal(sessions[0].workspace, 'Token counter');
  assert.equal(sessions[1].zone, 'caution');

  // Multi-workspace matching accepts arrays of URIs
  assert.equal(
    workspaceMatches('["file:///tmp/other/"]', [
      'file:///workspace/Token%20counter/',
      'file:///tmp/other/',
    ]),
    true
  );
  const wsList = listMainSessions({
    appDataDir,
    locksPath: mockLocks,
    workspaceUris: ['file:///tmp/other/'],
  });
  assert.equal(wsList[0].id, 'main-older-2');

  // Multi-hop root resolution from grandchild -> child -> main-active-1
  const resolved = resolveRootMainSession('grandchild-scout-2', { appDataDir });
  assert.equal(resolved.id, 'main-active-1');
  assert.equal(resolved.resolvedFromChildId, 'grandchild-scout-2');

  // Current mode with child ID resolves to root main
  const targetFromChild = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    conversationId: 'child-planner-1',
    mode: 'current',
  });
  assert.equal(targetFromChild.id, 'main-active-1');
  assert.equal(targetFromChild.resolvedFromChildId, 'child-planner-1');

  // Auto mode picks active workspace session
  const autoTarget = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    mode: 'auto',
    workspaceUris: ['file:///workspace/Token%20counter/'],
  });
  assert.equal(autoTarget.id, 'main-active-1');
});

test('discovery: FS fallback resolves .parent_id_cache, subagents/*.json, and swarm/members.json and filters children', (t) => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'tc-fallback-'));
  t.after(() => {
    closeCachedDbs();
    rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  writeTranscript(appDataDir, 'main-fs-1', [
    { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\nMain session prompt\n</USER_REQUEST>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 12000, cache_read_tokens: 0, output_tokens: 100 },
  ]);
  // Worker discovered via transcript signature
  writeTranscript(appDataDir, 'worker-fs-2', [
    { step_index: 0, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: '<swarm_worker>\nYou are worker\n</swarm_worker>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 99000, cache_read_tokens: 0, output_tokens: 100 },
  ]);
  // Child via .parent_id_cache.json
  writeTranscript(appDataDir, 'child-cache-3', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 40000, cache_read_tokens: 0, output_tokens: 100 },
  ]);
  writeFileSync(
    join(appDataDir, 'brain', 'child-cache-3', '.system_generated', '.parent_id_cache.json'),
    JSON.stringify({ parent_id: 'main-fs-1' }),
    'utf-8'
  );
  // Child via subagents/<id>.json on main-fs-1
  writeTranscript(appDataDir, 'child-subagent-4', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 30000, cache_read_tokens: 0, output_tokens: 100 },
  ]);
  mkdirSync(join(appDataDir, 'brain', 'main-fs-1', '.system_generated', 'subagents'), { recursive: true });
  writeFileSync(
    join(appDataDir, 'brain', 'main-fs-1', '.system_generated', 'subagents', 'child-subagent-4.json'),
    JSON.stringify({ conversationId: 'child-subagent-4', agentName: 'scout' }),
    'utf-8'
  );
  // Forked & normal swarm workers via swarm/members.json
  writeTranscript(appDataDir, 'swarm-forked-5', [
    { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Copied parent prompt' },
    { step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 60000, cache_read_tokens: 0, output_tokens: 100 },
  ]);
  writeTranscript(appDataDir, 'swarm-fresh-6', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 20000, cache_read_tokens: 0, output_tokens: 100 },
  ]);
  mkdirSync(join(appDataDir, 'brain', 'main-fs-1', '.system_generated', 'swarm'), { recursive: true });
  writeFileSync(
    join(appDataDir, 'brain', 'main-fs-1', '.system_generated', 'swarm', 'members.json'),
    JSON.stringify([
      { name: 'coordinator', role: 'coordinator', conversation_id: 'main-fs-1' },
      { name: 'planner', role: 'worker', conversation_id: 'swarm-forked-5' },
      { name: 'verifier', role: 'worker', conversation_id: 'swarm-fresh-6' },
    ]),
    'utf-8'
  );

  const meta = listMainSessionsWithMeta({
    appDataDir,
    locksPath: join(appDataDir, 'missing_locks'),
  });
  assert.equal(meta.discoverySource, 'fs_fallback');
  assert.equal(meta.sessions.length, 1);
  assert.equal(meta.sessions[0].id, 'main-fs-1');
  assert.equal(meta.sessions[0].title, 'Main session prompt');
  assert.equal(meta.sessions[0].contextTokens, 12000);

  for (const childId of ['child-cache-3', 'child-subagent-4', 'swarm-forked-5', 'swarm-fresh-6']) {
    const res = resolveRootMainSession(childId, { appDataDir });
    assert.ok(res, `expected ${childId} to resolve to main-fs-1`);
    assert.equal(res.id, 'main-fs-1');
    assert.equal(res.resolvedFromChildId, childId);
    assert.equal(res.discoverySource, 'fs_fallback');
  }
});

test('discovery: rejects orphan/cyclic children and falls back to active Main Session instead of leaking child metrics', (t) => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'tc-strict-main-'));
  t.after(() => {
    closeCachedDbs();
    rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  mkdirSync(join(appDataDir, 'brain'), { recursive: true });
  const dbPath = join(appDataDir, 'conversation_summaries.db');
  const db = createMockDb(dbPath);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, last_modified_time, workspace_uris,
      status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('main-real-1', 'Real Main', '2026-11-19 20:10:00+00:00', '', 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 1, 0);
  insert.run('orphan-child-1', '', '2026-11-19 20:11:00+00:00', '', 'CASCADE_RUN_STATUS_IDLE', 'scout', 'missing-parent', 1, 0, 0);
  insert.run('cycle-a', '', '2026-11-19 20:12:00+00:00', '', 'CASCADE_RUN_STATUS_IDLE', 'a', 'cycle-b', 1, 0, 0);
  insert.run('cycle-b', '', '2026-11-19 20:12:00+00:00', '', 'CASCADE_RUN_STATUS_IDLE', 'b', 'cycle-a', 1, 0, 0);
  db.close();

  writeTranscript(appDataDir, 'main-real-1', [
    { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Main work' },
    { step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 25000, cache_read_tokens: 0 },
  ]);
  writeTranscript(appDataDir, 'orphan-child-1', [
    { step_index: 0, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: 'Message from Parent Agent' },
    { step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 99999, cache_read_tokens: 0 },
  ]);
  writeTranscript(appDataDir, 'cycle-a', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 88888, cache_read_tokens: 0 },
  ]);

  assert.equal(resolveRootMainSession('orphan-child-1', { appDataDir }), null);
  assert.equal(resolveRootMainSession('cycle-a', { appDataDir }), null);

  // Current mode with orphan child falls back to active Main Session
  const fromCurrent = resolveTargetSession({
    appDataDir,
    locksPath: join(appDataDir, 'missing_locks'),
    conversationId: 'orphan-child-1',
    mode: 'current',
  });
  assert.equal(fromCurrent.id, 'main-real-1');

  // Pinned mode with identifiable orphan child falls back to active Main Session (never leaks child metrics)
  const fromPinnedChild = resolveTargetSession({
    appDataDir,
    locksPath: join(appDataDir, 'missing_locks'),
    conversationId: 'orphan-child-1',
    mode: 'pinned',
  });
  assert.equal(fromPinnedChild.id, 'main-real-1');

  // Pinned mode with non-existent ID preserves clean null/missing state
  const fromPinnedMissing = resolveTargetSession({
    appDataDir,
    locksPath: join(appDataDir, 'missing_locks'),
    conversationId: 'does-not-exist-999',
    mode: 'pinned',
  });
  assert.equal(fromPinnedMissing, null);
});

test('discovery: auto mode boosts waiting Main Session with activeChildCount over competing RUNNING session', (t) => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'tc-autoboost-'));
  t.after(() => {
    closeCachedDbs();
    rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  mkdirSync(join(appDataDir, 'presence'), { recursive: true });
  const dbPath = join(appDataDir, 'conversation_summaries.db');
  const db = createMockDb(dbPath);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, last_modified_time, workspace_uris,
      status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ws = '["file:///workspace/Token%20counter/"]';
  // Waiting orchestrator main session: IDLE + not_fully_idle=1 + active lock + activeChildCount=1 -> 16+8+4+1 = 29
  insert.run('main-waiting-orch', 'Orchestrator', '2026-11-19 20:00:00+00:00', ws, 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 1, 0);
  // Competing running main session in same workspace with active lock, 0 children -> 16+8+2 = 26
  insert.run('main-running-solo', 'Solo Tab', '2026-11-19 20:05:00+00:00', ws, 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 0, 0);
  // Running child under main-waiting-orch
  insert.run('child-worker-1', '', '2026-11-19 20:06:00+00:00', '', 'CASCADE_RUN_STATUS_RUNNING', 'worker', 'main-waiting-orch', 1, 1, 0);
  db.close();

  const lock1 = join(appDataDir, 'presence', 'main-waiting-orch.lock');
  const lock2 = join(appDataDir, 'presence', 'main-running-solo.lock');
  writeFileSync(lock1, '', 'utf-8');
  writeFileSync(lock2, '', 'utf-8');
  const mockLocks = join(appDataDir, 'mock_proc_locks');
  writeFileSync(
    mockLocks,
    `1: FLOCK ADVISORY WRITE 100 00:24:${statSync(lock1).ino} 0 EOF\n` +
      `2: FLOCK ADVISORY WRITE 101 00:24:${statSync(lock2).ino} 0 EOF\n`,
    'utf-8'
  );

  const picked = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    mode: 'auto',
    workspaceUris: ['file:///workspace/Token%20counter/'],
  });
  assert.equal(picked.id, 'main-waiting-orch');
  assert.equal(picked.activeChildCount, 1);
  assert.equal(picked.discoverySource, 'sqlite');
});

test('discovery: cached RO SQLite handle sees newly inserted rows immediately and cleans up via closeCachedDbs()', (t) => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'tc-dbcache-'));
  t.after(() => {
    closeCachedDbs();
    rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const dbPath = join(appDataDir, 'conversation_summaries.db');
  const db = createMockDb(dbPath);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, last_modified_time, workspace_uris,
      status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('main-1', 'First', '2026-11-19 20:00:00+00:00', '', 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);

  const first = listMainSessions({ appDataDir, locksPath: join(appDataDir, 'missing_locks') });
  assert.deepEqual(first.map((s) => s.id), ['main-1']);

  // Insert another row while cached RO handle is open
  insert.run('main-2', 'Second', '2026-11-19 20:05:00+00:00', '', 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);
  db.close();

  const second = listMainSessions({ appDataDir, locksPath: join(appDataDir, 'missing_locks') });
  assert.deepEqual(second.map((s) => s.id), ['main-2', 'main-1']);

  closeCachedDbs();
  const third = listMainSessions({ appDataDir, locksPath: join(appDataDir, 'missing_locks') });
  assert.deepEqual(third.map((s) => s.id), ['main-2', 'main-1']);
});

function encodeVarint(n) {
  const bytes = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeLengthDelimited(fieldNum, payloadBuf) {
  const tag = encodeVarint((fieldNum << 3) | 2);
  const len = encodeVarint(payloadBuf.length);
  return Buffer.concat([tag, len, payloadBuf]);
}

function writeGenMetadataDb(appDataDir, convId, modelId) {
  const convDir = join(appDataDir, 'conversations');
  mkdirSync(convDir, { recursive: true });
  const db = new DatabaseSync(join(convDir, `${convId}.db`));
  db.exec(`
    CREATE TABLE IF NOT EXISTS gen_metadata (
      idx integer,
      data blob,
      size integer NOT NULL DEFAULT 0,
      PRIMARY KEY (idx)
    );
  `);
  const f19 = encodeLengthDelimited(19, Buffer.from(modelId, 'utf-8'));
  const blob = encodeLengthDelimited(1, f19);
  db.prepare('INSERT OR REPLACE INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(
    blob,
    blob.length
  );
  db.close();
}

function writeEventJson(eventsDir, filename, timestampMs, rootConversationId) {
  mkdirSync(eventsDir, { recursive: true });
  writeFileSync(
    join(eventsDir, filename),
    JSON.stringify({
      timestampMs: String(timestampMs),
      payload: {
        conversationMetadata: {
          metadata: {
            rootConversationId,
          },
        },
      },
    }),
    'utf-8'
  );
}

function writeAnnotationPbtxt(appDataDir, convId, viewTimeMs, mtimeSec) {
  const annDir = join(appDataDir, 'annotations');
  mkdirSync(annDir, { recursive: true });
  const sec = Math.floor(viewTimeMs / 1000);
  const nanos = (viewTimeMs % 1000) * 1_000_000;
  const filePath = join(annDir, `${convId}.pbtxt`);
  writeFileSync(
    filePath,
    `title:"${convId}" last_user_view_time:{seconds:${sec} nanos:${nanos}}`,
    'utf-8'
  );
  if (mtimeSec !== undefined) {
    utimesSync(filePath, mtimeSec, mtimeSec);
  }
}

function writeAnnotationPbtxtNs(appDataDir, convId, seconds, nanos, mtimeSec) {
  const annDir = join(appDataDir, 'annotations');
  mkdirSync(annDir, { recursive: true });
  const filePath = join(annDir, `${convId}.pbtxt`);
  writeFileSync(
    filePath,
    `title:"${convId}" last_user_view_time:{seconds:${seconds} nanos:${nanos}}`,
    'utf-8'
  );
  if (mtimeSec !== undefined) {
    utimesSync(filePath, mtimeSec, mtimeSec);
  }
}

test('discovery: resolveEventsDir and readLatestViewedSession deterministic signal precedence & tie-breaking', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tc-viewed-'));
  t.after(() => {
    closeCachedDbs();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const appDataDir = join(root, 'appdata');
  const defaultEventsDir = join(appDataDir, 'sidecar_data', 'token-counter', 'token_counter', 'events');
  const customDataDir = join(root, 'custom', 'data');
  const customDataEventsDir = join(root, 'custom', 'events');
  const explicitEventsDir = join(root, 'explicit-events');
  mkdirSync(defaultEventsDir, { recursive: true });
  mkdirSync(customDataDir, { recursive: true });

  // Falls back to appDataDir events when dataDir sibling events/ does not exist
  assert.equal(resolveEventsDir({ appDataDir, dataDir: customDataDir }), defaultEventsDir);
  // Uses dataDir sibling events/ when present
  mkdirSync(customDataEventsDir, { recursive: true });
  assert.equal(resolveEventsDir({ appDataDir, dataDir: customDataDir }), customDataEventsDir);
  // Explicit eventsDir overrides all
  assert.equal(
    resolveEventsDir({ appDataDir, dataDir: customDataDir, eventsDir: explicitEventsDir }),
    explicitEventsDir
  );

  // Set up DB + locks for tie-breaking
  mkdirSync(join(appDataDir, 'presence'), { recursive: true });
  const db = createMockDb(join(appDataDir, 'conversation_summaries.db'));
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, last_modified_time, workspace_uris,
      status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('sess-a', 'A', '2026-11-19 20:00:00+00:00', '["file:///ws/other/"]', 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);
  insert.run('sess-b', 'B', '2026-11-19 20:00:00+00:00', '["file:///ws/target/"]', 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);
  insert.run('sess-c', 'C', '2026-11-19 20:00:00+00:00', '["file:///ws/other/"]', 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);
  db.close();

  // Case 1: event within 2000ms but older than annotation does NOT override; strictly newer event wins
  const baseMs = 1795125000000;
  writeAnnotationPbtxt(appDataDir, 'sess-a', baseMs, 1795125000);
  writeAnnotationPbtxt(appDataDir, 'sess-b', baseMs, 1795125001);
  writeEventJson(defaultEventsDir, '20261119_220000.000_ev1.json', baseMs - 1500, 'sess-c');
  const res1Stale = readLatestViewedSession({ appDataDir });
  assert.deepEqual(res1Stale, { id: 'sess-b', timestampMs: baseMs, source: 'annotations' });

  writeEventJson(defaultEventsDir, '20261119_220001.000_ev2.json', baseMs + 500, 'sess-c');
  const res1Newer = readLatestViewedSession({ appDataDir });
  assert.deepEqual(res1Newer, { id: 'sess-c', timestampMs: baseMs + 500, source: 'events' });

  // Case 2: strict workspace scoping isolates target workspace even when other workspace has newer annotations & events
  const newerMs = baseMs + 5000;
  writeAnnotationPbtxt(appDataDir, 'sess-a', newerMs, 1795125005);
  writeAnnotationPbtxt(appDataDir, 'sess-c', newerMs, 1795125005);
  writeEventJson(defaultEventsDir, '20261119_220006.000_ev3.json', newerMs + 1000, 'sess-c');
  const res2 = readLatestViewedSession({
    appDataDir,
    workspaceUris: ['file:///ws/target/'],
  });
  assert.deepEqual(res2, { id: 'sess-b', timestampMs: baseMs, source: 'annotations' });

  // Case 3: tied annotations across workspaces -> workspaceUris strictly selects target workspace ahead of lock/event
  const newerMs2 = baseMs + 10000;
  writeAnnotationPbtxt(appDataDir, 'sess-a', newerMs2, 1795125010);
  writeAnnotationPbtxt(appDataDir, 'sess-b', newerMs2, 1795125010);
  writeAnnotationPbtxt(appDataDir, 'sess-c', newerMs2, 1795125010);
  const res3 = readLatestViewedSession({
    appDataDir,
    workspaceUris: ['file:///ws/target/'],
    activeLocks: new Set(['sess-a']),
  });
  assert.deepEqual(res3, { id: 'sess-b', timestampMs: newerMs2, source: 'annotations' });

  // Case 4: tied viewTimeMs with no workspace match -> active lock and freshest transcript beat stale event match
  writeTranscript(appDataDir, 'sess-a', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 0 },
  ]);
  utimesSync(
    join(appDataDir, 'brain', 'sess-a', '.system_generated', 'logs', 'transcript.jsonl'),
    1795125002,
    1795125002
  );
  writeTranscript(appDataDir, 'sess-c', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 0 },
  ]);
  utimesSync(
    join(appDataDir, 'brain', 'sess-c', '.system_generated', 'logs', 'transcript.jsonl'),
    1795125020,
    1795125020
  );
  const res4Lock = readLatestViewedSession({
    appDataDir,
    workspaceUris: ['file:///ws/none/'],
    activeLocks: new Set(['sess-a']),
  });
  assert.deepEqual(res4Lock, { id: 'sess-a', timestampMs: newerMs2, source: 'annotations' });

  // Without locks, fresher transcript (sess-c) beats event-matched/other sessions, and when transcripts are equal, event match wins
  utimesSync(
    join(appDataDir, 'brain', 'sess-a', '.system_generated', 'logs', 'transcript.jsonl'),
    1795125025,
    1795125025
  );
  writeEventJson(defaultEventsDir, '20261119_220010.000_ev4.json', newerMs2, 'sess-b');
  const res4Transcript = readLatestViewedSession({
    appDataDir,
    workspaceUris: ['file:///ws/none/'],
    activeLocks: new Set(),
  });
  assert.deepEqual(res4Transcript, { id: 'sess-a', timestampMs: newerMs2, source: 'annotations' });
});

test('discovery: workspace-scoped tab-switch updates current, prevents cross-workspace hijack in current/auto, and keeps pinned immune', (t) => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'tc-tabswitch-'));
  t.after(() => {
    closeCachedDbs();
    clearGenMetadataCache();
    rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  mkdirSync(join(appDataDir, 'presence'), { recursive: true });
  const ws = '["file:///workspace/Token%20counter/"]';
  const db = createMockDb(join(appDataDir, 'conversation_summaries.db'));
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, last_modified_time, workspace_uris,
      status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Running Neon orchestrator with active lock + active child in Token counter workspace
  insert.run('neon-running', 'Neon Running', '2026-11-19 20:10:00+00:00', ws, 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 1, 0);
  insert.run('neon-child-1', '', '2026-11-19 20:10:05+00:00', '', 'CASCADE_RUN_STATUS_RUNNING', 'worker', 'neon-running', 1, 1, 0);
  // Idle tab in the SAME Token counter workspace
  insert.run('token-idle-tab', 'Token Idle Tab', '2026-11-19 19:30:00+00:00', ws, 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);
  // Idle Hydrogen tab in OTHER workspace
  insert.run('hydrogen-idle', 'Hydrogen Idle', '2026-11-19 19:00:00+00:00', '["file:///ws/other/"]', 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);
  insert.run('hydrogen-child', '', '2026-11-19 19:01:00+00:00', '', 'CASCADE_RUN_STATUS_IDLE', 'scout', 'hydrogen-idle', 1, 0, 0);
  db.close();

  // Transcripts omit model; gen_metadata supplies gemini-4-hydrogen-tiered-high for hydrogen-idle
  writeTranscript(appDataDir, 'neon-running', [
    { step_index: 0, type: 'PLANNER_RESPONSE', model: 'gemini-pro-orchestrator-neon', input_tokens: 50000, cache_read_tokens: 0 },
  ]);
  writeTranscript(appDataDir, 'token-idle-tab', [
    { step_index: 0, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon', input_tokens: 10000, cache_read_tokens: 0 },
  ]);
  writeTranscript(appDataDir, 'hydrogen-idle', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 100000, cache_read_tokens: 0 },
  ]);
  writeGenMetadataDb(appDataDir, 'hydrogen-idle', 'gemini-4-hydrogen-tiered-high');

  const lockFile = join(appDataDir, 'presence', 'neon-running.lock');
  writeFileSync(lockFile, '', 'utf-8');
  const mockLocks = join(appDataDir, 'mock_proc_locks');
  writeFileSync(
    mockLocks,
    `1: FLOCK ADVISORY WRITE 100 00:24:${statSync(lockFile).ino} 0 EOF\n`,
    'utf-8'
  );

  // Verify listMainSessionsWithMeta uses gen_metadata fallback for zone calculation (100k is caution for Hydrogen)
  const listed = listMainSessionsWithMeta({ appDataDir, locksPath: mockLocks });
  const hydroListed = listed.sessions.find((s) => s.id === 'hydrogen-idle');
  assert.equal(hydroListed.zone, 'caution');

  // Cross-workspace hydrogen-idle annotation must NOT hijack Token counter workspace in current or auto mode
  writeAnnotationPbtxt(appDataDir, 'hydrogen-idle', 1795125600000, 1795125600);

  const currentNoHijack = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    mode: 'current',
    conversationId: 'neon-running',
    workspaceUris: ['file:///workspace/Token%20counter/'],
  });
  assert.equal(currentNoHijack.id, 'neon-running');
  assert.equal(currentNoHijack.trackingMode, 'current');

  const autoNoHijack = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    mode: 'auto',
    workspaceUris: ['file:///workspace/Token%20counter/'],
  });
  assert.equal(autoNoHijack.id, 'neon-running');
  assert.equal(autoNoHijack.trackingMode, 'auto');

  // Same-workspace tab switch immediately updates current mode, even when cross-workspace hydrogen-idle is newer
  writeAnnotationPbtxt(appDataDir, 'token-idle-tab', 1795125601000, 1795125601);
  writeAnnotationPbtxt(appDataDir, 'hydrogen-idle', 1795125602000, 1795125602);

  const currentSameWs = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    mode: 'current',
    conversationId: 'neon-running',
    workspaceUris: ['file:///workspace/Token%20counter/'],
  });
  assert.equal(currentSameWs.id, 'token-idle-tab');
  assert.equal(currentSameWs.trackingMode, 'current');

  // In auto mode, running+locked+activeChild neon-running beats idle viewed token-idle-tab in the same workspace
  const autoActiveWins = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    mode: 'auto',
    workspaceUris: ['file:///workspace/Token%20counter/'],
  });
  assert.equal(autoActiveWins.id, 'neon-running');
  assert.equal(autoActiveWins.trackingMode, 'auto');

  // Pinned mode remains completely immune to tab switches
  const pinnedTarget = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    mode: 'pinned',
    conversationId: 'neon-running',
    workspaceUris: ['file:///workspace/Token%20counter/'],
  });
  assert.equal(pinnedTarget.id, 'neon-running');
  assert.equal(pinnedTarget.trackingMode, 'pinned');

  // Event pointing to a child/subagent ID resolves up to root main session in current mode
  const eventsDir = join(appDataDir, 'sidecar_data', 'token-counter', 'token_counter', 'events');
  writeEventJson(eventsDir, '20261119_230000.000_sub.json', 1795125605000, 'hydrogen-child');
  const childViewedOtherWs = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    mode: 'current',
    conversationId: 'neon-running',
    workspaceUris: ['file:///ws/other/'],
  });
  assert.equal(childViewedOtherWs.id, 'hydrogen-idle');
  assert.equal(childViewedOtherWs.resolvedFromChildId, 'hydrogen-child');

  // In Token counter workspace, hydrogen-child event is ignored in favor of neon-child-1 / token-idle-tab
  writeEventJson(eventsDir, '20261119_230001.000_neon_sub.json', 1795125604000, 'neon-child-1');
  const childViewedTokenWs = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    mode: 'current',
    conversationId: 'token-idle-tab',
    workspaceUris: ['file:///workspace/Token%20counter/'],
  });
  assert.equal(childViewedTokenWs.id, 'neon-running');
  assert.equal(childViewedTokenWs.resolvedFromChildId, 'neon-child-1');

  // Event pointing to missing/unresolvable ID falls back to static conversationId in current mode
  writeEventJson(eventsDir, '20261119_230100.000_missing.json', 1795125700000, 'nonexistent-id');
  const fallbackTarget = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    mode: 'current',
    conversationId: 'neon-running',
  });
  assert.equal(fallbackTarget.id, 'neon-running');
});

test('discovery: fs_fallback uses gen_metadata for zone and respects readLatestViewedSession in auto mode', (t) => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'tc-fs-genmeta-'));
  t.after(() => {
    closeCachedDbs();
    clearGenMetadataCache();
    rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  writeTranscript(appDataDir, 'fs-neon', [
    { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Neon task' },
    { step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon', input_tokens: 50000, cache_read_tokens: 0 },
  ]);
  writeTranscript(appDataDir, 'fs-hydro', [
    { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Hydro task' },
    { step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 100000, cache_read_tokens: 0 },
  ]);
  writeGenMetadataDb(appDataDir, 'fs-hydro', 'gemini-4-hydrogen-tiered-high');

  const meta = listMainSessionsWithMeta({
    appDataDir,
    locksPath: join(appDataDir, 'missing_locks'),
  });
  assert.equal(meta.discoverySource, 'fs_fallback');
  const hydro = meta.sessions.find((s) => s.id === 'fs-hydro');
  assert.equal(hydro.zone, 'caution');

  writeAnnotationPbtxt(appDataDir, 'fs-hydro', 1795125800000, 1795125800);
  const autoPicked = resolveTargetSession({
    appDataDir,
    locksPath: join(appDataDir, 'missing_locks'),
    mode: 'auto',
  });
  assert.equal(autoPicked.id, 'fs-hydro');
  assert.equal(autoPicked.discoverySource, 'fs_fallback');
});

test('discovery: Windows URI/UNC/drive-root normalization, display casing, findAppDataDir casing, and strict POSIX case-sensitivity', () => {
  // Drive-letter, percent-encoded colon, backslash, and file://localhost/ forms normalize identically
  const expectedWin = '/c:/users/alice/token counter';
  assert.equal(normalizeWorkspaceUri('file:///c%3A/Users/Alice/Token%20counter/'), expectedWin);
  assert.equal(normalizeWorkspaceUri('file:///C:/Users/Alice/Token%20counter'), expectedWin);
  assert.equal(normalizeWorkspaceUri('C:\\Users\\Alice\\Token counter\\'), expectedWin);
  assert.equal(normalizeWorkspaceUri('FILE://LOCALHOST/C:/Users/Alice/Token%20counter/'), expectedWin);

  assert.equal(
    workspaceMatches('["file:///c%3A/Users/Alice/Token%20counter/"]', [
      'C:\\Users\\Alice\\Token counter\\',
    ]),
    true
  );
  assert.equal(
    workspaceMatches('["file://localhost/C:/Users/Alice/Token%20counter"]', [
      'file:///c%3A/users/alice/token%20counter/',
    ]),
    true
  );

  // Drive roots normalize consistently and preserve drive label in workspaceBasename
  assert.equal(normalizeWorkspaceUri('file:///C:/'), '/c:/');
  assert.equal(normalizeWorkspaceUri('C:\\'), '/c:/');
  assert.equal(normalizeWorkspaceUri('c:'), '/c:/');
  assert.equal(workspaceBasename('["file:///C:/"]'), 'C:');
  assert.equal(workspaceBasename('C:\\'), 'C:');

  // UNC shares normalize case-insensitively across file:// and \\server\share forms
  assert.equal(normalizeWorkspaceUri('file://server/Share/Dir/'), '//server/share/dir');
  assert.equal(normalizeWorkspaceUri('\\\\SERVER\\share\\dir'), '//server/share/dir');
  assert.equal(normalizeWorkspaceUri('\\\\SERVER\\Share\\'), '//server/share');
  assert.equal(
    workspaceMatches('["file://server/Share/Dir"]', ['\\\\SERVER\\share\\dir\\']),
    true
  );
  assert.equal(workspaceBasename('["file://server/Share/Dir"]'), 'Dir');
  assert.equal(workspaceBasename('\\\\SERVER\\Share\\'), 'Share');

  // Display labels preserve original casing
  assert.equal(workspaceBasename('["file:///c%3A/Users/Alice/Token%20counter/"]'), 'Token counter');
  assert.equal(workspaceBasename('C:\\Users\\Alice\\MyApp\\'), 'MyApp');

  // POSIX paths remain strictly case-sensitive and preserve literal backslashes and root '/'
  assert.equal(normalizeWorkspaceUri('file:///home/Alice/Repo/'), '/home/Alice/Repo');
  assert.equal(normalizeWorkspaceUri('file:///home/alice/repo/'), '/home/alice/repo');
  assert.equal(
    workspaceMatches('["file:///home/Alice/Repo/"]', ['file:///home/alice/repo/']),
    false
  );
  assert.equal(normalizeWorkspaceUri('file:///'), '/');
  assert.equal(normalizeWorkspaceUri('/home/user/dir\\name/'), '/home/user/dir\\name');

  // findAppDataDir matches Sidecar_Data case-insensitively on win32, strictly on linux
  const winDataDir = join('/tmp', 'app', 'Sidecar_Data', 'token-counter', 'token_counter', 'data');
  assert.equal(
    findAppDataDir({ env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: winDataDir }, platform: 'win32' }),
    join('/tmp', 'app')
  );
  assert.equal(
    findAppDataDir({ env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: winDataDir }, platform: 'linux' }),
    null
  );
});

test('discovery: win32 readActiveLockIds uses non-destructive lock probe and recency fallback', (t) => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'tc-winlocks-'));
  t.after(() => {
    closeCachedDbs();
    rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const presenceDir = join(appDataDir, 'presence');
  mkdirSync(presenceDir, { recursive: true });

  const nowMs = 1_795_200_000_000;
  const staleSec = (nowMs - 300_000) / 1000; // 5m ago (> 2m win32RecencyMs)
  const recentSec = (nowMs - 30_000) / 1000; // 30s ago (<= 2m win32RecencyMs)

  // 1) Locked via EBUSY/EACCES probe even though mtime is stale; contents stay intact
  const probeLockedPath = join(presenceDir, 'conv-probe-ebusy.lock');
  const probeEaccesPath = join(presenceDir, 'conv-probe-eacces.lock');
  writeFileSync(probeLockedPath, 'keep-me', 'utf-8');
  writeFileSync(probeEaccesPath, 'keep-eacces', 'utf-8');
  utimesSync(probeLockedPath, staleSec, staleSec);
  utimesSync(probeEaccesPath, staleSec, staleSec);

  // 2) Unlocked by probe, but recent .lock mtimeMs
  const recentLockPath = join(presenceDir, 'conv-recent-lock.lock');
  writeFileSync(recentLockPath, '', 'utf-8');
  utimesSync(recentLockPath, recentSec, recentSec);

  // 3) Stale .lock mtimeMs, but recent transcript.jsonl mtimeMs
  const recentTrLockPath = join(presenceDir, 'conv-recent-tr.lock');
  writeFileSync(recentTrLockPath, '', 'utf-8');
  utimesSync(recentTrLockPath, staleSec, staleSec);
  writeTranscript(appDataDir, 'conv-recent-tr', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 0 },
  ]);
  const trFile = join(appDataDir, 'brain', 'conv-recent-tr', '.system_generated', 'logs', 'transcript.jsonl');
  utimesSync(trFile, recentSec, recentSec);

  // 4) Stale .lock and stale transcript -> excluded
  const staleLockPath = join(presenceDir, 'conv-stale.lock');
  writeFileSync(staleLockPath, '', 'utf-8');
  utimesSync(staleLockPath, staleSec, staleSec);
  writeTranscript(appDataDir, 'conv-stale', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 0 },
  ]);
  const staleTrFile = join(appDataDir, 'brain', 'conv-stale', '.system_generated', 'logs', 'transcript.jsonl');
  utimesSync(staleTrFile, staleSec, staleSec);

  const probedPaths = [];
  const active = readActiveLockIds({
    appDataDir,
    platform: 'win32',
    nowMs,
    win32RecencyMs: 120_000,
    probeWin32Lock: (lockPath) => {
      probedPaths.push(lockPath);
      if (lockPath.endsWith('conv-probe-ebusy.lock')) {
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
      }
      if (lockPath.endsWith('conv-probe-eacces.lock')) {
        const err = new Error('access denied');
        err.code = 'EACCES';
        throw err;
      }
      return false;
    },
  });

  assert.equal(probedPaths.length, 5);
  assert.equal(active.has('conv-probe-ebusy'), true);
  assert.equal(active.has('conv-probe-eacces'), true);
  assert.equal(active.has('conv-recent-lock'), true);
  assert.equal(active.has('conv-recent-tr'), true);
  assert.equal(active.has('conv-stale'), false);
  assert.equal(readFileSync(probeLockedPath, 'utf-8'), 'keep-me');
  assert.equal(readFileSync(probeEaccesPath, 'utf-8'), 'keep-eacces');

  // Unsupported OS without explicit locksPath safely returns empty Set
  const darwinLocks = readActiveLockIds({ appDataDir, platform: 'darwin', nowMs });
  assert.equal(darwinLocks.size, 0);

  // Explicit locksPath overrides platform and uses FLOCK inode matching
  const mockLocks = join(appDataDir, 'mock_proc_locks');
  const inoRecent = statSync(recentLockPath, { bigint: true }).ino;
  writeFileSync(mockLocks, `1: FLOCK ADVISORY WRITE 999 00:24:${inoRecent} 0 EOF\n`, 'utf-8');
  const explicitLocks = readActiveLockIds({ appDataDir, locksPath: mockLocks, platform: 'win32' });
  assert.deepEqual([...explicitLocks], ['conv-recent-lock']);
});

test('discovery: win32 closes SQLite DB immediately per query so unlink/recreate works without closeCachedDbs()', (t) => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'tc-win-sqlite-'));
  t.after(() => {
    closeCachedDbs();
    rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const dbPath = join(appDataDir, 'conversation_summaries.db');
  const db1 = createMockDb(dbPath);
  db1
    .prepare(
      `INSERT INTO conversation_summaries (
         conversation_id, title, last_modified_time, workspace_uris,
         status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('win-sess-1', 'First DB', '2026-11-19 20:00:00+00:00', '["file:///C:/Repo/"]', 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);
  db1.close();

  assert.equal(getDiscoverySource({ appDataDir, platform: 'win32' }), 'sqlite');
  const firstList = listMainSessionsWithMeta({ appDataDir, platform: 'win32' });
  assert.equal(firstList.discoverySource, 'sqlite');
  assert.deepEqual(
    firstList.sessions.map((s) => s.id),
    ['win-sess-1']
  );
  const firstTarget = resolveTargetSession({ appDataDir, platform: 'win32', mode: 'auto' });
  assert.equal(firstTarget.id, 'win-sess-1');

  // Remove and recreate DB WITHOUT calling closeCachedDbs(); win32 must not hold any open handle
  rmSync(dbPath, { force: true, maxRetries: 5, retryDelay: 50 });
  const db2 = createMockDb(dbPath);
  db2
    .prepare(
      `INSERT INTO conversation_summaries (
         conversation_id, title, last_modified_time, workspace_uris,
         status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('win-sess-2', 'Replaced DB', '2026-11-19 21:00:00+00:00', '["file:///C:/Repo/"]', 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 1, 0);
  db2.close();

  const secondList = listMainSessionsWithMeta({ appDataDir, platform: 'win32' });
  assert.equal(secondList.discoverySource, 'sqlite');
  assert.deepEqual(
    secondList.sessions.map((s) => s.id),
    ['win-sess-2']
  );
  const secondTarget = resolveTargetSession({ appDataDir, platform: 'win32', mode: 'auto' });
  assert.equal(secondTarget.id, 'win-sess-2');
});

test('discovery: readLatestViewedSession scans >5 annotations and preserves nanosecond precision', (t) => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'tc-nanos-many-'));
  t.after(() => {
    closeCachedDbs();
    rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // 10 annotation files: sess-0..sess-8 have newer file mtimes on disk, while sess-9 has older mtime
  // AND a higher last_user_view_time (would be dropped by a top-5 mtime cap).
  const baseSec = 1795130000;
  for (let i = 0; i < 9; i++) {
    writeAnnotationPbtxtNs(appDataDir, `sess-${i}`, baseSec + i, 500_000_000, baseSec + 100 + i);
  }
  writeAnnotationPbtxtNs(appDataDir, 'sess-9', baseSec + 20, 123_456_789, baseSec + 1);

  const manyRes = readLatestViewedSession({ appDataDir });
  assert.deepEqual(manyRes, {
    id: 'sess-9',
    timestampMs: (baseSec + 20) * 1000 + 123,
    source: 'annotations',
  });

  // Sub-millisecond nanosecond precision: sess-ns-hi (123_999_001 ns) beats sess-9 (123_456_789 ns)
  // AND beats an event at the exact same millisecond (123_000_000 ns)
  const eventsDir = join(appDataDir, 'sidecar_data', 'token-counter', 'token_counter', 'events');
  writeEventJson(eventsDir, '20261119_235000.000_same_ms.json', (baseSec + 20) * 1000 + 123, 'sess-0');
  writeAnnotationPbtxtNs(appDataDir, 'sess-ns-hi', baseSec + 20, 123_999_001, baseSec + 2);

  const nsRes = readLatestViewedSession({ appDataDir });
  assert.deepEqual(nsRes, {
    id: 'sess-ns-hi',
    timestampMs: (baseSec + 20) * 1000 + 123,
    source: 'annotations',
  });
});

test('discovery: cross-workspace batch-written identical view times never hijack active workspace and same-ws ties prefer lock/transcript over stale event', (t) => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'tc-batch-ws-'));
  t.after(() => {
    closeCachedDbs();
    rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const wsAlpha = '["file:///ws/alpha/"]';
  const wsBeta = '["file:///ws/beta/"]';
  const db = createMockDb(join(appDataDir, 'conversation_summaries.db'));
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, last_modified_time, workspace_uris,
      status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('alpha-1', 'Alpha 1', '2026-11-19 20:00:00+00:00', wsAlpha, 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);
  insert.run('alpha-2', 'Alpha 2', '2026-11-19 20:01:00+00:00', wsAlpha, 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);
  insert.run('alpha-child', '', '2026-11-19 20:02:00+00:00', '', 'CASCADE_RUN_STATUS_RUNNING', 'worker', 'alpha-1', 1, 1, 0);
  insert.run('beta-1', 'Beta 1', '2026-11-19 20:05:00+00:00', wsBeta, 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 1, 0);
  db.close();

  // Batch-written identical nanosecond timestamp across workspaces; beta-1 even has newer mtime, lock, and newer event
  const sec = 1795140000;
  const nanos = 777_888_999;
  const eventsDir = join(appDataDir, 'sidecar_data', 'token-counter', 'token_counter', 'events');
  writeAnnotationPbtxtNs(appDataDir, 'alpha-1', sec, nanos, sec + 1);
  writeAnnotationPbtxtNs(appDataDir, 'alpha-2', sec, nanos, sec + 2);
  writeAnnotationPbtxtNs(appDataDir, 'beta-1', sec, nanos, sec + 99);
  writeEventJson(eventsDir, '20261119_235500.000_beta.json', (sec + 60) * 1000, 'beta-1');
  writeEventJson(eventsDir, '20261119_235400.000_alpha2.json', sec * 1000 + 777, 'alpha-2');

  // 1) alpha-1 has active lock -> beats alpha-2 (even though alpha-2 matches event and has newer pbtxt mtime) and ignores beta-1
  const lockWins = readLatestViewedSession({
    appDataDir,
    workspaceUris: ['file:///ws/alpha/'],
    activeLocks: new Set(['alpha-1', 'beta-1']),
  });
  assert.deepEqual(lockWins, {
    id: 'alpha-1',
    timestampMs: sec * 1000 + 777,
    source: 'annotations',
  });

  // 2) Without locks, freshest transcript mtime (alpha-1) beats alpha-2 (stale event match + newer pbtxt mtime)
  writeTranscript(appDataDir, 'alpha-1', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 0 },
  ]);
  writeTranscript(appDataDir, 'alpha-2', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 0 },
  ]);
  utimesSync(
    join(appDataDir, 'brain', 'alpha-1', '.system_generated', 'logs', 'transcript.jsonl'),
    sec + 50,
    sec + 50
  );
  utimesSync(
    join(appDataDir, 'brain', 'alpha-2', '.system_generated', 'logs', 'transcript.jsonl'),
    sec + 10,
    sec + 10
  );

  const transcriptWins = readLatestViewedSession({
    appDataDir,
    workspaceUris: ['file:///ws/alpha/'],
    activeLocks: new Set(['beta-1']),
  });
  assert.deepEqual(transcriptWins, {
    id: 'alpha-1',
    timestampMs: sec * 1000 + 777,
    source: 'annotations',
  });

  // 3) Child event in alpha inherits parent workspace and wins over older alpha annotations when strictly newer
  writeEventJson(eventsDir, '20261119_235600.000_alpha_child.json', (sec + 10) * 1000, 'alpha-child');
  const childEventWins = readLatestViewedSession({
    appDataDir,
    workspaceUris: ['file:///ws/alpha/'],
    activeLocks: new Set(['beta-1']),
  });
  assert.deepEqual(childEventWins, {
    id: 'alpha-child',
    timestampMs: (sec + 10) * 1000,
    source: 'events',
  });
});

test('discovery: auto mode scoring balance and fs_fallback active lock precedence', (t) => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'tc-auto-balance-'));
  t.after(() => {
    closeCachedDbs();
    rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const ws = '["file:///ws/work/"]';
  const db = createMockDb(join(appDataDir, 'conversation_summaries.db'));
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, last_modified_time, workspace_uris,
      status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('run-1', 'Run 1', '2026-11-19 20:00:00+00:00', ws, 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 0, 0);
  insert.run('run-2', 'Run 2', '2026-11-19 20:01:00+00:00', ws, 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 0, 0);
  insert.run('idle-viewed', 'Idle Viewed', '2026-11-19 20:02:00+00:00', ws, 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);
  db.close();

  mkdirSync(join(appDataDir, 'presence'), { recursive: true });
  const lock1 = join(appDataDir, 'presence', 'run-1.lock');
  const lock2 = join(appDataDir, 'presence', 'run-2.lock');
  writeFileSync(lock1, '', 'utf-8');
  writeFileSync(lock2, '', 'utf-8');
  const mockLocks = join(appDataDir, 'mock_proc_locks');
  writeFileSync(
    mockLocks,
    `1: FLOCK ADVISORY WRITE 100 00:24:${statSync(lock1).ino} 0 EOF\n` +
      `2: FLOCK ADVISORY WRITE 101 00:24:${statSync(lock2).ino} 0 EOF\n`,
    'utf-8'
  );

  // Viewed idle session does NOT beat running+locked sessions
  writeAnnotationPbtxt(appDataDir, 'idle-viewed', 1795150000000, 1795150000);
  const pickRunning = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    mode: 'auto',
    workspaceUris: ['file:///ws/work/'],
  });
  assert.ok(pickRunning.id === 'run-1' || pickRunning.id === 'run-2');

  // Among two equally running+locked sessions, viewed tie-breaker picks run-1
  writeAnnotationPbtxt(appDataDir, 'run-1', 1795150010000, 1795150010);
  const pickViewedRunning = resolveTargetSession({
    appDataDir,
    locksPath: mockLocks,
    mode: 'auto',
    workspaceUris: ['file:///ws/work/'],
  });
  assert.equal(pickViewedRunning.id, 'run-1');

  // fs_fallback in auto mode prefers active lock over un-locked viewed session
  const fsDir = join(appDataDir, 'fs-only');
  mkdirSync(join(fsDir, 'presence'), { recursive: true });
  writeTranscript(fsDir, 'fs-locked', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 0 },
  ]);
  writeTranscript(fsDir, 'fs-viewed', [
    { step_index: 0, type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 0 },
  ]);
  const fsLock = join(fsDir, 'presence', 'fs-locked.lock');
  writeFileSync(fsLock, '', 'utf-8');
  const fsMockLocks = join(fsDir, 'mock_proc_locks');
  writeFileSync(fsMockLocks, `1: FLOCK ADVISORY WRITE 200 00:24:${statSync(fsLock).ino} 0 EOF\n`, 'utf-8');
  writeAnnotationPbtxt(fsDir, 'fs-viewed', 1795150020000, 1795150020);

  const fsAuto = resolveTargetSession({
    appDataDir: fsDir,
    locksPath: fsMockLocks,
    mode: 'auto',
  });
  assert.equal(fsAuto.id, 'fs-locked');
  assert.equal(fsAuto.discoverySource, 'fs_fallback');
});
