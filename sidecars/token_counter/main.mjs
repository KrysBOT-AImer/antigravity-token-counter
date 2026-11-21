import { existsSync, readFileSync, realpathSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  closeCachedDbs,
  findAppDataDir,
  getDiscoverySource,
  listMainSessionsWithMeta,
  resolveEventsDir,
  resolveTargetSession,
} from './lib/discovery.mjs';
import {
  clearGenMetadataCache,
  readSessionModelFromGenMetadata,
} from './lib/gen_metadata.mjs';
import {
  deriveOrchestratorTelemetry,
  isOrchestratorPluginEnabled,
  readLastKnownOrchestratorThresholds,
  readOrchestratorTelemetry,
  resolveOrchestratorTelemetryDir,
} from './lib/orchestrator_telemetry.mjs';
import {
  createSettingsStore,
  DEFAULT_MODEL_PROFILE,
  MODEL_PROFILES,
  resolveEffectiveThresholds,
} from './lib/settings.mjs';
import { computeMetrics, createTranscriptReader } from './lib/transcript.mjs';

let SidecarApp, Response;
try {
  ({ SidecarApp, Response } = await import('sidecar_sdk'));
} catch {
  const sdkPath = join(
    process.env.ANTIGRAVITY_LIB_DIR || join(homedir(), '.gemini', 'antigravity', 'lib'),
    'node_modules',
    'sidecar_sdk',
    'index.mjs'
  );
  ({ SidecarApp, Response } = await import(pathToFileURL(sdkPath).href));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_UI_DIR = join(__dirname, 'ui');

function serveUiFile(uiDir, filename, contentType) {
  const filePath = join(uiDir, filename);
  if (!existsSync(filePath)) {
    return new Response(`Missing UI asset: ${filename}`, {
      status: 404,
      contentType: 'text/plain; charset=utf-8',
    });
  }
  try {
    const body = readFileSync(filePath, 'utf-8');
    return new Response(body, { status: 200, contentType });
  } catch (err) {
    return new Response(`Failed to read UI asset: ${err.message}`, {
      status: 500,
      contentType: 'text/plain; charset=utf-8',
    });
  }
}

function parseWorkspaceUrisParam(data) {
  if (Array.isArray(data.workspaceUris)) {
    return data.workspaceUris.filter((u) => typeof u === 'string' && u.trim());
  }
  if (typeof data.workspaceUris === 'string' && data.workspaceUris.trim()) {
    try {
      const parsed = JSON.parse(data.workspaceUris);
      if (Array.isArray(parsed)) {
        return parsed.filter((u) => typeof u === 'string' && u.trim());
      }
    } catch {
      // fall back to workspaceUri below
    }
  }
  if (typeof data.workspaceUri === 'string' && data.workspaceUri.trim()) {
    return [data.workspaceUri.trim()];
  }
  return [];
}

/**
 * Watch Antigravity annotation/events directories with debouncing and expose a
 * long-poll `waitForChange(since, timeoutMs)` API for instant UI updates.
 */
function createViewWatcher({ appDataDir, dataDir, eventsDir, debounceMs = 40 } = {}) {
  const dirs = new Set();
  if (appDataDir) dirs.add(join(appDataDir, 'annotations'));
  const resolvedEventsDir = resolveEventsDir({ appDataDir, dataDir, eventsDir });
  if (resolvedEventsDir) dirs.add(resolvedEventsDir);

  const watchers = [];
  const waiters = new Set();
  let revision = 0;
  let debounceTimer = null;
  let closed = false;

  const resolveWaiter = (waiter, payload) => {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve(payload);
  };

  const scheduleBump = () => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (closed) return;
      revision += 1;
      const payload = { changed: true, revision, watching: true };
      for (const waiter of [...waiters]) {
        resolveWaiter(waiter, payload);
      }
    }, debounceMs);
  };

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const w = watch(dir, { persistent: false }, () => scheduleBump());
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      // Missing dir or OS inotify limit: fail soft, polling fallback remains active
    }
  }

  const otelDir = resolveOrchestratorTelemetryDir(appDataDir);
  let otelWatched = false;
  const attachOtelWatcher = () => {
    if (closed || otelWatched || !otelDir || !existsSync(otelDir)) return false;
    try {
      const w = watch(otelDir, { persistent: false }, () => scheduleBump());
      w.on('error', () => {});
      watchers.push(w);
      otelWatched = true;
      return true;
    } catch {
      return false;
    }
  };

  if (otelDir) {
    if (existsSync(otelDir)) {
      attachOtelWatcher();
    } else {
      const otelParentDir = dirname(otelDir);
      if (existsSync(otelParentDir)) {
        try {
          const parentW = watch(otelParentDir, { persistent: false }, (_eventType, filename) => {
            if (closed || otelWatched) return;
            if ((!filename || filename === 'orchestrator_telemetry') && existsSync(otelDir)) {
              if (attachOtelWatcher()) {
                scheduleBump();
              }
            }
          });
          parentW.on('error', () => {});
          watchers.push(parentW);
        } catch {
          // Fail open on watch errors
        }
      }
    }
  }

  const active = watchers.length > 0;

  function waitForChange(since = 0, timeoutMs = 15000) {
    if (closed) {
      return Promise.resolve({ changed: false, revision, watching: false, closed: true });
    }
    if (revision > since) {
      return Promise.resolve({ changed: true, revision, watching: active });
    }
    if (!active) {
      return Promise.resolve({ changed: false, revision, watching: false });
    }
    const clampedTimeout = Math.min(25000, Math.max(50, Math.floor(timeoutMs)));
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null, settled: false };
      waiter.timer = setTimeout(() => {
        resolveWaiter(waiter, { changed: false, revision, watching: true });
      }, clampedTimeout);
      waiters.add(waiter);
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // ignore close errors
      }
    }
    watchers.length = 0;
    const payload = { changed: false, revision, watching: false, closed: true };
    for (const waiter of [...waiters]) {
      resolveWaiter(waiter, payload);
    }
  }

  return { waitForChange, close };
}

/**
 * Create and configure the Token Counter SidecarApp instance.
 * Accepts optional overrides for testing (`appDataDir`, `dataDir`, `uiDir`, `locksPath`).
 */
export function createServerApp(options = {}) {
  const app = new SidecarApp();
  const uiDir = options.uiDir || DEFAULT_UI_DIR;
  const settingsStore =
    options.settingsStore || createSettingsStore({ dataDir: options.dataDir });
  const transcriptReader = options.transcriptReader || createTranscriptReader();
  const discoveryOpts = {
    appDataDir: options.appDataDir,
    dataDir:
      options.dataDir ??
      (options.appDataDir ? undefined : process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR),
    eventsDir: options.eventsDir,
    dbPath: options.dbPath,
    locksPath: options.locksPath,
    platform: options.platform,
    transcriptReader,
  };
  const viewWatcher = createViewWatcher({
    appDataDir: findAppDataDir(discoveryOpts),
    dataDir: discoveryOpts.dataDir,
    eventsDir: discoveryOpts.eventsDir,
  });

  app.page('/', () => serveUiFile(uiDir, 'index.html', 'text/html; charset=utf-8'));
  app.api(
    '/styles.css',
    () => serveUiFile(uiDir, 'styles.css', 'text/css; charset=utf-8'),
    'GET'
  );
  app.api(
    '/app.js',
    () => serveUiFile(uiDir, 'app.js', 'application/javascript; charset=utf-8'),
    'GET'
  );

  app.api(
    '/api/metrics',
    (data) => {
      const settings = settingsStore.get();
      const mode =
        data.mode === 'auto' || data.mode === 'pinned' || data.mode === 'current'
          ? data.mode
          : settings.trackingMode;
      const requestedConvId =
        typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
      const conversationId =
        mode === 'pinned'
          ? requestedConvId || settings.pinnedSessionId || ''
          : requestedConvId || app.config.conversationId || '';
      const workspaceUris = parseWorkspaceUrisParam(data);

      const target = resolveTargetSession({
        ...discoveryOpts,
        conversationId,
        mode,
        workspaceUris,
        settings,
      });

      if (!target) {
        const discoverySource = getDiscoverySource(discoveryOpts);
        const etag = `none|${mode}|${conversationId}|${discoverySource}|${settingsStore.version()}`;
        if (data.etag && data.etag === etag) {
          return { unchanged: true, etag };
        }
        return {
          unchanged: false,
          etag,
          settings,
          effectiveThresholds: resolveEffectiveThresholds('', settings),
          discoverySource,
          session: null,
          metrics: computeMetrics(null, settings).metrics,
          series: [],
          compactions: [],
          orchestrator: null,
        };
      }

      const appDataDir = findAppDataDir(discoveryOpts);
      const genMeta = appDataDir ? readSessionModelFromGenMetadata(appDataDir, target.id) : null;
      const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
      const otel = appDataDir
        ? readOrchestratorTelemetry(appDataDir, target.id, {
            nowMs,
            maxAgeMs: options.telemetryMaxAgeMs,
          })
        : null;
      const orchPluginEnabled = appDataDir ? isOrchestratorPluginEnabled(appDataDir) : false;
      const discoverySource = target.discoverySource || 'sqlite';
      const activeChildCount = target.activeChildCount ?? 0;
      const st = target.transcriptPath ? transcriptReader.stat(target.transcriptPath) : null;
      const TRANSCRIPT_SKEW_GRACE_MS = 2000;
      const otelTsMs = otel ? Date.parse(otel.timestamp) : NaN;
      const guardPredatesTranscript = Boolean(
        otel &&
          st &&
          Number.isFinite(otelTsMs) &&
          st.mtimeMs <= nowMs + TRANSCRIPT_SKEW_GRACE_MS &&
          st.mtimeMs > otelTsMs + TRANSCRIPT_SKEW_GRACE_MS
      );
      const otelSig = [
        otel
          ? `${otel.timestamp}:${otel.active_tokens}:${otel.zone}:${otel.fork_eligible ? 1 : 0}:${otel.compact_recommended ? 1 : 0}`
          : 'none',
        orchPluginEnabled ? '1' : '0',
        guardPredatesTranscript ? '1' : '0',
      ].join(':');
      const fileSig = st ? `${st.mtimeMs}:${st.size}` : '0:-1';
      const etag = [
        target.id,
        target.resolvedFromChildId || '',
        target.trackingMode,
        target.status,
        target.isActiveLock ? '1' : '0',
        discoverySource,
        activeChildCount,
        fileSig,
        genMeta?.cacheSig || '',
        otelSig,
        settingsStore.version(),
      ].join('|');

      if (data.etag && data.etag === etag) {
        return { unchanged: true, etag };
      }

      const parsed = target.transcriptPath
        ? transcriptReader.readTranscript(target.transcriptPath)
        : null;
      const derived = computeMetrics(parsed, settings, {
        fallbackModel: genMeta?.model || '',
        modelSource: genMeta?.model ? 'gen_metadata' : 'none',
      });
      const title = target.title || derived.firstUserPrompt || target.id.slice(0, 8);

      let orchestrator = null;
      if (otel && !guardPredatesTranscript) {
        orchestrator = otel;
      } else if (orchPluginEnabled) {
        const lastThresholds =
          otel?.thresholds ||
          (appDataDir ? readLastKnownOrchestratorThresholds(appDataDir, target.id) : null);
        orchestrator = deriveOrchestratorTelemetry(target.id, derived.metrics.contextTokens, {
          thresholds: lastThresholds,
          timestamp: st?.mtimeMs
            ? new Date(st.mtimeMs).toISOString()
            : new Date(nowMs).toISOString(),
          nowMs,
        });
      }

      return {
        unchanged: false,
        etag,
        settings,
        effectiveThresholds: derived.effectiveThresholds,
        discoverySource,
        session: {
          id: target.id,
          title,
          workspace: target.workspace,
          status: target.status,
          isActiveLock: Boolean(target.isActiveLock),
          discoverySource,
          activeChildCount,
          resolvedFromChildId: target.resolvedFromChildId || null,
          trackingMode: target.trackingMode,
          lastModified: target.lastModified,
        },
        metrics: derived.metrics,
        series: derived.series,
        compactions: derived.compactions,
        orchestrator,
      };
    },
    'GET'
  );

  app.api(
    '/api/sessions',
    (data) => {
      const settings = settingsStore.get();
      const workspaceUris = parseWorkspaceUrisParam(data);
      const limit = data.limit ? Number(data.limit) : 25;
      const { sessions, discoverySource } = listMainSessionsWithMeta({
        ...discoveryOpts,
        workspaceUris,
        limit,
        settings,
      });
      return { sessions, discoverySource };
    },
    'GET'
  );

  app.api(
    '/api/settings',
    () => ({
      settings: settingsStore.get(),
      modelProfiles: MODEL_PROFILES,
      defaultProfile: DEFAULT_MODEL_PROFILE,
    }),
    'GET'
  );

  app.api(
    '/api/settings',
    (data) => {
      const patch = {};
      if (data.thresholdMode !== undefined) patch.thresholdMode = data.thresholdMode;
      if (data.cautionThreshold !== undefined) patch.cautionThreshold = data.cautionThreshold;
      if (data.dumbZoneThreshold !== undefined) patch.dumbZoneThreshold = data.dumbZoneThreshold;
      if (data.gaugeCeiling !== undefined) patch.gaugeCeiling = data.gaugeCeiling;
      if (data.trackingMode !== undefined) patch.trackingMode = data.trackingMode;
      if (data.pinnedSessionId !== undefined) patch.pinnedSessionId = data.pinnedSessionId;

      const result = settingsStore.update(patch);
      if (!result.ok) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: 400,
          contentType: 'application/json',
        });
      }
      return {
        settings: result.settings,
        modelProfiles: MODEL_PROFILES,
        defaultProfile: DEFAULT_MODEL_PROFILE,
      };
    },
    'POST'
  );

  app.api(
    '/api/watch',
    async (data) => {
      const since =
        data.since !== undefined && data.since !== '' && Number.isFinite(Number(data.since))
          ? Math.max(0, Math.floor(Number(data.since)))
          : 0;
      const timeoutMs =
        data.timeoutMs !== undefined &&
        data.timeoutMs !== '' &&
        Number.isFinite(Number(data.timeoutMs))
          ? Math.min(25000, Math.max(50, Math.floor(Number(data.timeoutMs))))
          : 15000;
      return await viewWatcher.waitForChange(since, timeoutMs);
    },
    'GET'
  );

  const origClose = app.close.bind(app);
  app.close = async () => {
    viewWatcher.close();
    // Allow unblocked /api/watch handlers to flush res.end() before server.close()
    // so Node's closeIdleConnections() sees the socket as idle instead of waiting keepAliveTimeout.
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await origClose();
    } finally {
      closeCachedDbs();
      clearGenMetadataCache();
    }
  };

  return app;
}

function isEntrypoint() {
  try {
    if (!process.argv[1]) return false;
    const real = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync;
    const argvPath = real(process.argv[1]);
    const selfPath = real(fileURLToPath(import.meta.url));
    if (process.platform === 'win32') {
      return argvPath.toLowerCase() === selfPath.toLowerCase();
    }
    return argvPath === selfPath;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const app = createServerApp();
  app.run();
}
