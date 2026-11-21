import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createServerApp } from '../sidecars/token_counter/main.mjs';

function setupEnv() {
  const root = mkdtempSync(join(tmpdir(), 'tc-server-'));

  const appDataDir = join(root, 'appdata');
  const dataDir = join(appDataDir, 'sidecar_data', 'token-counter', 'token_counter', 'data');
  const uiDir = join(root, 'ui');
  mkdirSync(join(appDataDir, 'brain', 'main-1', '.system_generated', 'logs'), { recursive: true });
  mkdirSync(join(appDataDir, 'brain', 'main-2', '.system_generated', 'logs'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(uiDir, { recursive: true });

  const db = new DatabaseSync(join(appDataDir, 'conversation_summaries.db'));
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
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, last_modified_time, workspace_uris,
      status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'main-1',
    'Primary Session',
    '2026-11-19 20:00:00+00:00',
    '["file:///workspace/Token%20counter/"]',
    'CASCADE_RUN_STATUS_RUNNING',
    '',
    '',
    0,
    1,
    0
  );
  insert.run(
    'main-2',
    'Secondary Workspace Session',
    '2026-11-19 19:50:00+00:00',
    '["file:///tmp/secondary/"]',
    'CASCADE_RUN_STATUS_IDLE',
    '',
    '',
    0,
    0,
    0
  );
  insert.run(
    'child-1',
    '',
    '2026-11-19 20:01:00+00:00',
    '',
    'CASCADE_RUN_STATUS_RUNNING',
    'subagent',
    'main-1',
    1,
    1,
    0
  );
  db.close();

  const trPath = join(appDataDir, 'brain', 'main-1', '.system_generated', 'logs', 'transcript.jsonl');
  writeFileSync(
    trPath,
    JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-hydrogen-high',
      input_tokens: 20000,
      cache_read_tokens: 115000,
      output_tokens: 400,
      created_at: '2026-11-19T20:00:05Z',
    }) + '\n',
    'utf-8'
  );

  const trPath2 = join(appDataDir, 'brain', 'main-2', '.system_generated', 'logs', 'transcript.jsonl');
  writeFileSync(
    trPath2,
    JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-carbon-high',
      input_tokens: 50000,
      cache_read_tokens: 0,
      output_tokens: 200,
      created_at: '2026-11-19T19:50:05Z',
    }) + '\n',
    'utf-8'
  );

  return { root, appDataDir, dataDir, uiDir, trPath };
}

test('server: serves UI/API, model-aware thresholds, workspaceUris, pinned settings, and ETags', async (t) => {
  const { root, appDataDir, dataDir, uiDir, trPath } = setupEnv();
  let app = null;
  t.after(async () => {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const prevEnv = {
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
    ANTIGRAVITY_SIDECAR_WEB_PORT: process.env.ANTIGRAVITY_SIDECAR_WEB_PORT,
    ANTIGRAVITY_SIDECAR_UI_TOKEN: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-test';
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-token';
  process.env.ANTIGRAVITY_CONVERSATION_ID = 'main-1';
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = dataDir;

  app = createServerApp({
    appDataDir,
    dataDir,
    uiDir,
    locksPath: join(appDataDir, 'missing_locks'),
  });
  const server = await app.run();

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Missing UI assets handled gracefully (404, no crash)
  const missingHtml = await fetch(`${baseUrl}/`);
  assert.equal(missingHtml.status, 404);

  // Create UI assets and verify Content-Type
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><html></html>', 'utf-8');
  writeFileSync(join(uiDir, 'styles.css'), 'body { color: #fff; }', 'utf-8');
  writeFileSync(join(uiDir, 'app.js'), 'console.log("ok");', 'utf-8');

  const htmlRes = await fetch(`${baseUrl}/`);
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get('content-type'), /^text\/html/);

  const cssRes = await fetch(`${baseUrl}/styles.css`);
  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers.get('content-type'), /^text\/css/);

  const jsRes = await fetch(`${baseUrl}/app.js`);
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers.get('content-type'), /^application\/javascript/);

  const preloadRes = await fetch(`${baseUrl}/preload.js`);
  assert.equal(preloadRes.status, 200);

  // GET /api/metrics returns full payload with model-aware Hydrogen thresholds (135K > 130K dumb)
  const m1Res = await fetch(`${baseUrl}/api/metrics?conversationId=main-1&mode=current`);
  assert.equal(m1Res.status, 200);
  const m1 = await m1Res.json();
  assert.equal(m1.unchanged, false);
  assert.equal(m1.session.id, 'main-1');
  assert.equal(m1.session.discoverySource, 'sqlite');
  assert.equal(m1.session.activeChildCount, 1);
  assert.equal(m1.effectiveThresholds.profileId, 'hydrogen');
  assert.equal(m1.effectiveThresholds.source, 'model');
  assert.equal(m1.metrics.contextTokens, 135000);
  assert.equal(m1.metrics.zone, 'dumb');
  assert.equal(m1.metrics.headroomToDumbZone, -5000);
  assert.equal(m1.metrics.overLimitBy, 5000);
  assert.equal(m1.series.length, 1);

  // Matching ETag returns unchanged: true
  const m2Res = await fetch(
    `${baseUrl}/api/metrics?conversationId=main-1&mode=current&etag=${encodeURIComponent(m1.etag)}`
  );
  const m2 = await m2Res.json();
  assert.deepEqual(m2, { unchanged: true, etag: m1.etag });

  // Child conversationId resolves to root main session
  const childRes = await fetch(`${baseUrl}/api/metrics?conversationId=child-1&mode=current`);
  const childMetrics = await childRes.json();
  assert.equal(childMetrics.session.id, 'main-1');
  assert.equal(childMetrics.session.resolvedFromChildId, 'child-1');

  // Appending to transcript with gemini-4-carbon-high (160K/220K) switches effective zone automatically from dumb to safe
  appendFileSync(
    trPath,
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-carbon-high',
      input_tokens: 5000,
      cache_read_tokens: 135000,
      output_tokens: 500,
      created_at: '2026-11-19T20:00:25Z',
    }) + '\n',
    'utf-8'
  );
  const m3Res = await fetch(
    `${baseUrl}/api/metrics?conversationId=main-1&mode=current&etag=${encodeURIComponent(m1.etag)}`
  );
  const m3 = await m3Res.json();
  assert.equal(m3.unchanged, false);
  assert.notEqual(m3.etag, m1.etag);
  assert.equal(m3.metrics.contextTokens, 140000);
  assert.equal(m3.metrics.delta, 5000);
  assert.equal(m3.effectiveThresholds.profileId, 'carbon');
  assert.equal(m3.metrics.zone, 'safe');
  assert.equal(m3.metrics.headroomToDumbZone, 80000);
  assert.equal(m3.metrics.overLimitBy, 0);

  // GET /api/sessions excludes child-1, returns discoverySource, and prioritizes workspaceUris array
  const sessRes = await fetch(
    `${baseUrl}/api/sessions?workspaceUris=${encodeURIComponent(JSON.stringify(['file:///tmp/secondary/']))}`
  );
  const sessJson = await sessRes.json();
  assert.equal(sessJson.discoverySource, 'sqlite');
  assert.deepEqual(
    sessJson.sessions.map((s) => s.id),
    ['main-2', 'main-1']
  );

  // GET /api/settings returns settings, modelProfiles, and defaultProfile
  const getSetRes = await fetch(`${baseUrl}/api/settings`);
  assert.equal(getSetRes.status, 200);
  const getSetJson = await getSetRes.json();
  assert.equal(getSetJson.settings.thresholdMode, 'auto');
  assert.equal(getSetJson.settings.dumbZoneThreshold, 175000);
  assert.equal(getSetJson.modelProfiles.length, 6);
  assert.equal(getSetJson.defaultProfile.dumbZoneThreshold, 175000);

  // POST /api/settings without token -> 401
  const unauthRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cautionThreshold: 60000, dumbZoneThreshold: 80000 }),
  });
  assert.equal(unauthRes.status, 401);

  // POST /api/settings with token and invalid thresholds -> 400
  const invalidRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': 'secret-token',
    },
    body: JSON.stringify({ cautionThreshold: 90000, dumbZoneThreshold: 80000 }),
  });
  assert.equal(invalidRes.status, 400);
  const invalidJson = await invalidRes.json();
  assert.ok(invalidJson.error);

  // POST /api/settings with manual override + pinned trackingMode -> 200 and updates ETag + zone in /api/metrics
  const updateRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': 'secret-token',
    },
    body: JSON.stringify({
      thresholdMode: 'manual',
      cautionThreshold: 50000,
      dumbZoneThreshold: 120000,
      gaugeCeiling: 200000,
      trackingMode: 'pinned',
      pinnedSessionId: 'main-1',
    }),
  });
  assert.equal(updateRes.status, 200);
  const updateJson = await updateRes.json();
  assert.equal(updateJson.settings.thresholdMode, 'manual');
  assert.equal(updateJson.settings.trackingMode, 'pinned');
  assert.equal(updateJson.settings.pinnedSessionId, 'main-1');
  assert.equal(updateJson.modelProfiles.length, 6);
  assert.ok(updateJson.defaultProfile);

  // /api/metrics without explicit conversationId uses persisted pinnedSessionId and manual thresholds
  const m4Res = await fetch(
    `${baseUrl}/api/metrics?etag=${encodeURIComponent(m3.etag)}`
  );
  const m4 = await m4Res.json();
  assert.equal(m4.unchanged, false);
  assert.notEqual(m4.etag, m3.etag);
  assert.equal(m4.session.id, 'main-1');
  assert.equal(m4.effectiveThresholds.source, 'manual');
  assert.equal(m4.metrics.zone, 'dumb');
  assert.equal(m4.metrics.headroomToDumbZone, -20000);
  assert.equal(m4.metrics.overLimitBy, 20000);
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
  return Buffer.concat([
    encodeVarint((fieldNum << 3) | 2),
    encodeVarint(payloadBuf.length),
    payloadBuf,
  ]);
}

function writeGenMetadata(appDataDir, convId, modelId) {
  const convDir = join(appDataDir, 'conversations');
  mkdirSync(convDir, { recursive: true });
  const dbPath = join(convDir, `${convId}.db`);
  const db = new DatabaseSync(dbPath);
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
  return dbPath;
}

test('server: Tier 2 gen_metadata fallback, ETag invalidation on DB update, and tab-switch tracking in current mode', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tc-server-tier2-'));
  let app = null;
  t.after(async () => {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const appDataDir = join(root, 'appdata');
  const dataDir = join(appDataDir, 'sidecar_data', 'token-counter', 'token_counter', 'data');
  const uiDir = join(root, 'ui');
  mkdirSync(join(appDataDir, 'brain', 'sess-hydro', '.system_generated', 'logs'), { recursive: true });
  mkdirSync(join(appDataDir, 'brain', 'sess-neon', '.system_generated', 'logs'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(uiDir, { recursive: true });

  const prevEnv = {
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
    ANTIGRAVITY_SIDECAR_WEB_PORT: process.env.ANTIGRAVITY_SIDECAR_WEB_PORT,
    ANTIGRAVITY_SIDECAR_UI_TOKEN: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-test';
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-token';
  process.env.ANTIGRAVITY_CONVERSATION_ID = 'sess-neon';
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = dataDir;

  const db = new DatabaseSync(join(appDataDir, 'conversation_summaries.db'));
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
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, last_modified_time, workspace_uris,
      status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('sess-neon', 'Neon Session', '2026-11-19 20:10:00+00:00', '', 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 1, 0);
  insert.run('sess-hydro', 'Hydrogen Session', '2026-11-19 19:00:00+00:00', '', 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);
  db.close();

  writeFileSync(
    join(appDataDir, 'brain', 'sess-neon', '.system_generated', 'logs', 'transcript.jsonl'),
    JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-pro-orchestrator-neon',
      input_tokens: 50000,
      cache_read_tokens: 0,
    }) + '\n',
    'utf-8'
  );
  // Hydrogen transcript has NO model field -> falls back to gen_metadata
  writeFileSync(
    join(appDataDir, 'brain', 'sess-hydro', '.system_generated', 'logs', 'transcript.jsonl'),
    JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      input_tokens: 100000,
      cache_read_tokens: 0,
    }) + '\n',
    'utf-8'
  );
  const convDbPath = writeGenMetadata(appDataDir, 'sess-hydro', 'gemini-4-hydrogen-tiered-high');

  app = createServerApp({
    appDataDir,
    dataDir,
    uiDir,
    locksPath: join(appDataDir, 'missing_locks'),
  });
  const server = await app.run();

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Tier 2 gen_metadata model detection on sess-hydro
  const r1 = await fetch(`${baseUrl}/api/metrics?conversationId=sess-hydro&mode=current`);
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.session.id, 'sess-hydro');
  assert.equal(j1.metrics.model, 'gemini-4-hydrogen-tiered-high');
  assert.equal(j1.metrics.modelSource, 'gen_metadata');
  assert.equal(j1.effectiveThresholds.profileId, 'hydrogen');
  assert.equal(j1.effectiveThresholds.source, 'model');
  assert.equal(j1.metrics.zone, 'caution');

  // Updating conversations/sess-hydro.db invalidates ETag even without touching transcript.jsonl
  writeGenMetadata(appDataDir, 'sess-hydro', 'gemini-4-carbon-high');
  const bumpTime = Date.now() / 1000 + 2;
  utimesSync(convDbPath, bumpTime, bumpTime);

  const r2 = await fetch(
    `${baseUrl}/api/metrics?conversationId=sess-hydro&mode=current&etag=${encodeURIComponent(j1.etag)}`
  );
  assert.equal(r2.status, 200);
  const j2 = await r2.json();
  assert.equal(j2.unchanged, false);
  assert.notEqual(j2.etag, j1.etag);
  assert.equal(j2.metrics.model, 'gemini-4-carbon-high');
  assert.equal(j2.effectiveThresholds.profileId, 'carbon');
  assert.equal(j2.metrics.zone, 'safe');

  // Tab switch via annotations/*.pbtxt overrides static iframe conversationId=sess-neon in current mode
  mkdirSync(join(appDataDir, 'annotations'), { recursive: true });
  writeFileSync(
    join(appDataDir, 'annotations', 'sess-hydro.pbtxt'),
    'last_user_view_time:{seconds:1795125600 nanos:0}',
    'utf-8'
  );
  const r3 = await fetch(`${baseUrl}/api/metrics?conversationId=sess-neon&mode=current`);
  assert.equal(r3.status, 200);
  const j3 = await r3.json();
  assert.equal(j3.session.id, 'sess-hydro');
});

test('server: /api/sessions matches Windows-style workspaceUris across drive-letter casing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tc-server-winws-'));
  let app = null;
  t.after(async () => {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const appDataDir = join(root, 'appdata');
  const dataDir = join(appDataDir, 'sidecar_data', 'token-counter', 'token_counter', 'data');
  const uiDir = join(root, 'ui');
  mkdirSync(join(appDataDir, 'brain', 'win-older', '.system_generated', 'logs'), { recursive: true });
  mkdirSync(join(appDataDir, 'brain', 'win-newer', '.system_generated', 'logs'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(uiDir, { recursive: true });

  const prevEnv = {
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
    ANTIGRAVITY_SIDECAR_WEB_PORT: process.env.ANTIGRAVITY_SIDECAR_WEB_PORT,
    ANTIGRAVITY_SIDECAR_UI_TOKEN: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-test';
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-token';
  process.env.ANTIGRAVITY_CONVERSATION_ID = 'win-newer';
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = dataDir;

  const db = new DatabaseSync(join(appDataDir, 'conversation_summaries.db'));
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
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, last_modified_time, workspace_uris,
      status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'win-older',
    'Windows Workspace Older',
    '2026-11-19 19:00:00+00:00',
    '["file:///c%3A/Users/Alice/Token%20counter/"]',
    'CASCADE_RUN_STATUS_IDLE',
    '',
    '',
    0,
    0,
    0
  );
  insert.run(
    'win-newer',
    'Other Drive Newer',
    '2026-11-19 20:00:00+00:00',
    '["file:///D:/Other/Project/"]',
    'CASCADE_RUN_STATUS_IDLE',
    '',
    '',
    0,
    0,
    0
  );
  db.close();

  app = createServerApp({
    appDataDir,
    dataDir,
    uiDir,
    platform: 'win32',
  });
  const server = await app.run();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const sessRes = await fetch(
    `${baseUrl}/api/sessions?workspaceUris=${encodeURIComponent(JSON.stringify(['file:///C:/Users/Alice/Token%20counter']))}`
  );
  assert.equal(sessRes.status, 200);
  const sessJson = await sessRes.json();
  assert.equal(sessJson.discoverySource, 'sqlite');
  assert.deepEqual(
    sessJson.sessions.map((s) => s.id),
    ['win-older', 'win-newer']
  );
  assert.equal(sessJson.sessions[0].workspace, 'Token counter');
});

test('server: GET /api/watch live push triggers immediate session switch on annotations write', async (t) => {
  const { root, appDataDir, dataDir, uiDir } = setupEnv();
  const annotationsDir = join(appDataDir, 'annotations');
  mkdirSync(annotationsDir, { recursive: true });
  writeFileSync(
    join(annotationsDir, 'main-1.pbtxt'),
    'last_user_view_time:{seconds:1795125500 nanos:0}\n',
    'utf-8'
  );

  let app = null;
  t.after(async () => {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const prevEnv = {
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
    ANTIGRAVITY_SIDECAR_WEB_PORT: process.env.ANTIGRAVITY_SIDECAR_WEB_PORT,
    ANTIGRAVITY_SIDECAR_UI_TOKEN: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-test';
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-token';
  process.env.ANTIGRAVITY_CONVERSATION_ID = 'main-1';
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = dataDir;

  app = createServerApp({
    appDataDir,
    dataDir,
    uiDir,
    locksPath: join(appDataDir, 'missing_locks'),
  });
  const server = await app.run();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const startedAt = Date.now();
  const watchPromise = fetch(`${baseUrl}/api/watch?since=0&timeoutMs=5000`);

  setTimeout(() => {
    writeFileSync(
      join(annotationsDir, 'main-2.pbtxt'),
      'last_user_view_time:{seconds:1795125600 nanos:0}\n',
      'utf-8'
    );
  }, 50);

  const watchRes = await watchPromise;
  const elapsedMs = Date.now() - startedAt;
  assert.equal(watchRes.status, 200);
  const watchJson = await watchRes.json();
  assert.equal(watchJson.changed, true);
  assert.ok(watchJson.revision >= 1, `expected revision >= 1, got ${watchJson.revision}`);
  assert.equal(watchJson.watching, true);
  assert.ok(elapsedMs < 2500, `expected watch to resolve well before 5000ms, took ${elapsedMs}ms`);

  const metricsRes = await fetch(`${baseUrl}/api/metrics?mode=current`);
  assert.equal(metricsRes.status, 200);
  const metricsJson = await metricsRes.json();
  assert.equal(metricsJson.session.id, 'main-2');
});

test('server: GET /api/watch catch-up, timeout, and non-hanging app.close()', async (t) => {
  const { root, appDataDir, dataDir, uiDir } = setupEnv();
  const annotationsDir = join(appDataDir, 'annotations');
  mkdirSync(annotationsDir, { recursive: true });

  let app = null;
  t.after(async () => {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const prevEnv = {
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
    ANTIGRAVITY_SIDECAR_WEB_PORT: process.env.ANTIGRAVITY_SIDECAR_WEB_PORT,
    ANTIGRAVITY_SIDECAR_UI_TOKEN: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-test';
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-token';
  process.env.ANTIGRAVITY_CONVERSATION_ID = 'main-1';
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = dataDir;

  app = createServerApp({
    appDataDir,
    dataDir,
    uiDir,
    locksPath: join(appDataDir, 'missing_locks'),
  });
  const server = await app.run();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Trigger a change first so revision >= 1
  const firstWatch = fetch(`${baseUrl}/api/watch?since=0&timeoutMs=3000`);
  setTimeout(() => {
    writeFileSync(join(annotationsDir, 'main-1.pbtxt'), 'step: 1\n', 'utf-8');
  }, 30);
  const firstJson = await (await firstWatch).json();
  assert.equal(firstJson.changed, true);
  assert.ok(firstJson.revision >= 1);

  // Immediate catch-up when since < revision
  const catchupRes = await fetch(`${baseUrl}/api/watch?since=0&timeoutMs=3000`);
  const catchupJson = await catchupRes.json();
  assert.equal(catchupJson.changed, true);
  assert.equal(catchupJson.revision, firstJson.revision);
  assert.equal(catchupJson.watching, true);

  // Timeout with no changes returns changed: false, watching: true
  const timeoutRes = await fetch(
    `${baseUrl}/api/watch?since=${firstJson.revision}&timeoutMs=100`
  );
  const timeoutJson = await timeoutRes.json();
  assert.equal(timeoutJson.changed, false);
  assert.equal(timeoutJson.watching, true);

  // Long watch unblocks promptly when app.close() is called
  const longWatchPromise = fetch(
    `${baseUrl}/api/watch?since=${firstJson.revision}&timeoutMs=20000`
  );
  await new Promise((r) => setTimeout(r, 40));

  const closeStart = Date.now();
  await app.close();
  app = null;
  const closeElapsed = Date.now() - closeStart;
  assert.ok(closeElapsed < 2000, `expected app.close() not to hang, took ${closeElapsed}ms`);

  const longWatchRes = await longWatchPromise;
  const longWatchJson = await longWatchRes.json();
  assert.equal(longWatchJson.changed, false);
  assert.equal(longWatchJson.watching, false);
  assert.equal(longWatchJson.closed, true);
});

test('server: end-to-end Orchestrator Neon + gemini-flash-worker-agy via /api/metrics', async (t) => {
  const { root, appDataDir, dataDir, uiDir, trPath } = setupEnv();
  writeFileSync(
    trPath,
    [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_SETTINGS_CHANGE>\nModel: Orchestrator (Neon)\n</USER_SETTINGS_CHANGE>',
        created_at: '2026-11-19T20:00:00Z',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-pro-orchestrator-neon',
        input_tokens: 49298,
        cache_read_tokens: 100000,
        output_tokens: 500,
        created_at: '2026-11-19T20:00:05Z',
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-flash-worker-agy',
        input_tokens: 17085,
        cache_read_tokens: 100000,
        output_tokens: 300,
        created_at: '2026-11-19T20:00:10Z',
      }),
    ].join('\n') + '\n',
    'utf-8'
  );

  let app = null;
  t.after(async () => {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const prevEnv = {
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
    ANTIGRAVITY_SIDECAR_WEB_PORT: process.env.ANTIGRAVITY_SIDECAR_WEB_PORT,
    ANTIGRAVITY_SIDECAR_UI_TOKEN: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-test';
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-token';
  process.env.ANTIGRAVITY_CONVERSATION_ID = 'main-1';
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = dataDir;

  app = createServerApp({
    appDataDir,
    dataDir,
    uiDir,
    locksPath: join(appDataDir, 'missing_locks'),
  });
  const server = await app.run();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${baseUrl}/api/metrics?conversationId=main-1&mode=current`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.effectiveThresholds.profileId, 'orchestrator-neon');
  assert.equal(json.effectiveThresholds.source, 'model');
  assert.equal(json.metrics.contextTokens, 117085);
  assert.notEqual(json.metrics.model, 'gemini-flash-worker-agy');
});

test('server: orchestrator telemetry /api/metrics, ETag invalidation, /api/watch, and staleness fallback', async (t) => {
  const { root, appDataDir, dataDir, uiDir } = setupEnv();
  let app = null;
  t.after(async () => {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const prevEnv = {
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
    ANTIGRAVITY_SIDECAR_WEB_PORT: process.env.ANTIGRAVITY_SIDECAR_WEB_PORT,
    ANTIGRAVITY_SIDECAR_UI_TOKEN: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-test';
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-token';
  process.env.ANTIGRAVITY_CONVERSATION_ID = 'main-1';
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = dataDir;

  let fakeNowMs = Date.parse('2026-11-21T12:00:00.000Z');
  app = createServerApp({
    appDataDir,
    dataDir,
    uiDir,
    locksPath: join(appDataDir, 'missing_locks'),
    now: () => fakeNowMs,
  });
  const server = await app.run();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 1. No telemetry file -> orchestrator: null
  const r1 = await fetch(`${baseUrl}/api/metrics?conversationId=main-1&mode=current`);
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.orchestrator, null);
  assert.ok(j1.etag);

  // 2. Write valid telemetry -> ETag invalidates (unchanged: false) and returns orchestrator object
  const otelDir = join(appDataDir, 'sidecar_data', 'token-counter', 'orchestrator_telemetry');
  mkdirSync(otelDir, { recursive: true });
  const otelPath = join(otelDir, 'main-1.json');

  const initialOtel = {
    schema_version: 1,
    conversation_id: 'main-1',
    timestamp: '2026-11-21T11:59:50.000Z',
    active_tokens: 45000,
    source: 'transcript_usage',
    zone: 'green',
    fork_eligible: true,
    compact_recommended: false,
    thresholds: { fork_max: 60000, yellow: 60000, red: 110000, hard: 160000 },
  };
  writeFileSync(otelPath, JSON.stringify(initialOtel), 'utf-8');

  const r2 = await fetch(
    `${baseUrl}/api/metrics?conversationId=main-1&mode=current&etag=${encodeURIComponent(j1.etag)}`
  );
  const j2 = await r2.json();
  assert.equal(j2.unchanged, false);
  assert.notEqual(j2.etag, j1.etag);
  assert.equal(j2.orchestrator.zone, 'green');
  assert.equal(j2.orchestrator.active_tokens, 45000);
  assert.equal(j2.orchestrator.fork_eligible, true);
  assert.equal(j2.orchestrator.compact_recommended, false);
  assert.deepEqual(j2.orchestrator.thresholds, initialOtel.thresholds);
  assert.equal(j2.orchestrator.source, 'transcript_usage');
  assert.equal(j2.orchestrator.ageMs, 10_000);

  // 3. /api/watch wakes up promptly when telemetry file is updated
  const wInitRes = await fetch(`${baseUrl}/api/watch?since=0&timeoutMs=1000`);
  const wInit = await wInitRes.json();
  const watchPromise = fetch(`${baseUrl}/api/watch?since=${wInit.revision}&timeoutMs=5000`);
  await new Promise((r) => setTimeout(r, 40));

  fakeNowMs = Date.parse('2026-11-21T12:00:05.000Z');
  const updatedOtel = {
    ...initialOtel,
    timestamp: '2026-11-21T12:00:05.000Z',
    active_tokens: 165000,
    zone: 'hard',
    fork_eligible: false,
    compact_recommended: true,
  };
  writeFileSync(otelPath, JSON.stringify(updatedOtel), 'utf-8');

  const watchRes = await watchPromise;
  const watchJson = await watchRes.json();
  assert.equal(watchJson.changed, true);
  assert.ok(watchJson.revision > wInit.revision);

  const r3 = await fetch(
    `${baseUrl}/api/metrics?conversationId=main-1&mode=current&etag=${encodeURIComponent(j2.etag)}`
  );
  const j3 = await r3.json();
  assert.equal(j3.unchanged, false);
  assert.notEqual(j3.etag, j2.etag);
  assert.equal(j3.orchestrator.zone, 'hard');
  assert.equal(j3.orchestrator.active_tokens, 165000);
  assert.equal(j3.orchestrator.compact_recommended, true);

  // 4. Stale telemetry (> 10 min old) falls back to orchestrator: null
  fakeNowMs = Date.parse('2026-11-21T12:15:00.000Z');
  const r4 = await fetch(
    `${baseUrl}/api/metrics?conversationId=main-1&mode=current&etag=${encodeURIComponent(j3.etag)}`
  );
  const j4 = await r4.json();
  assert.equal(j4.unchanged, false);
  assert.equal(j4.orchestrator, null);
});

test('server: derived_transcript fallback when Orchestrator plugin is enabled (0-tool, stale, post-compact, and disabled)', async (t) => {
  const { root, appDataDir, dataDir, uiDir, trPath } = setupEnv();
  let app = null;
  t.after(async () => {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const prevEnv = {
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
    ANTIGRAVITY_SIDECAR_WEB_PORT: process.env.ANTIGRAVITY_SIDECAR_WEB_PORT,
    ANTIGRAVITY_SIDECAR_UI_TOKEN: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-test';
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-token';
  process.env.ANTIGRAVITY_CONVERSATION_ID = 'main-1';
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = dataDir;

  // Enable Orchestrator plugin next to appDataDir
  const configDir = join(root, 'config');
  mkdirSync(join(configDir, 'plugins', 'orchestrator'), { recursive: true });
  writeFileSync(
    join(configDir, 'plugins', 'orchestrator', 'plugin.json'),
    JSON.stringify({ name: 'orchestrator' }),
    'utf-8'
  );

  const t0Ms = Date.parse('2026-11-21T12:00:00.000Z');
  let fakeNowMs = t0Ms + 1000;
  utimesSync(trPath, new Date(t0Ms - 5000), new Date(t0Ms - 5000));

  app = createServerApp({
    appDataDir,
    dataDir,
    uiDir,
    locksPath: join(appDataDir, 'missing_locks'),
    now: () => fakeNowMs,
  });
  const server = await app.run();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 1. Enabled plugin + 0-tool conversation (no telemetry file) -> derived_transcript with live contextTokens (135000)
  const r1 = await fetch(`${baseUrl}/api/metrics?conversationId=main-1&mode=current`);
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.ok(j1.orchestrator);
  assert.equal(j1.orchestrator.source, 'derived_transcript');
  assert.equal(j1.orchestrator.active_tokens, 135000);
  assert.equal(j1.orchestrator.zone, 'red');
  assert.equal(j1.orchestrator.fork_eligible, false);
  assert.equal(j1.orchestrator.compact_recommended, true);
  assert.deepEqual(j1.orchestrator.thresholds, {
    fork_max: 60_000,
    yellow: 64_000,
    red: 120_000,
    hard: 160_000,
  });

  // 2. Enabled plugin + stale telemetry (> 10 min) -> derived_transcript preserving custom thresholds
  const otelDir = join(appDataDir, 'sidecar_data', 'token-counter', 'orchestrator_telemetry');
  mkdirSync(otelDir, { recursive: true });
  const otelPath = join(otelDir, 'main-1.json');
  const customThresholds = { fork_max: 50_000, yellow: 70_000, red: 130_000, hard: 180_000 };
  writeFileSync(
    otelPath,
    JSON.stringify({
      schema_version: 1,
      conversation_id: 'main-1',
      timestamp: new Date(t0Ms - 15 * 60 * 1000).toISOString(),
      active_tokens: 170_000,
      source: 'transcript_usage',
      zone: 'red',
      fork_eligible: false,
      compact_recommended: true,
      thresholds: customThresholds,
    }),
    'utf-8'
  );

  const r2 = await fetch(`${baseUrl}/api/metrics?conversationId=main-1&mode=current`);
  const j2 = await r2.json();
  assert.equal(j2.orchestrator.source, 'derived_transcript');
  assert.equal(j2.orchestrator.active_tokens, 135000);
  assert.equal(j2.orchestrator.zone, 'red');
  assert.deepEqual(j2.orchestrator.thresholds, customThresholds);

  // 3. Enabled plugin + fresh guard telemetry superseded by post-/compact transcript update
  writeFileSync(
    otelPath,
    JSON.stringify({
      schema_version: 1,
      conversation_id: 'main-1',
      timestamp: new Date(t0Ms).toISOString(),
      active_tokens: 165_000,
      source: 'transcript_usage',
      zone: 'hard',
      fork_eligible: false,
      compact_recommended: true,
      thresholds: { fork_max: 60_000, yellow: 64_000, red: 120_000, hard: 160_000 },
    }),
    'utf-8'
  );
  const r3 = await fetch(`${baseUrl}/api/metrics?conversationId=main-1&mode=current`);
  const j3 = await r3.json();
  assert.equal(j3.orchestrator.source, 'transcript_usage');
  assert.equal(j3.orchestrator.active_tokens, 165_000);
  assert.equal(j3.orchestrator.zone, 'hard');

  // Append CHECKPOINT + post-compact turn newer than guard timestamp (+5s > +2s skew grace)
  appendFileSync(
    trPath,
    JSON.stringify({
      step_index: 1,
      type: 'CHECKPOINT',
      content: '# Resuming from a compaction',
      created_at: new Date(t0Ms + 4000).toISOString(),
    }) +
      '\n' +
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 10_000,
        cache_read_tokens: 12_000,
        output_tokens: 150,
        created_at: new Date(t0Ms + 5000).toISOString(),
      }) +
      '\n',
    'utf-8'
  );
  utimesSync(trPath, new Date(t0Ms + 5000), new Date(t0Ms + 5000));
  fakeNowMs = t0Ms + 6000;

  const r4 = await fetch(
    `${baseUrl}/api/metrics?conversationId=main-1&mode=current&etag=${encodeURIComponent(j3.etag)}`
  );
  const j4 = await r4.json();
  assert.equal(j4.unchanged, false);
  assert.notEqual(j4.etag, j3.etag);
  assert.equal(j4.orchestrator.source, 'derived_transcript');
  assert.equal(j4.orchestrator.active_tokens, 22_000);
  assert.equal(j4.orchestrator.zone, 'green');
  assert.equal(j4.orchestrator.fork_eligible, true);
  assert.equal(j4.orchestrator.compact_recommended, false);

  // 4. Disabled Orchestrator plugin (config.json enabled: false) -> invalidates ETag & returns null
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ plugins: { orchestrator: { enabled: false } } }),
    'utf-8'
  );
  const r5 = await fetch(
    `${baseUrl}/api/metrics?conversationId=main-1&mode=current&etag=${encodeURIComponent(j4.etag)}`
  );
  const j5 = await r5.json();
  assert.equal(j5.unchanged, false);
  assert.notEqual(j5.etag, j4.etag);
  assert.equal(j5.orchestrator, null);
});
