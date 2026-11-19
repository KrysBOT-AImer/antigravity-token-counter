import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { DEFAULT_SETTINGS, isInternalWorkerModel, resolveEffectiveThresholds } from './settings.mjs';

const COMPACTION_PREFIX = '# Resuming from a compaction';
const CHILD_SYSTEM_SIGNATURES = [
  "Everything before this turn is @coordinator's memory",
  'You have just started. Your assignment (recorded on the board as #',
  'Message from Parent Agent',
  '<subagent_reminder>',
  '<swarm_worker>',
  '<fork_notice>',
];
const MAX_SERIES_POINTS = 500;
const TAIL_VERBATIM_POINTS = 250;
const MAX_TITLE_LEN = 64;
const MAX_CACHE_ENTRIES = 200;
const SETTINGS_CHANGE_BLOCK_RE = /<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/g;
const MODEL_SELECTION_NO_COMMENT_RE =
  /The user changed setting `Model Selection` from .+? to (.+?)\.\s+No need to comment/;
const MODEL_SELECTION_LINE_END_RE =
  /The user changed setting `Model Selection` from .+? to (.+?)\.\s*$/;

/**
 * Extract the selected model name from `<USER_SETTINGS_CHANGE>` blocks inside USER_INPUT content.
 * Returns the last non-empty value (ignoring `'None'`), or `''` if absent.
 */
export function extractModelFromSettingsChange(content) {
  if (typeof content !== 'string' || !content.includes('<USER_SETTINGS_CHANGE>')) {
    return '';
  }

  let lastModel = '';
  SETTINGS_CHANGE_BLOCK_RE.lastIndex = 0;
  let blockMatch;
  while ((blockMatch = SETTINGS_CHANGE_BLOCK_RE.exec(content)) !== null) {
    const block = blockMatch[1];
    for (const line of block.split(/\r?\n/)) {
      const m =
        MODEL_SELECTION_NO_COMMENT_RE.exec(line) || MODEL_SELECTION_LINE_END_RE.exec(line);
      if (!m) continue;
      const candidate = m[1].trim();
      if (!candidate || candidate.toLowerCase() === 'none') continue;
      lastModel = candidate;
    }
  }
  return lastModel;
}

export function isParsedChild(state) {
  if (!state) return false;
  return Boolean(
    state.hasChildSystemSignature ||
      (!state.hasExplicitUserInput && state.hasSystemMessage && (state.series?.length || 0) > 0)
  );
}

function createEmptyState() {
  return {
    series: [],
    compactions: [],
    lastModel: '',
    modelSource: 'none',
    lastTimestamp: null,
    pendingCompactionIndex: null,
    postCompactionPending: false,
    epochStartSeriesIndex: 0,
    peakCurrentEpoch: 0,
    peakAllTime: 0,
    firstUserPrompt: '',
    hasExplicitUserInput: false,
    hasSystemMessage: false,
    hasChildSystemSignature: false,
    isChildTranscript: false,
    linesProcessed: 0,
  };
}

function cloneState(state) {
  return {
    series: state.series.slice(),
    compactions: state.compactions.map((c) => ({ ...c })),
    lastModel: state.lastModel,
    modelSource: state.modelSource || 'none',
    lastTimestamp: state.lastTimestamp,
    pendingCompactionIndex: state.pendingCompactionIndex,
    postCompactionPending: state.postCompactionPending,
    epochStartSeriesIndex: state.epochStartSeriesIndex,
    peakCurrentEpoch: state.peakCurrentEpoch,
    peakAllTime: state.peakAllTime,
    firstUserPrompt: state.firstUserPrompt,
    hasExplicitUserInput: Boolean(state.hasExplicitUserInput),
    hasSystemMessage: Boolean(state.hasSystemMessage),
    hasChildSystemSignature: Boolean(state.hasChildSystemSignature),
    isChildTranscript: Boolean(state.isChildTranscript),
    linesProcessed: state.linesProcessed,
  };
}

function cleanUserPrompt(content) {
  if (typeof content !== 'string') return '';
  let text = content
    .replace(/<\/?USER_REQUEST>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length > MAX_TITLE_LEN) {
    text = `${text.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…`;
  }
  return text;
}

function applyStep(state, step) {
  if (!step || typeof step !== 'object') return;
  const lineIndex = state.linesProcessed;
  state.linesProcessed += 1;

  if (typeof step.created_at === 'string' && step.created_at) {
    state.lastTimestamp = step.created_at;
  }

  if (step.type === 'SYSTEM_MESSAGE' || step.source === 'SYSTEM') {
    if (step.type === 'SYSTEM_MESSAGE' || step.type !== 'CHECKPOINT') {
      state.hasSystemMessage = true;
    }
    if (!state.hasChildSystemSignature && typeof step.content === 'string') {
      for (const marker of CHILD_SYSTEM_SIGNATURES) {
        if (step.content.includes(marker)) {
          state.hasChildSystemSignature = true;
          break;
        }
      }
    }
  }

  if (step.type === 'USER_INPUT') {
    if (step.source === 'USER_EXPLICIT') {
      state.hasExplicitUserInput = true;
    }
    if (typeof step.content === 'string') {
      if (!state.firstUserPrompt) {
        const cleaned = cleanUserPrompt(step.content);
        if (cleaned) {
          state.firstUserPrompt = cleaned;
        }
      }
      const detectedModel = extractModelFromSettingsChange(step.content);
      if (detectedModel) {
        state.lastModel = detectedModel;
        state.modelSource = 'settings_change';
      }
    }
  } else if (
    step.type === 'CHECKPOINT' &&
    step.source === 'SYSTEM' &&
    typeof step.content === 'string' &&
    step.content.trimStart().startsWith(COMPACTION_PREFIX)
  ) {
    const prevPoint = state.series.length > 0 ? state.series[state.series.length - 1] : null;
    const stepIndex = Number.isFinite(step.step_index) ? step.step_index : lineIndex;
    const ts = typeof step.created_at === 'string' ? step.created_at : null;
    state.compactions.push({
      stepIndex,
      ts,
      preContext: prevPoint ? prevPoint.contextTokens : 0,
      postContext: null,
    });
    state.pendingCompactionIndex = state.compactions.length - 1;
    state.postCompactionPending = true;
    state.peakCurrentEpoch = 0;
  } else if (step.type === 'PLANNER_RESPONSE') {
    const stepModel = typeof step.model === 'string' ? step.model.trim() : '';
    if (stepModel) {
      const preserveParent =
        isInternalWorkerModel(stepModel) &&
        Boolean(state.lastModel) &&
        !isInternalWorkerModel(state.lastModel);
      if (!preserveParent) {
        state.lastModel = stepModel;
        state.modelSource = 'transcript';
      }
    }

    const hasInput = Number.isFinite(step.input_tokens);
    const hasCacheRead = Number.isFinite(step.cache_read_tokens);
    if (hasInput || hasCacheRead) {
      const uncachedInput = hasInput ? step.input_tokens : 0;
      const cacheRead = hasCacheRead ? step.cache_read_tokens : 0;
      const outputTokens = Number.isFinite(step.output_tokens) ? step.output_tokens : 0;
      const contextTokens = uncachedInput + cacheRead;

      const prevPoint = state.series.length > 0 ? state.series[state.series.length - 1] : null;
      const delta = prevPoint ? contextTokens - prevPoint.contextTokens : 0;
      const stepIndex = Number.isFinite(step.step_index) ? step.step_index : lineIndex;
      const ts = typeof step.created_at === 'string' ? step.created_at : null;

      state.series.push({
        stepIndex,
        ts,
        contextTokens,
        uncachedInput,
        cacheRead,
        outputTokens,
        delta,
        model: state.lastModel,
      });

      if (contextTokens > state.peakAllTime) {
        state.peakAllTime = contextTokens;
      }

      if (state.pendingCompactionIndex !== null) {
        const compaction = state.compactions[state.pendingCompactionIndex];
        if (compaction) {
          compaction.postContext = contextTokens;
        }
        state.pendingCompactionIndex = null;
        state.postCompactionPending = false;
        state.epochStartSeriesIndex = state.series.length - 1;
        state.peakCurrentEpoch = contextTokens;
      } else if (contextTokens > state.peakCurrentEpoch) {
        state.peakCurrentEpoch = contextTokens;
      }
    }
  }

  state.isChildTranscript = isParsedChild(state);
}

/**
 * Downsample long series while preserving compaction boundaries and the latest 250 steps verbatim.
 */
export function downsampleSeries(series, compactions = [], maxPoints = MAX_SERIES_POINTS) {
  if (series.length <= maxPoints) return series;

  const tailStart = Math.max(0, series.length - TAIL_VERBATIM_POINTS);
  const mandatoryIndices = new Set();
  if (tailStart > 0) {
    mandatoryIndices.add(0);
  }

  for (const c of compactions) {
    if (!c || !Number.isFinite(c.stepIndex)) continue;
    if (tailStart > 0 && tailStart < series.length && c.stepIndex > series[tailStart].stepIndex) {
      continue;
    }
    let preIdx = -1;
    let postIdx = -1;
    for (let i = 0; i < tailStart; i++) {
      if (series[i].stepIndex < c.stepIndex) {
        preIdx = i;
      } else if (postIdx === -1) {
        postIdx = i;
      }
    }
    if (preIdx >= 0) mandatoryIndices.add(preIdx);
    if (postIdx >= 0) mandatoryIndices.add(postIdx);
  }

  for (let i = 0; i < tailStart; i++) {
    if (series[i].delta < -10000) {
      mandatoryIndices.add(i);
      if (i > 0) mandatoryIndices.add(i - 1);
    }
  }

  const headBudget = Math.max(2, maxPoints - TAIL_VERBATIM_POINTS);
  let selectedIndices;
  if (mandatoryIndices.size > headBudget) {
    const sortedMandatory = [...mandatoryIndices].sort((a, b) => a - b);
    const withoutZero = sortedMandatory.filter((idx) => idx !== 0);
    const keepTail = withoutZero.slice(-(headBudget - 1));
    selectedIndices = new Set(tailStart > 0 ? [0, ...keepTail] : keepTail);
  } else {
    selectedIndices = new Set(mandatoryIndices);
    const remaining = headBudget - selectedIndices.size;
    if (remaining > 0 && tailStart > 1) {
      const available = [];
      for (let i = 1; i < tailStart; i++) {
        if (!selectedIndices.has(i)) {
          available.push(i);
        }
      }
      if (available.length <= remaining) {
        for (const idx of available) selectedIndices.add(idx);
      } else {
        for (let k = 0; k < remaining; k++) {
          const pickPos = Math.floor(((k + 0.5) * available.length) / remaining);
          selectedIndices.add(available[pickPos]);
        }
      }
    }
  }

  const head = [...selectedIndices]
    .sort((a, b) => a - b)
    .map((idx) => series[idx]);

  return head.concat(series.slice(tailStart));
}

/**
 * Derive dashboard metrics and zone classification from a parsed transcript state + settings.
 */
export function computeMetrics(parsed, settings = DEFAULT_SETTINGS, options = {}) {
  const s = settings || DEFAULT_SETTINGS;
  const state = parsed || createEmptyState();
  const series = state.series || [];
  const compactions = state.compactions || [];
  const last = series.length > 0 ? series[series.length - 1] : null;

  const contextTokens = last ? last.contextTokens : 0;
  const uncachedInput = last ? last.uncachedInput : 0;
  const cacheRead = last ? last.cacheRead : 0;
  const outputTokens = last ? last.outputTokens : 0;
  const cacheHitRate = contextTokens > 0 ? cacheRead / contextTokens : 0;
  const delta = last ? last.delta : 0;

  const stateModel = typeof state.lastModel === 'string' ? state.lastModel.trim() : '';
  const fallbackModel =
    options && typeof options.fallbackModel === 'string' ? options.fallbackModel.trim() : '';
  const resolvedFallbackSource =
    options && typeof options.modelSource === 'string' && options.modelSource !== 'none'
      ? options.modelSource
      : 'gen_metadata';

  let model = '';
  let modelSource = 'none';
  if (
    stateModel &&
    !(isInternalWorkerModel(stateModel) && fallbackModel && !isInternalWorkerModel(fallbackModel))
  ) {
    model = stateModel;
    modelSource =
      state.modelSource === 'settings_change' || state.modelSource === 'transcript'
        ? state.modelSource
        : 'transcript';
  } else if (fallbackModel) {
    model = fallbackModel;
    modelSource = resolvedFallbackSource;
  }

  const effective = resolveEffectiveThresholds(model, s);

  let zone = 'safe';
  if (contextTokens >= effective.dumbZoneThreshold) {
    zone = 'dumb';
  } else if (contextTokens >= effective.cautionThreshold) {
    zone = 'caution';
  }

  const pctOfDumbZone =
    effective.dumbZoneThreshold > 0
      ? Math.round((contextTokens / effective.dumbZoneThreshold) * 1000) / 10
      : 0;
  const headroomToDumbZone = effective.dumbZoneThreshold - contextTokens;
  const overLimitBy = Math.max(0, contextTokens - effective.dumbZoneThreshold);

  const epochSeries = series.slice(state.epochStartSeriesIndex || 0);
  const recentEpochTurns = epochSeries.slice(1).slice(-5);
  const positiveDeltas = recentEpochTurns.map((p) => p.delta).filter((d) => d > 0);
  const avgDeltaPerTurn =
    positiveDeltas.length > 0
      ? Math.round(positiveDeltas.reduce((acc, d) => acc + d, 0) / positiveDeltas.length)
      : 0;

  const estimatedTurnsToDumbZone =
    contextTokens >= effective.dumbZoneThreshold || avgDeltaPerTurn <= 0
      ? null
      : Math.ceil((effective.dumbZoneThreshold - contextTokens) / avgDeltaPerTurn);

  return {
    metrics: {
      contextTokens,
      uncachedInput,
      cacheRead,
      outputTokens,
      cacheHitRate,
      delta,
      zone,
      pctOfDumbZone,
      headroomToDumbZone,
      overLimitBy,
      profileId: effective.profileId,
      profileLabel: effective.profileLabel,
      thresholdSource: effective.source,
      model,
      modelSource,
      stepCount: series.length,
      lastStepIndex: last ? last.stepIndex : null,
      lastUpdated: (last && last.ts) || state.lastTimestamp || null,
      postCompactionPending: Boolean(state.postCompactionPending),
      compactionCount: compactions.length,
      lastCompaction: compactions.length > 0 ? { ...compactions[compactions.length - 1] } : null,
      avgDeltaPerTurn,
      estimatedTurnsToDumbZone,
      peakCurrentEpoch: state.peakCurrentEpoch || 0,
      peakAllTime: state.peakAllTime || 0,
    },
    effectiveThresholds: effective,
    series: downsampleSeries(series, compactions),
    compactions: compactions.map((c) => ({ ...c })),
    firstUserPrompt: state.firstUserPrompt || '',
    isChildTranscript: isParsedChild(state),
  };
}

function readSlice(filePath, start, end) {
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(filePath, 'r');
  try {
    let total = 0;
    while (total < len) {
      const n = readSync(fd, buf, total, len - total, start + total);
      if (n === 0) break;
      total += n;
    }
    return total === len ? buf : buf.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

const HEAD_FINGERPRINT_BYTES = 64;

function readHeadFingerprint(filePath, size) {
  const len = Math.min(HEAD_FINGERPRINT_BYTES, size);
  if (len <= 0) return '';
  return readSlice(filePath, 0, len).toString('hex');
}

/**
 * Create an incremental transcript reader with an internal per-path LRU cache.
 */
export function createTranscriptReader({
  maxCacheEntries = MAX_CACHE_ENTRIES,
  statFn = (p) => statSync(p, { bigint: true }),
} = {}) {
  const cache = new Map(); // path -> { ino, size, mtimeNs, birthtimeNs, headFingerprint, offset, state, viewState }
  const cacheLimit = Math.max(1, Number(maxCacheEntries) || MAX_CACHE_ENTRIES);

  function readStat(filePath) {
    const st = statFn(filePath);
    return {
      ino: BigInt(st.ino ?? 0),
      size: Number(st.size),
      mtimeNs: BigInt(st.mtimeNs ?? Math.round((st.mtimeMs || 0) * 1e6)),
      birthtimeNs: BigInt(st.birthtimeNs ?? Math.round((st.birthtimeMs || 0) * 1e6)),
      mtimeMs: st.mtimeNs !== undefined ? Number(st.mtimeNs / 1_000_000n) : Number(st.mtimeMs || 0),
    };
  }

  function touchCache(filePath, entry) {
    cache.delete(filePath);
    cache.set(filePath, entry);
    while (cache.size > cacheLimit) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
  }

  function readTranscript(filePath) {
    let st;
    try {
      st = readStat(filePath);
    } catch {
      cache.delete(filePath);
      return null;
    }

    const hit = cache.get(filePath);
    if (
      hit &&
      hit.ino === st.ino &&
      hit.size === st.size &&
      hit.mtimeNs === st.mtimeNs &&
      (st.ino !== 0n || hit.birthtimeNs === st.birthtimeNs)
    ) {
      touchCache(filePath, hit);
      return hit.viewState;
    }

    let canResume = Boolean(
      hit &&
      hit.ino === st.ino &&
      st.size >= hit.size &&
      hit.offset <= st.size
    );
    let headFingerprint = '';

    if (st.ino === 0n) {
      if (canResume) {
        if (hit.birthtimeNs !== st.birthtimeNs) {
          canResume = false;
        } else if (hit.headFingerprint) {
          try {
            const prefixLen = hit.headFingerprint.length / 2;
            const currentHead = readSlice(filePath, 0, prefixLen).toString('hex');
            if (currentHead !== hit.headFingerprint) {
              canResume = false;
            } else {
              headFingerprint =
                prefixLen < HEAD_FINGERPRINT_BYTES && st.size > prefixLen
                  ? readHeadFingerprint(filePath, st.size)
                  : hit.headFingerprint;
            }
          } catch {
            canResume = false;
          }
        }
      }
      if (!headFingerprint && st.size > 0) {
        try {
          headFingerprint = readHeadFingerprint(filePath, st.size);
        } catch {
          cache.delete(filePath);
          return null;
        }
      }
    }

    let entry;
    if (canResume) {
      entry = {
        ino: st.ino,
        size: st.size,
        mtimeNs: st.mtimeNs,
        birthtimeNs: st.birthtimeNs,
        headFingerprint,
        offset: hit.offset,
        state: hit.state,
        viewState: null,
      };
    } else {
      entry = {
        ino: st.ino,
        size: st.size,
        mtimeNs: st.mtimeNs,
        birthtimeNs: st.birthtimeNs,
        headFingerprint,
        offset: 0,
        state: createEmptyState(),
        viewState: null,
      };
    }

    if (st.size > entry.offset) {
      let chunk;
      try {
        chunk = readSlice(filePath, entry.offset, st.size);
      } catch {
        cache.delete(filePath);
        return null;
      }
      const lastNewline = chunk.lastIndexOf(0x0a);

      if (lastNewline >= 0) {
        const completeBuf = chunk.subarray(0, lastNewline);
        const text = completeBuf.toString('utf-8');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const step = JSON.parse(trimmed);
            applyStep(entry.state, step);
          } catch {
            // Skip malformed historical lines safely
          }
        }
        entry.offset += lastNewline + 1;
      }

      // Check trailing bytes after the last newline (or whole chunk if no newline yet)
      const trailingStart = lastNewline >= 0 ? lastNewline + 1 : 0;
      if (trailingStart < chunk.length) {
        const trailingText = chunk.subarray(trailingStart).toString('utf-8').trim();
        if (trailingText) {
          try {
            const trailingStep = JSON.parse(trailingText);
            const view = cloneState(entry.state);
            applyStep(view, trailingStep);
            entry.viewState = view;
          } catch {
            // Torn trailing line: keep committed offset before it; next poll completes it.
            entry.viewState = cloneState(entry.state);
          }
        } else {
          entry.viewState = entry.state;
        }
      } else {
        entry.viewState = entry.state;
      }
    } else {
      entry.viewState = entry.state;
    }

    touchCache(filePath, entry);
    return entry.viewState;
  }

  return {
    readTranscript,
    clear() {
      cache.clear();
    },
    size() {
      return cache.size;
    },
    has(filePath) {
      return cache.has(filePath);
    },
    stat(filePath) {
      try {
        const st = readStat(filePath);
        return { ino: Number(st.ino), size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    },
  };
}
