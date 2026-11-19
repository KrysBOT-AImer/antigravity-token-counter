import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, posix } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readSessionModelFromGenMetadata } from './gen_metadata.mjs';
import { DEFAULT_SETTINGS, resolveEffectiveThresholds } from './settings.mjs';
import { computeMetrics, createTranscriptReader, isParsedChild } from './transcript.mjs';

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const ANCESTRY_CACHE_TTL_MS = 3000;

const dbCache = new Map(); // dbPath -> { db, ino, birthtimeNs }
const ancestryCache = new Map(); // appDataDir -> { expiresAt, map }

export function isSafeConversationId(id) {
  return typeof id === 'string' && SAFE_ID_RE.test(id);
}

/**
 * Locate `<appDataDir>` by walking upward from ANTIGRAVITY_EXECUTABLE_DATA_DIR
 * until reaching `sidecar_data`, or falling back to `~/.gemini/antigravity` / `~/.gemini/*`.
 */
export function findAppDataDir({
  env = process.env,
  home = homedir(),
  appDataDir,
  platform = process.platform,
} = {}) {
  if (appDataDir) return appDataDir;

  const dataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      const base = basename(d);
      const isSidecarData =
        platform === 'win32' ? base.toLowerCase() === 'sidecar_data' : base === 'sidecar_data';
      if (isSidecarData) {
        const candidate = dirname(d);
        return candidate;
      }
    }
    return null;
  }

  const defaultDir = join(home, '.gemini', 'antigravity');
  if (
    existsSync(join(defaultDir, 'brain')) ||
    existsSync(join(defaultDir, 'conversation_summaries.db'))
  ) {
    return defaultDir;
  }

  const geminiRoot = join(home, '.gemini');
  try {
    const entries = readdirSync(geminiRoot).sort();
    for (const name of entries) {
      const candidate = join(geminiRoot, name);
      if (
        existsSync(join(candidate, 'brain')) ||
        existsSync(join(candidate, 'conversation_summaries.db'))
      ) {
        return candidate;
      }
    }
  } catch {
    // ignore missing ~/.gemini
  }

  return null;
}

export function transcriptPathFor(appDataDir, convId) {
  if (!appDataDir || !isSafeConversationId(convId)) return null;
  return join(appDataDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
}

function parseUriPath(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return '';
  let s = uri.trim();
  const hasFileScheme = /^file:\/\//i.test(s);
  if (hasFileScheme) {
    s = s.slice('file://'.length);
    if (/^localhost\//i.test(s)) {
      s = s.slice('localhost'.length);
    } else if (/^[^/]+\//.test(s) && !/^[a-zA-Z](?::|%3[aA])/.test(s)) {
      s = '//' + s;
    }
  }
  try {
    s = decodeURIComponent(s);
  } catch {
    // keep raw string if percent-encoding is invalid
  }
  const isWindowsDrive = /^\/?[a-zA-Z]:(?:[\\/]|$)/.test(s);
  const isWindowsUnc = /^(\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(s);
  if (isWindowsDrive || isWindowsUnc) {
    s = s.replace(/\\/g, '/');
  }
  return s;
}

export function normalizeWorkspaceUri(uri) {
  const s = parseUriPath(uri);
  if (!s) return '';

  const driveMatch = /^\/?([a-zA-Z]):(?:\/(.*))?$/.exec(s);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const restTrimmed = (driveMatch[2] || '').replace(/^\/+|\/+$/g, '').toLowerCase();
    return restTrimmed ? `/${drive}:/${restTrimmed}` : `/${drive}:/`;
  }

  const uncMatch = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(s);
  if (uncMatch) {
    const server = uncMatch[1].toLowerCase();
    const share = uncMatch[2].toLowerCase();
    const restTrimmed = (uncMatch[3] || '').replace(/^\/+|\/+$/g, '').toLowerCase();
    return restTrimmed ? `//${server}/${share}/${restTrimmed}` : `//${server}/${share}`;
  }

  if (/^\/+$/.test(s)) return '/';
  return s.replace(/\/+$/, '');
}

export function parseWorkspaceUris(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((u) => typeof u === 'string' && u.trim());
  }
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((u) => typeof u === 'string' && u.trim());
      }
    } catch {
      return [];
    }
  }
  return [trimmed];
}

export function workspaceBasename(workspaceUrisRaw) {
  const uris = parseWorkspaceUris(workspaceUrisRaw);
  if (uris.length === 0) return '';
  const parsed = parseUriPath(uris[0]);
  if (!parsed) return '';
  const trimmed = parsed.replace(/\/+$/, '');
  if (!trimmed) return '';
  return posix.basename(trimmed);
}

function normalizeTargetWorkspaceSet(targetWorkspaceUris) {
  const rawTargets = Array.isArray(targetWorkspaceUris)
    ? targetWorkspaceUris
    : typeof targetWorkspaceUris === 'string' && targetWorkspaceUris.trim()
      ? parseWorkspaceUris(targetWorkspaceUris)
      : [];
  const targets = new Set();
  for (const t of rawTargets) {
    const norm = normalizeWorkspaceUri(t);
    if (norm) targets.add(norm);
  }
  return targets;
}

export function workspaceMatches(workspaceUrisRaw, targetWorkspaceUris) {
  const targets = normalizeTargetWorkspaceSet(targetWorkspaceUris);
  if (targets.size === 0) return false;
  const uris = parseWorkspaceUris(workspaceUrisRaw);
  return uris.some((u) => targets.has(normalizeWorkspaceUri(u)));
}

function defaultProbeWin32Lock(lockPath) {
  let fd;
  try {
    fd = openSync(lockPath, 'r+');
    return false;
  } catch (err) {
    if (err?.code === 'EBUSY' || err?.code === 'EACCES' || err?.code === 'EPERM') {
      return true;
    }
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * Detect conversation IDs holding an active presence lock:
 * - Linux (or explicit `locksPath`): inspects `/proc/locks` FLOCK lines against `presence/*.lock` inodes.
 *   Note: On Linux Btrfs, statSync(lockFile).dev reports the subvolume st_dev while /proc/locks
 *   reports the superblock s_dev, so matching stays inode-based and strictly filters FLOCK lines.
 * - Windows (`platform === 'win32'` without `locksPath`): runs a non-destructive `r+` share-lock probe
 *   followed by recent `mtimeMs` liveness fallback on the `.lock` file or `transcript.jsonl`.
 */
export function readActiveLockIds({
  appDataDir,
  locksPath,
  platform = process.platform,
  nowMs = Date.now(),
  win32RecencyMs = 120_000,
  probeWin32Lock,
} = {}) {
  const active = new Set();
  if (!appDataDir) return active;

  const presenceDir = join(appDataDir, 'presence');
  let lockFiles;
  try {
    lockFiles = readdirSync(presenceDir).filter((f) => f.endsWith('.lock'));
  } catch {
    return active;
  }
  if (lockFiles.length === 0) return active;

  if (locksPath !== undefined || platform === 'linux') {
    const resolvedLocksPath = locksPath ?? '/proc/locks';
    let lockedInodes;
    try {
      const content = readFileSync(resolvedLocksPath, 'utf-8');
      lockedInodes = new Set();
      for (const line of content.split('\n')) {
        const match = /^\d+:\s+FLOCK\s+\S+\s+\S+\s+\d+\s+\S+?:\S+?:(\d+)\s/.exec(line);
        if (match) {
          lockedInodes.add(match[1]);
        }
      }
    } catch {
      return active;
    }
    if (lockedInodes.size === 0) return active;

    for (const file of lockFiles) {
      const convId = file.slice(0, -5);
      if (!isSafeConversationId(convId)) continue;
      try {
        const st = statSync(join(presenceDir, file), { bigint: true });
        if (lockedInodes.has(String(st.ino))) {
          active.add(convId);
        }
      } catch {
        // lock file may have been removed concurrently
      }
    }

    return active;
  }

  if (platform === 'win32') {
    const probeFn = typeof probeWin32Lock === 'function' ? probeWin32Lock : defaultProbeWin32Lock;
    for (const file of lockFiles) {
      const convId = file.slice(0, -5);
      if (!isSafeConversationId(convId)) continue;
      const lockPath = join(presenceDir, file);

      let lockedByProbe = false;
      try {
        lockedByProbe = Boolean(probeFn(lockPath));
      } catch (err) {
        if (err?.code === 'EBUSY' || err?.code === 'EACCES' || err?.code === 'EPERM') {
          lockedByProbe = true;
        }
      }
      if (lockedByProbe) {
        active.add(convId);
        continue;
      }

      let lockSt;
      try {
        lockSt = statSync(lockPath);
      } catch {
        // lock file may have been removed concurrently
        continue;
      }
      if (nowMs - lockSt.mtimeMs <= win32RecencyMs) {
        active.add(convId);
        continue;
      }

      const trPath = transcriptPathFor(appDataDir, convId);
      if (trPath) {
        try {
          const trSt = statSync(trPath);
          if (nowMs - trSt.mtimeMs <= win32RecencyMs) {
            active.add(convId);
          }
        } catch {
          // missing transcript
        }
      }
    }
  }

  return active;
}

/**
 * Resolve the sidecar events directory (`events/*.json`), checking:
 * 1) explicit `eventsDir`
 * 2) `dataDir ? join(dirname(dataDir), 'events')`
 * 3) `join(appDataDir, 'sidecar_data', 'token-counter', 'token_counter', 'events')`
 */
export function resolveEventsDir({ appDataDir, dataDir, eventsDir } = {}) {
  if (typeof eventsDir === 'string' && eventsDir.trim()) {
    return eventsDir.trim();
  }
  const candidates = [];
  if (typeof dataDir === 'string' && dataDir.trim()) {
    candidates.push(join(dirname(dataDir.trim()), 'events'));
  }
  if (typeof appDataDir === 'string' && appDataDir.trim()) {
    candidates.push(
      join(appDataDir.trim(), 'sidecar_data', 'token-counter', 'token_counter', 'events')
    );
  }
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0] || null;
}

const VIEW_TIME_PBTXT_RE =
  /last_user_view_time:\s*\{\s*seconds:\s*(\d+)(?:\s+nanos:\s*(\d+))?\s*\}/;

/**
 * Read the most recently viewed conversation ID from real-time tab-switch signals:
 * - Signal 1: `<eventsDir>/*.json` (`timestampMs` + `payload.conversationMetadata.metadata.rootConversationId`)
 * - Signal 2: `<appDataDir>/annotations/*.pbtxt` (`last_user_view_time`)
 *
 * When `workspaceUris` is provided and any candidates match it (directly or via parent inheritance),
 * selection is strictly scoped to those workspace-matched candidates.
 * `events/*.json` only wins over annotations when strictly newer (`bestEvent.timestampNs > maxViewTimeNs`).
 * Exact nanosecond `annotations` ties break via:
 * (1) matches `workspaceUris`, (2) active lock, (3) freshest transcript `mtimeMs`,
 * (4) matches `events/*.json` `rootConversationId`, (5) annotation `mtimeMs`, (6) `id`.
 */
export function readLatestViewedSession({
  appDataDir,
  dataDir,
  eventsDir,
  workspaceUris,
  activeLocks,
  locksPath,
  dbPath,
  platform,
  nowMs,
  win32RecencyMs,
  probeWin32Lock,
} = {}) {
  if (!appDataDir && !dataDir && !eventsDir) return null;

  const eventById = new Map();
  const resolvedEventsDir = resolveEventsDir({ appDataDir, dataDir, eventsDir });
  if (resolvedEventsDir) {
    let eventFiles = [];
    try {
      eventFiles = readdirSync(resolvedEventsDir).filter((f) => f.endsWith('.json'));
    } catch {
      eventFiles = [];
    }
    if (eventFiles.length > 0) {
      const withMtime = [];
      for (const file of eventFiles) {
        const fullPath = join(resolvedEventsDir, file);
        try {
          const st = statSync(fullPath);
          withMtime.push({ file, fullPath, mtimeMs: st.mtimeMs });
        } catch {
          // ignore concurrently removed event file
        }
      }
      withMtime.sort((a, b) => {
        if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
        return b.file.localeCompare(a.file);
      });
      for (const cand of withMtime.slice(0, 25)) {
        try {
          const ev = JSON.parse(readFileSync(cand.fullPath, 'utf-8'));
          const convId =
            typeof ev?.payload?.conversationMetadata?.metadata?.rootConversationId === 'string'
              ? ev.payload.conversationMetadata.metadata.rootConversationId.trim()
              : '';
          if (!isSafeConversationId(convId)) continue;
          const rawTs = Number(ev?.timestampMs);
          const timestampMs = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : cand.mtimeMs;
          const timestampNs = BigInt(Math.floor(timestampMs)) * 1_000_000n;
          const prev = eventById.get(convId);
          if (
            !prev ||
            timestampNs > prev.timestampNs ||
            (timestampNs === prev.timestampNs && cand.mtimeMs > prev.mtimeMs)
          ) {
            eventById.set(convId, {
              id: convId,
              timestampMs,
              timestampNs,
              mtimeMs: cand.mtimeMs,
            });
          }
        } catch {
          // skip malformed or incomplete event json
        }
      }
    }
  }
  const eventCandidates = [...eventById.values()];

  const annCandidates = [];
  if (appDataDir) {
    const annotationsDir = join(appDataDir, 'annotations');
    let annFiles = [];
    try {
      annFiles = readdirSync(annotationsDir).filter((f) => f.endsWith('.pbtxt'));
    } catch {
      annFiles = [];
    }
    if (annFiles.length > 0) {
      const withMtime = [];
      for (const file of annFiles) {
        const convId = file.slice(0, -6);
        if (!isSafeConversationId(convId)) continue;
        const fullPath = join(annotationsDir, file);
        try {
          const st = statSync(fullPath);
          withMtime.push({ convId, fullPath, mtimeMs: st.mtimeMs });
        } catch {
          // ignore concurrently removed annotation file
        }
      }
      withMtime.sort((a, b) => {
        if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
        return b.convId.localeCompare(a.convId);
      });
      for (const cand of withMtime) {
        try {
          const text = readFileSync(cand.fullPath, 'utf-8');
          const match = VIEW_TIME_PBTXT_RE.exec(text);
          if (!match) continue;
          const secondsStr = match[1];
          const nanosStr = match[2] || '0';
          const seconds = Number(secondsStr);
          const nanos = Number(nanosStr);
          if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) continue;
          const viewTimeNs = BigInt(secondsStr) * 1_000_000_000n + BigInt(nanosStr);
          const viewTimeMs = seconds * 1000 + Math.floor(nanos / 1e6);
          annCandidates.push({
            id: cand.convId,
            viewTimeNs,
            viewTimeMs,
            mtimeMs: cand.mtimeMs,
          });
        } catch {
          // ignore unreadable annotation file
        }
      }
    }
  }

  const targetTargets = normalizeTargetWorkspaceSet(workspaceUris);
  const wsMatchIds = new Set();
  if (
    targetTargets.size > 0 &&
    appDataDir &&
    (annCandidates.length > 0 || eventCandidates.length > 0)
  ) {
    const candidateIds = new Set([
      ...annCandidates.map((c) => c.id),
      ...eventCandidates.map((c) => c.id),
    ]);
    const resolvedDbPath = dbPath || join(appDataDir, 'conversation_summaries.db');
    withReadOnlyDb(
      resolvedDbPath,
      (db) => {
        const stmtWs = db.prepare(
          'SELECT workspace_uris, parent_conversation_id FROM conversation_summaries WHERE conversation_id = ?'
        );
        let stmtParent = null;
        try {
          stmtParent = db.prepare(
            'SELECT parent_id FROM conversation_parents WHERE conversation_id = ?'
          );
        } catch {
          // conversation_parents table may not exist in older or mock DBs
        }
        for (const id of candidateIds) {
          try {
            let cur = id;
            const visited = new Set();
            for (let hop = 0; hop < 10 && cur; hop++) {
              if (visited.has(cur)) break;
              visited.add(cur);
              const row = stmtWs.get(cur);
              if (row) {
                if (workspaceMatches(row.workspace_uris, workspaceUris)) {
                  wsMatchIds.add(id);
                  break;
                }
                if (parseWorkspaceUris(row.workspace_uris).length > 0) {
                  break;
                }
                let parentId =
                  typeof row.parent_conversation_id === 'string'
                    ? row.parent_conversation_id.trim()
                    : '';
                if (!parentId && stmtParent) {
                  const pRow = stmtParent.get(cur);
                  if (pRow && typeof pRow.parent_id === 'string') {
                    parentId = pRow.parent_id.trim();
                  }
                }
                if (!parentId) {
                  parentId = readDirectParentIdFromDisk(appDataDir, cur) || '';
                }
                cur = parentId;
              } else {
                let parentId = '';
                if (stmtParent) {
                  const pRow = stmtParent.get(cur);
                  if (pRow && typeof pRow.parent_id === 'string') {
                    parentId = pRow.parent_id.trim();
                  }
                }
                if (!parentId) {
                  parentId = readDirectParentIdFromDisk(appDataDir, cur) || '';
                }
                cur = parentId;
              }
            }
          } catch {
            // ignore query error
          }
        }
      },
      { platform }
    );
  }

  const wsAnn = wsMatchIds.size > 0 ? annCandidates.filter((c) => wsMatchIds.has(c.id)) : [];
  const wsEvents = wsMatchIds.size > 0 ? eventCandidates.filter((c) => wsMatchIds.has(c.id)) : [];
  const hasWsScope = wsAnn.length > 0 || wsEvents.length > 0;
  const activeAnn = hasWsScope ? wsAnn : annCandidates;
  const activeEvents = hasWsScope ? wsEvents : eventCandidates;

  let bestEvent = null;
  if (activeEvents.length > 0) {
    activeEvents.sort((a, b) => {
      if (b.timestampNs !== a.timestampNs) return b.timestampNs > a.timestampNs ? 1 : -1;
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return a.id.localeCompare(b.id);
    });
    bestEvent = activeEvents[0];
  }

  if (activeAnn.length === 0) {
    return bestEvent
      ? { id: bestEvent.id, timestampMs: bestEvent.timestampMs, source: 'events' }
      : null;
  }

  let maxViewTimeNs = activeAnn[0].viewTimeNs;
  for (let i = 1; i < activeAnn.length; i++) {
    if (activeAnn[i].viewTimeNs > maxViewTimeNs) {
      maxViewTimeNs = activeAnn[i].viewTimeNs;
    }
  }

  if (bestEvent && bestEvent.timestampNs > maxViewTimeNs) {
    return {
      id: bestEvent.id,
      timestampMs: bestEvent.timestampMs,
      source: 'events',
    };
  }

  const tied = activeAnn.filter((cand) => cand.viewTimeNs === maxViewTimeNs);
  if (tied.length === 1) {
    return {
      id: tied[0].id,
      timestampMs: tied[0].viewTimeMs,
      source: 'annotations',
    };
  }

  const locks =
    activeLocks instanceof Set
      ? activeLocks
      : appDataDir
        ? readActiveLockIds({
            appDataDir,
            locksPath,
            platform,
            nowMs,
            win32RecencyMs,
            probeWin32Lock,
          })
        : new Set();

  const scored = tied.map((cand) => {
    const matchesWs = wsMatchIds.has(cand.id) ? 1 : 0;
    const hasLock = locks.has(cand.id) ? 1 : 0;
    let transcriptMtimeMs = 0;
    const trPath = transcriptPathFor(appDataDir, cand.id);
    if (trPath) {
      try {
        transcriptMtimeMs = statSync(trPath).mtimeMs;
      } catch {
        transcriptMtimeMs = 0;
      }
    }
    const matchesEvent = bestEvent && cand.id === bestEvent.id ? 1 : 0;
    return { ...cand, matchesWs, hasLock, transcriptMtimeMs, matchesEvent };
  });

  scored.sort((a, b) => {
    if (b.matchesWs !== a.matchesWs) return b.matchesWs - a.matchesWs;
    if (b.hasLock !== a.hasLock) return b.hasLock - a.hasLock;
    if (b.transcriptMtimeMs !== a.transcriptMtimeMs) return b.transcriptMtimeMs - a.transcriptMtimeMs;
    if (b.matchesEvent !== a.matchesEvent) return b.matchesEvent - a.matchesEvent;
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.id.localeCompare(b.id);
  });

  return {
    id: scored[0].id,
    timestampMs: scored[0].viewTimeMs,
    source: 'annotations',
  };
}

function evictCachedDb(dbPath) {
  const cached = dbCache.get(dbPath);
  if (!cached) return;
  dbCache.delete(dbPath);
  try {
    cached.db.close();
  } catch {
    // ignore close errors
  }
}

function getCachedReadOnlyDb(dbPath) {
  if (!dbPath) return null;
  let st;
  try {
    st = statSync(dbPath, { bigint: true });
  } catch {
    evictCachedDb(dbPath);
    return null;
  }

  const cached = dbCache.get(dbPath);
  if (cached) {
    const sameFile =
      cached.ino === st.ino && (st.ino !== 0n || cached.birthtimeNs === st.birthtimeNs);
    if (sameFile) {
      return cached.db;
    }
    evictCachedDb(dbPath);
  }

  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 500');
    } catch {
      // ignore if pragma fails
    }
    dbCache.set(dbPath, { db, ino: st.ino, birthtimeNs: st.birthtimeNs });
    return db;
  } catch {
    return null;
  }
}

function withReadOnlyDb(dbPath, fn, { platform = process.platform } = {}) {
  if (!dbPath) return undefined;
  if (platform === 'win32') {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout = 500');
      } catch {
        // ignore if pragma fails
      }
      return fn(db);
    } catch {
      return undefined;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore close errors
        }
      }
    }
  }

  const db = getCachedReadOnlyDb(dbPath);
  if (!db) return undefined;
  try {
    return fn(db);
  } catch {
    evictCachedDb(dbPath);
    return undefined;
  }
}

export function closeCachedDbs() {
  for (const cached of dbCache.values()) {
    try {
      cached.db.close();
    } catch {
      // ignore close errors
    }
  }
  dbCache.clear();
  ancestryCache.clear();
}

export function getDiscoverySource(options = {}) {
  const appDataDir = findAppDataDir(options);
  if (!appDataDir) return 'fs_fallback';
  const dbPath = options.dbPath || join(appDataDir, 'conversation_summaries.db');
  const ok = withReadOnlyDb(
    dbPath,
    (db) => {
      db.prepare('SELECT 1 FROM conversation_summaries LIMIT 1').get();
      return true;
    },
    { platform: options.platform }
  );
  return ok ? 'sqlite' : 'fs_fallback';
}

function toIsoTimestamp(value, fallbackMs = 0) {
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const ms = Date.parse(normalized);
    if (Number.isFinite(ms)) {
      return new Date(ms).toISOString();
    }
    return value;
  }
  return fallbackMs > 0 ? new Date(fallbackMs).toISOString() : null;
}

function zoneOf(contextTokens, model = '', settings = DEFAULT_SETTINGS) {
  const eff = resolveEffectiveThresholds(model, settings);
  if (contextTokens >= eff.dumbZoneThreshold) return 'dumb';
  if (contextTokens >= eff.cautionThreshold) return 'caution';
  return 'safe';
}

function isMainSummaryRow(row) {
  if (!row) return false;
  const parent = typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id.trim() : '';
  const depth = row.nesting_depth ?? 0;
  const agent = typeof row.agent_name === 'string' ? row.agent_name.trim() : '';
  return !parent && depth === 0 && !agent;
}

export function readDirectParentIdFromDisk(appDataDir, convId) {
  if (!appDataDir || !isSafeConversationId(convId)) return null;
  const cacheFile = join(appDataDir, 'brain', convId, '.system_generated', '.parent_id_cache.json');
  try {
    const raw = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    const parentId = typeof raw?.parent_id === 'string' ? raw.parent_id.trim() : '';
    if (isSafeConversationId(parentId) && parentId !== convId) {
      return parentId;
    }
  } catch {
    // ignore missing or malformed parent cache
  }
  return null;
}

export function buildOnDiskAncestryMap(appDataDir, { bypassCache = false } = {}) {
  const map = new Map();
  if (!appDataDir) return map;

  const now = Date.now();
  if (!bypassCache) {
    const cached = ancestryCache.get(appDataDir);
    if (cached && cached.expiresAt > now) {
      return cached.map;
    }
  }

  const brainDir = join(appDataDir, 'brain');
  let entries;
  try {
    entries = readdirSync(brainDir);
  } catch {
    return map;
  }

  for (const id of entries) {
    if (!isSafeConversationId(id)) continue;
    const sysGenDir = join(brainDir, id, '.system_generated');

    // 1. Direct parent cache (.parent_id_cache.json)
    const directParent = readDirectParentIdFromDisk(appDataDir, id);
    if (directParent) {
      map.set(id, directParent);
    }

    // 2. Subagent records (subagents/*.json)
    const subagentsDir = join(sysGenDir, 'subagents');
    try {
      const subFiles = readdirSync(subagentsDir);
      for (const file of subFiles) {
        if (!file.endsWith('.json')) continue;
        let childId = '';
        try {
          const data = JSON.parse(readFileSync(join(subagentsDir, file), 'utf-8'));
          const candidate =
            (typeof data?.conversationId === 'string' && data.conversationId.trim()) ||
            (typeof data?.conversation_id === 'string' && data.conversation_id.trim()) ||
            file.slice(0, -5);
          childId = candidate;
        } catch {
          childId = file.slice(0, -5);
        }
        if (isSafeConversationId(childId) && childId !== id && !map.has(childId)) {
          map.set(childId, id);
        }
      }
    } catch {
      // no subagents dir
    }

    // 3. Swarm roster (swarm/members.json)
    const swarmFile = join(sysGenDir, 'swarm', 'members.json');
    try {
      const swarmData = JSON.parse(readFileSync(swarmFile, 'utf-8'));
      const memberList = Array.isArray(swarmData)
        ? swarmData
        : Array.isArray(swarmData?.members)
          ? swarmData.members
          : swarmData && typeof swarmData === 'object'
            ? Object.values(swarmData)
            : [];
      const coordinator = memberList.find((m) => m && m.role === 'coordinator');
      const coordRaw =
        (typeof coordinator?.conversation_id === 'string' && coordinator.conversation_id.trim()) ||
        (typeof coordinator?.conversationId === 'string' && coordinator.conversationId.trim()) ||
        '';
      const coordinatorId = isSafeConversationId(coordRaw) ? coordRaw : id;

      for (const member of memberList) {
        if (!member || member.role === 'coordinator') continue;
        const rawChild =
          (typeof member.conversation_id === 'string' && member.conversation_id.trim()) ||
          (typeof member.conversationId === 'string' && member.conversationId.trim()) ||
          '';
        if (isSafeConversationId(rawChild) && rawChild !== coordinatorId && !map.has(rawChild)) {
          map.set(rawChild, coordinatorId);
        }
      }
    } catch {
      // no swarm members file
    }
  }

  ancestryCache.set(appDataDir, { expiresAt: now + ANCESTRY_CACHE_TTL_MS, map });
  return map;
}

function getActiveChildCountsMap(db) {
  const counts = new Map();
  if (!db) return counts;
  try {
    const rows = db
      .prepare(
        `SELECT parent_conversation_id, COUNT(*) AS cnt
         FROM conversation_summaries
         WHERE parent_conversation_id IS NOT NULL AND parent_conversation_id != ''
           AND (killed IS NULL OR killed = 0)
           AND (status = 'CASCADE_RUN_STATUS_RUNNING' OR not_fully_idle = 1)
         GROUP BY parent_conversation_id`
      )
      .all();
    for (const r of rows) {
      if (typeof r.parent_conversation_id === 'string' && r.parent_conversation_id.trim()) {
        counts.set(r.parent_conversation_id.trim(), Number(r.cnt) || 0);
      }
    }
  } catch {
    // ignore query errors
  }
  return counts;
}

function countActiveChildrenFromDisk(ancestryMap, activeLocks) {
  const counts = new Map();
  if (!ancestryMap || !activeLocks || activeLocks.size === 0) return counts;
  for (const [childId, parentId] of ancestryMap.entries()) {
    if (activeLocks.has(childId)) {
      counts.set(parentId, (counts.get(parentId) || 0) + 1);
    }
  }
  return counts;
}

function isIdentifiableChild(
  appDataDir,
  convId,
  { dbPath, reader, ancestryMap, platform } = {}
) {
  if (!appDataDir || !isSafeConversationId(convId)) return false;

  const resolvedDbPath = dbPath || join(appDataDir, 'conversation_summaries.db');
  const foundChildInDb = withReadOnlyDb(
    resolvedDbPath,
    (db) => {
      const row = db
        .prepare(
          `SELECT parent_conversation_id, nesting_depth, agent_name
           FROM conversation_summaries
           WHERE conversation_id = ?`
        )
        .get(convId);
      return Boolean(row && !isMainSummaryRow(row));
    },
    { platform }
  );
  if (foundChildInDb) return true;

  const map = ancestryMap || buildOnDiskAncestryMap(appDataDir);
  if (map.has(convId)) return true;

  const trPath = transcriptPathFor(appDataDir, convId);
  if (trPath && existsSync(trPath)) {
    const parsed = (reader || createTranscriptReader()).readTranscript(trPath);
    if (parsed && (isParsedChild(parsed) || parsed.isChildTranscript)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve a conversation ID (which may be a subagent or swarm worker)
 * up the parent_conversation_id chain to its root main session.
 */
export function resolveRootMainSession(convId, options = {}) {
  if (!isSafeConversationId(convId)) return null;
  const appDataDir = findAppDataDir(options);
  if (!appDataDir) return null;

  const reader = options.transcriptReader || createTranscriptReader();
  const dbPath = options.dbPath || join(appDataDir, 'conversation_summaries.db');
  const platform = options.platform;

  let sqlAvailable = false;
  let sqlWalkTail = convId;
  let sqlCycle = false;

  const sqlResolved = withReadOnlyDb(
    dbPath,
    (db) => {
      const stmtSummary = db.prepare(
        `SELECT conversation_id, title, last_modified_time, workspace_uris, status,
                agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
         FROM conversation_summaries
         WHERE conversation_id = ?`
      );
      sqlAvailable = true;
      let stmtParent = null;
      try {
        stmtParent = db.prepare(
          'SELECT parent_id FROM conversation_parents WHERE conversation_id = ?'
        );
      } catch {
        // conversation_parents table may not exist in older or mock DBs
      }

      const visited = new Set();
      let cur = convId;

      for (let hop = 0; hop < 10; hop++) {
        if (!cur) break;
        if (visited.has(cur)) {
          sqlCycle = true;
          break;
        }
        visited.add(cur);

        const row = stmtSummary.get(cur);
        if (row) {
          let parentId = typeof row.parent_conversation_id === 'string'
            ? row.parent_conversation_id.trim()
            : '';
          if (!parentId && stmtParent && ((row.nesting_depth ?? 0) > 0 || (row.agent_name || '') !== '')) {
            const pRow = stmtParent.get(cur);
            if (pRow && typeof pRow.parent_id === 'string') {
              parentId = pRow.parent_id.trim();
            }
          }
          if (!parentId) {
            if (isMainSummaryRow(row)) {
              return {
                id: row.conversation_id,
                row,
                resolvedFromChildId: row.conversation_id !== convId ? convId : null,
                discoverySource: 'sqlite',
              };
            }
            // Terminated on a child row with missing parent in SQLite; fall through to disk walk.
            sqlWalkTail = cur;
            break;
          }
          if (visited.has(parentId)) {
            sqlCycle = true;
            break;
          }
          cur = parentId;
          sqlWalkTail = cur;
        } else if (stmtParent) {
          const pRow = stmtParent.get(cur);
          if (pRow && typeof pRow.parent_id === 'string' && pRow.parent_id.trim()) {
            const nextId = pRow.parent_id.trim();
            if (visited.has(nextId)) {
              sqlCycle = true;
              break;
            }
            cur = nextId;
            sqlWalkTail = cur;
            continue;
          }
          sqlWalkTail = cur;
          break;
        } else {
          sqlWalkTail = cur;
          break;
        }
      }
      return null;
    },
    { platform }
  );
  if (sqlResolved) return sqlResolved;

  // On-disk ancestry + transcript verification fallback
  const ancestryMap = buildOnDiskAncestryMap(appDataDir);
  const diskVisited = new Set();
  let rootCandidate = !sqlCycle && isSafeConversationId(sqlWalkTail) ? sqlWalkTail : convId;
  let hitCycle = false;

  for (let hop = 0; hop < 10; hop++) {
    if (diskVisited.has(rootCandidate)) {
      hitCycle = true;
      break;
    }
    diskVisited.add(rootCandidate);
    const directParent =
      readDirectParentIdFromDisk(appDataDir, rootCandidate) ||
      ancestryMap.get(rootCandidate) ||
      null;
    if (!directParent) break;
    if (diskVisited.has(directParent)) {
      hitCycle = true;
      break;
    }
    rootCandidate = directParent;
  }

  if (hitCycle || ancestryMap.has(rootCandidate)) {
    return null;
  }

  if (sqlAvailable) {
    const matched = withReadOnlyDb(
      dbPath,
      (db) => {
        const matchedRow = db
          .prepare(
            `SELECT conversation_id, title, last_modified_time, workspace_uris, status,
                    agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
             FROM conversation_summaries
             WHERE conversation_id = ?`
          )
          .get(rootCandidate);
        if (!matchedRow) return undefined;
        if (!isMainSummaryRow(matchedRow)) {
          return null;
        }
        return {
          id: matchedRow.conversation_id,
          row: matchedRow,
          resolvedFromChildId: matchedRow.conversation_id !== convId ? convId : null,
          discoverySource: 'sqlite',
        };
      },
      { platform }
    );
    if (matched !== undefined) return matched;
  }

  const trPath = transcriptPathFor(appDataDir, rootCandidate);
  if (!trPath || !existsSync(trPath)) {
    return null;
  }
  const parsed = reader.readTranscript(trPath);
  if (!parsed || isParsedChild(parsed) || parsed.isChildTranscript) {
    return null;
  }

  return {
    id: rootCandidate,
    row: null,
    resolvedFromChildId: rootCandidate !== convId ? convId : null,
    discoverySource: 'fs_fallback',
  };
}

/**
 * List recent strictly-main sessions along with discoverySource metadata.
 */
export function listMainSessionsWithMeta(options = {}) {
  const appDataDir = findAppDataDir(options);
  if (!appDataDir) return { sessions: [], discoverySource: 'fs_fallback' };

  const settings = options.settings || DEFAULT_SETTINGS;
  const reader = options.transcriptReader || createTranscriptReader();
  const targetWorkspaceUris = options.workspaceUris ?? options.workspaceUri ?? '';
  const hasWorkspaceFilter = normalizeTargetWorkspaceSet(targetWorkspaceUris).size > 0;
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 25));
  const platform = options.platform;
  const activeLocks = readActiveLockIds({
    appDataDir,
    locksPath: options.locksPath,
    platform,
    nowMs: options.nowMs,
    win32RecencyMs: options.win32RecencyMs,
    probeWin32Lock: options.probeWin32Lock,
  });
  const dbPath = options.dbPath || join(appDataDir, 'conversation_summaries.db');

  const sqliteResult = withReadOnlyDb(
    dbPath,
    (db) => {
      const fetchLimit = hasWorkspaceFilter ? Math.max(limit * 3, 75) : limit;
      const rows = db
        .prepare(
          `SELECT conversation_id, title, last_modified_time, workspace_uris,
                  status, not_fully_idle, killed
           FROM conversation_summaries
           WHERE (parent_conversation_id IS NULL OR parent_conversation_id = '')
             AND (nesting_depth IS NULL OR nesting_depth = 0)
             AND (agent_name IS NULL OR agent_name = '')
             AND (killed IS NULL OR killed = 0)
           ORDER BY last_modified_time DESC
           LIMIT ?`
        )
        .all(fetchLimit);

      const activeChildCounts = getActiveChildCountsMap(db);

      const sessions = rows.map((row) => {
        const id = row.conversation_id;
        const trPath = transcriptPathFor(appDataDir, id);
        const parsed = trPath ? reader.readTranscript(trPath) : null;
        const genMeta =
          !parsed || !parsed.lastModel ? readSessionModelFromGenMetadata(appDataDir, id) : null;
        const model = (parsed && parsed.lastModel) || genMeta?.model || '';
        const derived = parsed
          ? computeMetrics(parsed, settings, {
              fallbackModel: genMeta?.model || '',
              modelSource: genMeta?.model ? 'gen_metadata' : 'none',
            })
          : null;
        const contextTokens = derived ? derived.metrics.contextTokens : 0;
        const isActiveLock = activeLocks.has(id);
        const wsMatch = workspaceMatches(row.workspace_uris, targetWorkspaceUris);

        return {
          id,
          title: (row.title && row.title.trim()) || (derived && derived.firstUserPrompt) || id.slice(0, 8),
          workspace: workspaceBasename(row.workspace_uris),
          status: row.status || (isActiveLock ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE'),
          isActiveLock,
          activeChildCount: activeChildCounts.get(id) || 0,
          lastModified: toIsoTimestamp(row.last_modified_time),
          contextTokens,
          zone: zoneOf(contextTokens, model, settings),
          _workspaceMatch: wsMatch,
          _notFullyIdle: Boolean(row.not_fully_idle),
        };
      });

      if (hasWorkspaceFilter) {
        sessions.sort((a, b) => {
          if (a._workspaceMatch !== b._workspaceMatch) return a._workspaceMatch ? -1 : 1;
          return 0;
        });
      }

      return {
        sessions: sessions.slice(0, limit).map(({ _workspaceMatch, _notFullyIdle, ...rest }) => rest),
        discoverySource: 'sqlite',
      };
    },
    { platform }
  );
  if (sqliteResult) return sqliteResult;

  return {
    sessions: listMainSessionsFromFilesystem({
      appDataDir,
      limit,
      activeLocks,
      reader,
      settings,
    }),
    discoverySource: 'fs_fallback',
  };
}

/**
 * List recent strictly-main sessions (parent_conversation_id='', nesting_depth=0, agent_name=''),
 * falling back to scanning brain/ transcripts if the SQLite DB is unavailable.
 */
export function listMainSessions(options = {}) {
  return listMainSessionsWithMeta(options).sessions;
}

function listMainSessionsFromFilesystem({ appDataDir, limit, activeLocks, reader, settings }) {
  const brainDir = join(appDataDir, 'brain');
  let entries;
  try {
    entries = readdirSync(brainDir);
  } catch {
    return [];
  }

  const ancestryMap = buildOnDiskAncestryMap(appDataDir);
  const diskChildCounts = countActiveChildrenFromDisk(ancestryMap, activeLocks);

  const candidates = [];
  for (const id of entries) {
    if (!isSafeConversationId(id)) continue;
    if (ancestryMap.has(id)) continue;
    const trPath = transcriptPathFor(appDataDir, id);
    if (!trPath) continue;
    let st;
    try {
      st = statSync(trPath);
    } catch {
      continue;
    }
    candidates.push({ id, trPath, mtimeMs: st.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions = [];
  for (const cand of candidates) {
    if (sessions.length >= limit) break;
    const parsed = reader.readTranscript(cand.trPath);
    if (!parsed || isParsedChild(parsed) || parsed.isChildTranscript) continue;

    const genMeta = !parsed.lastModel
      ? readSessionModelFromGenMetadata(appDataDir, cand.id)
      : null;
    const model = parsed.lastModel || genMeta?.model || '';
    const derived = computeMetrics(parsed, settings, {
      fallbackModel: genMeta?.model || '',
      modelSource: genMeta?.model ? 'gen_metadata' : 'none',
    });
    const contextTokens = derived.metrics.contextTokens;
    const isActiveLock = activeLocks.has(cand.id);

    sessions.push({
      id: cand.id,
      title: derived.firstUserPrompt || cand.id.slice(0, 8),
      workspace: '',
      status: isActiveLock ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
      isActiveLock,
      activeChildCount: diskChildCounts.get(cand.id) || 0,
      lastModified: new Date(cand.mtimeMs).toISOString(),
      contextTokens,
      zone: zoneOf(contextTokens, model, settings),
    });
  }

  return sessions;
}

function formatResolvedTarget(resolved, { appDataDir, dbPath, activeLocks, mode, platform }) {
  const row = resolved.row;
  const trPath = transcriptPathFor(appDataDir, resolved.id);
  let mtimeMs = 0;
  try {
    if (trPath) mtimeMs = statSync(trPath).mtimeMs;
  } catch {
    // ignore missing transcript
  }
  const isActiveLock = activeLocks.has(resolved.id);
  const dbChildCount = withReadOnlyDb(
    dbPath,
    (db) => getActiveChildCountsMap(db).get(resolved.id) || 0,
    { platform }
  );
  const activeChildCount =
    dbChildCount !== undefined
      ? dbChildCount
      : countActiveChildrenFromDisk(buildOnDiskAncestryMap(appDataDir), activeLocks).get(resolved.id) ||
        0;

  return {
    id: resolved.id,
    title: (row?.title && row.title.trim()) || '',
    workspace: row ? workspaceBasename(row.workspace_uris) : '',
    status:
      row?.status || (isActiveLock ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE'),
    isActiveLock,
    activeChildCount,
    discoverySource: resolved.discoverySource || (row ? 'sqlite' : 'fs_fallback'),
    resolvedFromChildId: resolved.resolvedFromChildId,
    trackingMode: mode,
    lastModified: toIsoTimestamp(row?.last_modified_time, mtimeMs),
    transcriptPath: trPath,
  };
}

/**
 * Resolve the target main session for `/api/metrics` based on tracking mode.
 */
export function resolveTargetSession(options = {}) {
  const appDataDir = findAppDataDir(options);
  if (!appDataDir) return null;

  const settings = options.settings || DEFAULT_SETTINGS;
  const reader = options.transcriptReader || createTranscriptReader();
  const mode = options.mode === 'auto' || options.mode === 'pinned' ? options.mode : 'current';
  const conversationId = typeof options.conversationId === 'string' ? options.conversationId.trim() : '';
  const targetWorkspaceUris = options.workspaceUris ?? options.workspaceUri ?? '';
  const hasWorkspaceFilter = normalizeTargetWorkspaceSet(targetWorkspaceUris).size > 0;
  const platform = options.platform;
  const activeLocks = readActiveLockIds({
    appDataDir,
    locksPath: options.locksPath,
    platform,
    nowMs: options.nowMs,
    win32RecencyMs: options.win32RecencyMs,
    probeWin32Lock: options.probeWin32Lock,
  });
  const dbPath = options.dbPath || join(appDataDir, 'conversation_summaries.db');

  if (mode === 'pinned' && conversationId) {
    const resolved = resolveRootMainSession(conversationId, {
      ...options,
      appDataDir,
      dbPath,
      transcriptReader: reader,
    });
    if (resolved) {
      return formatResolvedTarget(resolved, { appDataDir, dbPath, activeLocks, mode, platform });
    }

    const childWithMissingParent = isIdentifiableChild(appDataDir, conversationId, {
      dbPath,
      reader,
      platform,
    });
    if (!childWithMissingParent) {
      return null;
    }
    // Identifiable child with unresolvable parent: fall through to active Main Session
  }

  let precomputedViewedResolved = null;
  if (mode === 'current') {
    const viewed = readLatestViewedSession({
      appDataDir,
      dataDir: options.dataDir,
      eventsDir: options.eventsDir,
      workspaceUris: targetWorkspaceUris,
      activeLocks,
      locksPath: options.locksPath,
      dbPath,
      platform,
      nowMs: options.nowMs,
      win32RecencyMs: options.win32RecencyMs,
      probeWin32Lock: options.probeWin32Lock,
    });
    if (viewed?.id) {
      const viewedResolved = resolveRootMainSession(viewed.id, {
        ...options,
        appDataDir,
        dbPath,
        transcriptReader: reader,
      });
      if (viewedResolved && !viewedResolved.row?.killed) {
        const viewedOutOfWorkspace =
          hasWorkspaceFilter &&
          viewedResolved.row &&
          !workspaceMatches(viewedResolved.row.workspace_uris, targetWorkspaceUris);
        if (viewedOutOfWorkspace && conversationId) {
          const convResolved = resolveRootMainSession(conversationId, {
            ...options,
            appDataDir,
            dbPath,
            transcriptReader: reader,
          });
          if (
            convResolved &&
            !convResolved.row?.killed &&
            workspaceMatches(convResolved.row?.workspace_uris, targetWorkspaceUris)
          ) {
            return formatResolvedTarget(convResolved, {
              appDataDir,
              dbPath,
              activeLocks,
              mode: 'current',
              platform,
            });
          }
        }
        return formatResolvedTarget(viewedResolved, {
          appDataDir,
          dbPath,
          activeLocks,
          mode: 'current',
          platform,
        });
      }
      precomputedViewedResolved = viewedResolved;
    }

    if (conversationId) {
      const resolved = resolveRootMainSession(conversationId, {
        ...options,
        appDataDir,
        dbPath,
        transcriptReader: reader,
      });
      if (resolved) {
        return formatResolvedTarget(resolved, {
          appDataDir,
          dbPath,
          activeLocks,
          mode: 'current',
          platform,
        });
      }
    }
  }

  // 'auto' mode (or fallthrough from unresolvable 'current' / orphan child in 'pinned')
  let viewedResolved = precomputedViewedResolved;
  if (mode === 'auto') {
    const viewed = readLatestViewedSession({
      appDataDir,
      dataDir: options.dataDir,
      eventsDir: options.eventsDir,
      workspaceUris: targetWorkspaceUris,
      activeLocks,
      locksPath: options.locksPath,
      dbPath,
      platform,
      nowMs: options.nowMs,
      win32RecencyMs: options.win32RecencyMs,
      probeWin32Lock: options.probeWin32Lock,
    });
    if (viewed?.id) {
      viewedResolved = resolveRootMainSession(viewed.id, {
        ...options,
        appDataDir,
        dbPath,
        transcriptReader: reader,
      });
    }
  }
  const latestViewedMainId =
    viewedResolved && !viewedResolved.row?.killed ? viewedResolved.id : null;

  const sqliteTarget = withReadOnlyDb(
    dbPath,
    (db) => {
      const rows = db
        .prepare(
          `SELECT conversation_id, title, last_modified_time, workspace_uris,
                  status, not_fully_idle, killed
           FROM conversation_summaries
           WHERE (parent_conversation_id IS NULL OR parent_conversation_id = '')
             AND (nesting_depth IS NULL OR nesting_depth = 0)
             AND (agent_name IS NULL OR agent_name = '')
             AND (killed IS NULL OR killed = 0)
           ORDER BY last_modified_time DESC
           LIMIT 50`
        )
        .all();

      if (rows.length > 0) {
        const wsMatchingRows = hasWorkspaceFilter
          ? rows.filter((r) => workspaceMatches(r.workspace_uris, targetWorkspaceUris))
          : [];
        const candidateRows = wsMatchingRows.length > 0 ? wsMatchingRows : rows;
        const activeChildCounts = getActiveChildCountsMap(db);
        let best = null;
        let bestScore = -1;
        for (const row of candidateRows) {
          const isLatestViewed = Boolean(
            latestViewedMainId && row.conversation_id === latestViewedMainId
          );
          const isActiveLock = activeLocks.has(row.conversation_id);
          const wsMatch = workspaceMatches(row.workspace_uris, targetWorkspaceUris);
          const activeChildCount = activeChildCounts.get(row.conversation_id) || 0;
          const running = row.status === 'CASCADE_RUN_STATUS_RUNNING';
          const notIdle = Boolean(row.not_fully_idle);
          const score =
            (wsMatch ? 32 : 0) +
            (isActiveLock ? 16 : 0) +
            (activeChildCount > 0 ? 8 : 0) +
            (running ? 6 : 0) +
            (isLatestViewed ? 4 : 0) +
            (notIdle ? 2 : 0);
          if (score > bestScore) {
            bestScore = score;
            best = row;
          }
        }
        if (best) {
          return {
            type: 'best',
            best,
            activeChildCount: activeChildCounts.get(best.conversation_id) || 0,
          };
        }
      }
      return null;
    },
    { platform }
  );

  if (sqliteTarget?.type === 'best') {
    const { best, activeChildCount } = sqliteTarget;
    const trPath = transcriptPathFor(appDataDir, best.conversation_id);
    const isActiveLock = activeLocks.has(best.conversation_id);
    return {
      id: best.conversation_id,
      title: (best.title && best.title.trim()) || '',
      workspace: workspaceBasename(best.workspace_uris),
      status:
        best.status ||
        (isActiveLock ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE'),
      isActiveLock,
      activeChildCount,
      discoverySource: 'sqlite',
      resolvedFromChildId: null,
      trackingMode: mode === 'auto' ? 'auto' : (mode === 'pinned' ? 'pinned' : 'current'),
      lastModified: toIsoTimestamp(best.last_modified_time),
      transcriptPath: trPath,
    };
  }

  const sessions = listMainSessionsFromFilesystem({
    appDataDir,
    limit: 25,
    activeLocks,
    reader,
    settings,
  });
  if (sessions.length === 0) return null;

  const picked =
    mode === 'auto'
      ? sessions.find((s) => s.isActiveLock) ||
        (latestViewedMainId && sessions.find((s) => s.id === latestViewedMainId)) ||
        sessions[0]
      : (latestViewedMainId && sessions.find((s) => s.id === latestViewedMainId)) ||
        sessions.find((s) => s.isActiveLock) ||
        sessions[0];
  return {
    ...picked,
    discoverySource: 'fs_fallback',
    resolvedFromChildId: null,
    trackingMode: mode === 'auto' ? 'auto' : (mode === 'pinned' ? 'pinned' : 'current'),
    transcriptPath: transcriptPathFor(appDataDir, picked.id),
  };
}
