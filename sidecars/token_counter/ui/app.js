(() => {
  'use strict';

  const POLL_MS = 1500;
  const SESSIONS_EVERY_N_POLLS = 6;
  const COPY_BTN_HTML = 'Copy <code>/compact</code>';
  const DEFAULTS = {
    thresholdMode: 'auto',
    cautionThreshold: 120000,
    dumbZoneThreshold: 175000,
    gaugeCeiling: 250000,
    trackingMode: 'current',
    pinnedSessionId: '',
  };

  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(window.location.search);
  const initialConvId = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  const state = {
    mode: null, // 'current' | 'auto' | 'pinned' (initialized from settings or 'current')
    pinnedId: '',
    workspaceUris: [],
    etag: '',
    lastSnap: null,
    settings: { ...DEFAULTS },
    effectiveThresholds: null,
    draftThresholdMode: null,
    sessions: [],
    pollCount: 0,
    pollSeq: 0,
    inFlightMetrics: false,
    pollTimer: null,
    copyResetTimer: null,
    chartPoints: [], // cached screen/data coords for hover
    pointerActive: false,
    hoverStepIndex: null,
    lastSessionId: '',
    settingsDirty: false,
    watchRevision: 0,
    watchActive: false,
    watchRetryTimer: null,
  };

  function normalizeWorkspaceUris(uris) {
    if (!Array.isArray(uris)) return [];
    return uris.map((u) => String(u || '').trim()).filter(Boolean);
  }

  // ---------- Host Theme Sync ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }

  syncScheme();
  new MutationObserver(() => syncScheme()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Secure Fetch Wrapper ----------
  async function apiFetch(url, options = {}) {
    const fetcher = window.sidecar?.fetch
      ? window.sidecar.fetch.bind(window.sidecar)
      : window.fetch.bind(window);
    return fetcher(url, options);
  }

  // ---------- Formatters ----------
  const nf = new Intl.NumberFormat('en-US');

  function fmtNum(n) {
    return Number.isFinite(n) ? nf.format(Math.round(n)) : '0';
  }

  function fmtK(n) {
    if (!Number.isFinite(n)) return '0';
    if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(Math.round(n));
  }

  function fmtSigned(n) {
    if (!Number.isFinite(n) || n === 0) return '0 tok';
    const sign = n > 0 ? '+' : '-';
    return `${sign}${fmtNum(Math.abs(n))} tok`;
  }

  function fmtClock(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function shortModel(model) {
    const trimmed = String(model || '').trim().replace(/^models\//i, '');
    return trimmed || 'unknown';
  }

  function setLiveStatus(kind, title) {
    const dot = $('live-dot');
    if (!dot) return;
    dot.classList.remove('idle', 'error');
    if (kind === 'idle') dot.classList.add('idle');
    if (kind === 'error') dot.classList.add('error');
    dot.title = title;
  }

  // ---------- API Calls ----------
  async function pollMetrics({ force = false } = {}) {
    if (!force && state.inFlightMetrics) return;
    const seq = ++state.pollSeq;
    state.inFlightMetrics = true;

    try {
      const mode = state.mode || 'current';
      const convId = mode === 'pinned' ? state.pinnedId : initialConvId();
      const qs = new URLSearchParams();
      if (convId) qs.set('conversationId', convId);
      qs.set('mode', mode);
      if (state.workspaceUris.length > 0) {
        qs.set('workspaceUris', JSON.stringify(state.workspaceUris));
        qs.set('workspaceUri', state.workspaceUris[0]);
      }
      if (state.etag) qs.set('etag', state.etag);

      const res = await apiFetch(`/api/metrics?${qs.toString()}`, { method: 'GET' });
      if (seq !== state.pollSeq) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== state.pollSeq) return;

      setLiveStatus('live', 'Polling active');

      if (data.etag) state.etag = data.etag;
      if (data.unchanged) return;

      state.lastSnap = data;
      if (data.effectiveThresholds) {
        state.effectiveThresholds = data.effectiveThresholds;
      }

      if (data.settings) {
        state.settings = { ...DEFAULTS, ...data.settings };
        if (state.mode === null) {
          const tm = state.settings.trackingMode;
          if (tm === 'pinned' && state.settings.pinnedSessionId) {
            state.mode = 'pinned';
            state.pinnedId = state.settings.pinnedSessionId;
          } else if (tm === 'auto') {
            state.mode = 'auto';
            state.pinnedId = '';
          } else {
            state.mode = 'current';
            state.pinnedId = '';
          }
          syncTrackingSelectValue();
        }
        if (!state.settingsDirty) {
          syncSettingsInputs(data.effectiveThresholds, data.metrics?.model);
        }
      }

      renderSnapshot(data);
    } catch (err) {
      if (seq === state.pollSeq) {
        setLiveStatus('error', `Poll failed: ${err.message}`);
      }
    } finally {
      if (seq === state.pollSeq) {
        state.inFlightMetrics = false;
      }
    }
  }

  async function refreshSessions() {
    try {
      const qs = new URLSearchParams({ limit: '25' });
      if (state.workspaceUris.length > 0) {
        qs.set('workspaceUris', JSON.stringify(state.workspaceUris));
        qs.set('workspaceUri', state.workspaceUris[0]);
      }
      const res = await apiFetch(`/api/sessions?${qs.toString()}`, { method: 'GET' });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.sessions)) {
        state.sessions = data.sessions;
        renderSessionOptions();
      }
    } catch {
      // Non-fatal; dropdown keeps previous list
    }
  }

  // ---------- Rendering: Tracking Selector ----------
  function syncTrackingSelectValue() {
    const sel = $('tracking-select');
    if (!sel) return;
    if (state.mode === 'pinned' && state.pinnedId) {
      const target = `pinned:${state.pinnedId}`;
      const group = $('sessions-optgroup');
      if (![...sel.options].some((o) => o.value === target) && group) {
        const opt = document.createElement('option');
        opt.value = target;
        const fallbackTitle = (state.lastSnap?.session?.id === state.pinnedId && state.lastSnap?.session?.title)
          ? state.lastSnap.session.title.trim()
          : state.pinnedId.slice(0, 8);
        opt.textContent = `${fallbackTitle} (pinned)`;
        group.appendChild(opt);
      }
      sel.value = target;
    } else {
      sel.value = state.mode === 'auto' ? 'auto' : 'current';
    }
  }

  function renderSessionOptions() {
    const group = $('sessions-optgroup');
    if (!group) return;
    group.textContent = '';

    for (const s of state.sessions) {
      const opt = document.createElement('option');
      opt.value = `pinned:${s.id}`;
      const activePrefix = s.isActiveLock || s.status === 'CASCADE_RUN_STATUS_RUNNING' ? '● ' : '';
      const rawTitle = (s.title || s.id || 'Untitled').trim();
      const shortTitle = rawTitle.length > 34 ? `${rawTitle.slice(0, 33)}…` : rawTitle;
      const tokSuffix = Number.isFinite(s.contextTokens) && s.contextTokens > 0
        ? ` (${fmtK(s.contextTokens)})`
        : '';
      opt.textContent = `${activePrefix}${shortTitle}${tokSuffix}`;
      group.appendChild(opt);
    }

    syncTrackingSelectValue();
  }

  // ---------- Rendering: Snapshot ----------
  function renderSnapshot(data) {
    const { session, metrics, settings, effectiveThresholds, series = [], compactions = [] } = data;
    const cfg = settings || state.settings || DEFAULTS;
    const eff = effectiveThresholds || cfg;
    state.effectiveThresholds = eff;

    const metaEl = $('session-meta');
    const titleEl = $('session-title');
    const mainOnlyBadge = $('main-only-badge');
    const parentBadge = $('parent-badge');
    const fallbackBadge = $('fallback-badge');

    if (!session) {
      metaEl.classList.add('hidden');
      $('empty-state').classList.remove('hidden');
      $('dashboard').classList.add('hidden');
      $('empty-title').textContent = 'No main session found';
      $('empty-sub').textContent = 'Open or start a conversation to track its context tokens.';
      state.lastSessionId = '';
      state.pointerActive = false;
      state.hoverStepIndex = null;
      hideTooltip();
      return;
    }

    if (state.lastSessionId && state.lastSessionId !== session.id) {
      state.pointerActive = false;
      state.hoverStepIndex = null;
      hideTooltip();
    }
    state.lastSessionId = session.id || '';

    metaEl.classList.remove('hidden');
    const displayTitle = (session.title || session.id || 'Main session').trim();
    titleEl.textContent = displayTitle;
    titleEl.title = session.workspace ? `${displayTitle} (${session.workspace})` : displayTitle;

    if (mainOnlyBadge) {
      const workers = Number(session.activeChildCount) || 0;
      mainOnlyBadge.textContent = workers > 0
        ? `Main Only · ${workers} ${workers === 1 ? 'worker' : 'workers'}`
        : 'Main Only';
    }

    if (parentBadge) {
      parentBadge.classList.toggle('hidden', !session.resolvedFromChildId);
    }
    if (fallbackBadge) {
      fallbackBadge.classList.toggle('hidden', session.discoverySource !== 'fs_fallback');
    }

    if (!metrics || !series.length) {
      $('empty-state').classList.remove('hidden');
      $('dashboard').classList.add('hidden');
      $('empty-title').textContent = 'Waiting for first model turn…';
      $('empty-sub').textContent = 'Token usage appears after the first PLANNER_RESPONSE step.';
      hideTooltip();
      return;
    }

    $('empty-state').classList.add('hidden');
    $('dashboard').classList.remove('hidden');

    renderHeroGauge(metrics, eff);
    renderMetricsGrid(metrics, eff);
    renderChart(series, compactions, eff);
  }

  function renderHeroGauge(metrics, eff) {
    const zone = metrics.zone || 'safe';
    const ctx = metrics.contextTokens || 0;
    const dumb = eff.dumbZoneThreshold || 175000;
    const caution = eff.cautionThreshold || 120000;
    const ceiling = eff.gaugeCeiling > dumb ? eff.gaugeCeiling : Math.round(dumb * 1.5);

    $('hero-tokens').textContent = fmtNum(ctx);

    const pill = $('zone-pill');
    pill.className = `zone-pill zone-${zone}`;
    pill.textContent = zone === 'dumb' ? 'DUMB ZONE' : zone === 'caution' ? 'CAUTION' : 'SAFE';

    const pct = Number.isFinite(metrics.pctOfDumbZone)
      ? Math.round(metrics.pctOfDumbZone)
      : Math.round((ctx / dumb) * 100);
    $('hero-pct').textContent = `${pct}% of ${fmtK(dumb)} limit`;

    const headroom = Number.isFinite(metrics.headroomToDumbZone)
      ? metrics.headroomToDumbZone
      : dumb - ctx;
    const headroomEl = $('hero-headroom');
    headroomEl.textContent = headroom >= 0
      ? `${fmtNum(headroom)} left`
      : `${fmtNum(Math.abs(headroom))} over limit`;
    headroomEl.classList.toggle('over-limit', headroom < 0);

    const fillPct = Math.max(0, Math.min(100, (ctx / ceiling) * 100));
    const fillEl = $('gauge-fill');
    fillEl.style.width = `${fillPct.toFixed(1)}%`;
    fillEl.className = `gauge-fill zone-${zone}`;

    const cautionPct = Math.max(0, Math.min(99, (caution / ceiling) * 100));
    const dumbPct = Math.max(0, Math.min(99, (dumb / ceiling) * 100));
    $('tick-caution').style.left = `${cautionPct.toFixed(1)}%`;
    $('tick-dumb').style.left = `${dumbPct.toFixed(1)}%`;

    const lblCaution = $('label-caution');
    const lblDumb = $('label-dumb');
    lblCaution.textContent = fmtK(caution);
    lblDumb.textContent = fmtK(dumb);
    $('label-ceiling').textContent = fmtK(ceiling);

    lblCaution.style.left = `${cautionPct.toFixed(1)}%`;
    lblDumb.style.left = `${dumbPct.toFixed(1)}%`;
    lblCaution.classList.toggle('hidden', cautionPct < 9 || (dumbPct - cautionPct) < 9 || (100 - cautionPct) < 9);
    lblDumb.classList.toggle('hidden', dumbPct < 9 || (100 - dumbPct) < 9);

    $('dumb-banner').classList.toggle('hidden', zone !== 'dumb');
    $('compaction-pending-banner').classList.toggle('hidden', !metrics.postCompactionPending);

    const modelBadge = $('model-badge');
    const modelName = shortModel(metrics.model);
    const isManual = eff.source === 'manual' || metrics.thresholdSource === 'manual';
    const isFallback = !isManual && eff.source === 'fallback';
    modelBadge.classList.toggle('fallback', isFallback);
    if (isManual) {
      modelBadge.textContent = `${modelName} · Manual`;
      modelBadge.title = `${metrics.model || 'Unknown model'} | Manual (${fmtK(caution)} / ${fmtK(dumb)} / ${fmtK(ceiling)})`;
    } else if (isFallback) {
      modelBadge.textContent = `${modelName} · Auto (Default)`;
      modelBadge.title = `Unrecognized model "${metrics.model || 'unknown'}" — using default fallback thresholds (${fmtK(caution)} / ${fmtK(dumb)} / ${fmtK(ceiling)})`;
    } else {
      const profileDesc = eff.profileLabel || metrics.profileLabel || 'Profile';
      const srcNote = metrics.modelSource && metrics.modelSource !== 'none'
        ? ` via ${metrics.modelSource}`
        : '';
      modelBadge.textContent = `${modelName} · Auto (${profileDesc})`;
      modelBadge.title = `${metrics.model || 'Unknown model'}${srcNote} | ${profileDesc} (${fmtK(caution)} / ${fmtK(dumb)} / ${fmtK(ceiling)})`;
    }

    const deltaEl = $('delta-badge');
    if (metrics.lastCompaction && metrics.lastCompaction.postContext === ctx) {
      deltaEl.textContent = `Compacted: ${fmtK(metrics.lastCompaction.preContext)} → ${fmtK(ctx)}`;
    } else {
      deltaEl.textContent = `Last step: ${fmtSigned(metrics.delta)}`;
    }
  }

  function renderMetricsGrid(metrics, cfg) {
    const cacheRead = metrics.cacheRead || 0;
    const hitPct = Math.round((metrics.cacheHitRate || 0) * 100);
    $('val-cache-read').textContent = fmtNum(cacheRead);
    $('sub-cache-hit').textContent = `${hitPct}% hit rate`;

    const uncached = metrics.uncachedInput || 0;
    $('val-uncached').textContent = fmtNum(uncached);
    const subUncached = $('sub-uncached');
    if (cacheRead === 0 && uncached > 0) {
      subUncached.textContent = 'Cold cache / full prompt';
      subUncached.classList.add('warn');
    } else {
      subUncached.textContent = 'New prompt delta';
      subUncached.classList.remove('warn');
    }

    $('val-output').textContent = fmtNum(metrics.outputTokens || 0);
    $('sub-output').textContent = `Step #${metrics.lastStepIndex ?? metrics.stepCount ?? 0}`;

    const burnEl = $('val-burn');
    const subBurnEl = $('sub-burn');
    if (metrics.zone === 'dumb') {
      burnEl.textContent = 'Limit hit';
    } else if (Number.isFinite(metrics.estimatedTurnsToDumbZone) && metrics.estimatedTurnsToDumbZone > 0) {
      burnEl.textContent = `~${metrics.estimatedTurnsToDumbZone} turns`;
    } else if (Number.isFinite(metrics.avgDeltaPerTurn) && metrics.avgDeltaPerTurn > 0) {
      burnEl.textContent = `+${fmtK(metrics.avgDeltaPerTurn)}/t`;
    } else {
      burnEl.textContent = 'Stable';
    }

    const avgStr = Number.isFinite(metrics.avgDeltaPerTurn) && metrics.avgDeltaPerTurn > 0
      ? `+${fmtK(metrics.avgDeltaPerTurn)}/turn · `
      : '';
    subBurnEl.textContent = `${avgStr}Peak ${fmtK(metrics.peakCurrentEpoch || metrics.contextTokens || 0)}`;
    subBurnEl.title = `Epoch peak: ${fmtNum(metrics.peakCurrentEpoch || 0)} | All-time peak: ${fmtNum(metrics.peakAllTime || 0)} | Limit: ${fmtK(cfg.dumbZoneThreshold)}`;
  }

  // ---------- Rendering: Interactive SVG Chart ----------
  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, String(v));
    }
    return el;
  }

  function renderChart(series, compactions, cfg) {
    const svg = $('growth-chart');
    svg.textContent = '';
    state.chartPoints = [];

    $('chart-meta').textContent = `${series.length} ${series.length === 1 ? 'turn' : 'turns'}${compactions.length ? ` · ${compactions.length} compact` : ''}`;

    const W = 360;
    const H = 156;
    const pad = { top: 18, right: 10, bottom: 20, left: 40 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const caution = cfg.cautionThreshold || 120000;
    const dumb = cfg.dumbZoneThreshold || 175000;
    const maxSeries = series.reduce((m, p) => Math.max(m, p.contextTokens || 0), 0);
    const yMax = Math.max(cfg.gaugeCeiling || 250000, Math.round(dumb * 1.15), Math.round(maxSeries * 1.08), 10000);

    const xOfIdx = (i) => (series.length === 1
      ? pad.left + plotW / 2
      : pad.left + (i / (series.length - 1)) * plotW);
    const yOfVal = (v) => pad.top + plotH - Math.max(0, Math.min(1, v / yMax)) * plotH;

    // Defs for area gradient
    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id: 'tcAreaGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': 'var(--tc-primary)', 'stop-opacity': '0.28' }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': 'var(--tc-primary)', 'stop-opacity': '0.02' }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    // Dumb Zone danger band
    const yDumb = yOfVal(dumb);
    if (yDumb > pad.top) {
      svg.appendChild(svgEl('rect', {
        x: pad.left,
        y: pad.top,
        width: plotW,
        height: yDumb - pad.top,
        fill: 'var(--tc-dumb)',
        'fill-opacity': '0.09',
      }));
    }

    // Horizontal threshold lines + Y labels
    const refLines = [
      { val: caution, color: 'var(--tc-caution)', label: fmtK(caution) },
      { val: dumb, color: 'var(--tc-dumb)', label: fmtK(dumb) },
    ];
    for (const ref of refLines) {
      const y = yOfVal(ref.val);
      svg.appendChild(svgEl('line', {
        x1: pad.left,
        y1: y,
        x2: W - pad.right,
        y2: y,
        stroke: ref.color,
        'stroke-width': '1',
        'stroke-dasharray': '3 3',
        'stroke-opacity': '0.8',
      }));
      const txt = svgEl('text', {
        x: pad.left - 5,
        y: y + 3,
        'text-anchor': 'end',
        fill: ref.color,
        'font-size': '9.5',
        'font-family': 'var(--tc-mono)',
      });
      txt.textContent = ref.label;
      svg.appendChild(txt);
    }

    // Baseline 0 & yMax labels
    const lblZero = svgEl('text', {
      x: pad.left - 5,
      y: pad.top + plotH + 3,
      'text-anchor': 'end',
      fill: 'var(--tc-fg-muted)',
      'font-size': '9.5',
      'font-family': 'var(--tc-mono)',
    });
    lblZero.textContent = '0';
    svg.appendChild(lblZero);

    if (Math.abs(yDumb - pad.top) >= 12) {
      const lblMax = svgEl('text', {
        x: pad.left - 5,
        y: pad.top + 3,
        'text-anchor': 'end',
        fill: 'var(--tc-fg-muted)',
        'font-size': '9.5',
        'font-family': 'var(--tc-mono)',
      });
      lblMax.textContent = fmtK(yMax);
      svg.appendChild(lblMax);
    }

    // Axes
    svg.appendChild(svgEl('line', {
      x1: pad.left,
      y1: pad.top + plotH,
      x2: W - pad.right,
      y2: pad.top + plotH,
      stroke: 'var(--tc-border)',
      'stroke-width': '1',
    }));

    // Compaction vertical markers
    const minStep = series[0].stepIndex;
    const maxStep = series[series.length - 1].stepIndex;
    for (const c of compactions) {
      let cx = pad.left;
      const nextIdx = series.findIndex((p) => p.stepIndex >= c.stepIndex);
      if (nextIdx >= 0) {
        cx = xOfIdx(nextIdx);
      } else if (maxStep > minStep) {
        cx = pad.left + Math.max(0, Math.min(1, (c.stepIndex - minStep) / (maxStep - minStep))) * plotW;
      } else {
        cx = pad.left + plotW;
      }

      svg.appendChild(svgEl('line', {
        x1: cx,
        y1: 13,
        x2: cx,
        y2: pad.top + plotH,
        stroke: 'var(--tc-primary)',
        'stroke-width': '1',
        'stroke-dasharray': '2 2',
        'stroke-opacity': '0.75',
      }));
      svg.appendChild(svgEl('circle', {
        cx,
        cy: 7,
        r: 5.5,
        fill: 'var(--tc-primary)',
      }));
      const cText = svgEl('text', {
        x: cx,
        y: 10,
        'text-anchor': 'middle',
        fill: 'var(--tc-primary-fg)',
        'font-size': '8',
        'font-weight': '700',
      });
      cText.textContent = 'C';
      svg.appendChild(cText);
    }

    // Build path & area
    const coords = series.map((pt, i) => ({
      x: xOfIdx(i),
      y: yOfVal(pt.contextTokens || 0),
      pt,
    }));
    state.chartPoints = coords;

    if (coords.length > 1) {
      const lineD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
      const areaD = `${lineD} L${coords[coords.length - 1].x.toFixed(1)},${(pad.top + plotH).toFixed(1)} L${coords[0].x.toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`;

      svg.appendChild(svgEl('path', { d: areaD, fill: 'url(#tcAreaGrad)' }));
      svg.appendChild(svgEl('path', {
        d: lineD,
        fill: 'none',
        stroke: 'var(--tc-primary)',
        'stroke-width': '1.8',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }));
    }

    // Last point dot
    const last = coords[coords.length - 1];
    svg.appendChild(svgEl('circle', {
      cx: last.x,
      cy: last.y,
      r: 3,
      fill: 'var(--tc-primary)',
      stroke: 'var(--tc-card)',
      'stroke-width': '1.5',
    }));

    // X-axis step labels
    const firstLbl = svgEl('text', {
      x: pad.left,
      y: H - 5,
      fill: 'var(--tc-fg-muted)',
      'font-size': '9.5',
      'font-family': 'var(--tc-mono)',
    });
    firstLbl.textContent = `#${series[0].stepIndex}`;
    svg.appendChild(firstLbl);

    if (series.length > 1) {
      const lastLbl = svgEl('text', {
        x: W - pad.right,
        y: H - 5,
        'text-anchor': 'end',
        fill: 'var(--tc-fg-muted)',
        'font-size': '9.5',
        'font-family': 'var(--tc-mono)',
      });
      lastLbl.textContent = `#${series[series.length - 1].stepIndex}`;
      svg.appendChild(lastLbl);
    }

    // Hover crosshair elements (hidden until pointermove)
    const cross = svgEl('line', {
      id: 'chart-crosshair',
      x1: 0,
      y1: pad.top,
      x2: 0,
      y2: pad.top + plotH,
      stroke: 'var(--tc-fg-muted)',
      'stroke-width': '1',
      'stroke-opacity': '0.55',
      class: 'hidden',
    });
    const dot = svgEl('circle', {
      id: 'chart-hover-dot',
      cx: 0,
      cy: 0,
      r: 4,
      fill: 'var(--tc-primary)',
      stroke: 'var(--tc-card)',
      'stroke-width': '1.5',
      class: 'hidden',
    });
    svg.appendChild(cross);
    svg.appendChild(dot);

    if (state.pointerActive && state.hoverStepIndex !== null && coords.length > 0) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < coords.length; i++) {
        const d = Math.abs(coords[i].pt.stepIndex - state.hoverStepIndex);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      showTooltipAtIndex(bestIdx);
    } else {
      hideTooltip();
    }
  }

  function hideTooltip() {
    $('chart-tooltip')?.classList.add('hidden');
    $('chart-crosshair')?.classList.add('hidden');
    $('chart-hover-dot')?.classList.add('hidden');
  }

  function showTooltipAtIndex(idx) {
    const pts = state.chartPoints;
    if (!pts.length || idx < 0 || idx >= pts.length) return;
    const svg = $('growth-chart');
    const wrap = $('chart-wrap');
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;

    const chosen = pts[idx];
    const cross = $('chart-crosshair');
    const dot = $('chart-hover-dot');
    if (cross && dot) {
      cross.setAttribute('x1', chosen.x.toFixed(1));
      cross.setAttribute('x2', chosen.x.toFixed(1));
      cross.classList.remove('hidden');
      dot.setAttribute('cx', chosen.x.toFixed(1));
      dot.setAttribute('cy', chosen.y.toFixed(1));
      dot.classList.remove('hidden');
    }

    const tip = $('chart-tooltip');
    tip.textContent = '';

    const head = document.createElement('div');
    head.className = 'tt-head';
    head.textContent = `Step #${chosen.pt.stepIndex} · ${fmtNum(chosen.pt.contextTokens)} tok`;
    tip.appendChild(head);

    const row1 = document.createElement('div');
    row1.className = 'tt-row';
    row1.textContent = `Cache ${fmtK(chosen.pt.cacheRead)} + Input ${fmtK(chosen.pt.uncachedInput)} · Δ ${fmtSigned(chosen.pt.delta)}`;
    tip.appendChild(row1);

    const row2 = document.createElement('div');
    row2.className = 'tt-row';
    const timeStr = fmtClock(chosen.pt.ts);
    row2.textContent = `${shortModel(chosen.pt.model)}${timeStr ? ` · ${timeStr}` : ''}`;
    tip.appendChild(row2);

    tip.classList.remove('hidden');

    const pxX = (chosen.x / 360) * rect.width;
    const tipW = tip.offsetWidth || 180;
    const left = Math.max(4, Math.min(wrap.clientWidth - tipW - 4, pxX - tipW / 2));
    tip.style.left = `${left}px`;
  }

  function handleChartPointer(ev) {
    const pts = state.chartPoints;
    if (!pts.length) return;
    const svg = $('growth-chart');
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;

    state.pointerActive = true;
    const svgX = ((ev.clientX - rect.left) / rect.width) * 360;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i].x - svgX);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    state.hoverStepIndex = pts[bestIdx].pt.stepIndex;
    showTooltipAtIndex(bestIdx);
  }

  // ---------- Settings Drawer ----------
  function formatProfileReadout(eff, thresholdMode, model) {
    const c = eff?.cautionThreshold ?? state.settings.cautionThreshold;
    const d = eff?.dumbZoneThreshold ?? state.settings.dumbZoneThreshold;
    const g = eff?.gaugeCeiling ?? state.settings.gaugeCeiling;
    const nums = `${fmtK(c)} / ${fmtK(d)} / ${fmtK(g)}`;
    if (thresholdMode === 'manual') {
      return `Manual Override · ${nums}`;
    }
    if (eff?.source === 'fallback') {
      const modelStr = String(model || '').trim();
      const modelDesc = modelStr ? shortModel(modelStr) : 'Model unknown';
      return `Auto (Fallback · ${modelDesc}) · ${nums}`;
    }
    const label = eff?.profileLabel || 'Default (Orchestrator-Neon)';
    return `Auto: ${label} · ${nums}`;
  }

  function updateThresholdModeUI(mode, eff, model) {
    const isManual = mode === 'manual';
    const autoBtn = $('mode-auto-btn');
    const manualBtn = $('mode-manual-btn');
    if (autoBtn) {
      autoBtn.classList.toggle('active', !isManual);
      autoBtn.setAttribute('aria-pressed', String(!isManual));
    }
    if (manualBtn) {
      manualBtn.classList.toggle('active', isManual);
      manualBtn.setAttribute('aria-pressed', String(isManual));
    }
    ['input-caution', 'input-dumb', 'input-ceiling'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !isManual;
    });
    const readout = $('active-profile-readout');
    if (readout) {
      const resolvedModel = model !== undefined ? model : (state.lastSnap?.metrics?.model || '');
      readout.textContent = formatProfileReadout(eff || state.effectiveThresholds, mode, resolvedModel);
    }
  }

  function syncSettingsInputs(eff, model) {
    const effective = eff || state.effectiveThresholds;
    const mode = state.settingsDirty && state.draftThresholdMode
      ? state.draftThresholdMode
      : (state.settings.thresholdMode === 'manual' ? 'manual' : 'auto');
    updateThresholdModeUI(mode, effective, model);

    if (!state.settingsDirty) {
      const src = mode === 'auto' && effective ? effective : state.settings;
      $('input-caution').value = src.cautionThreshold;
      $('input-dumb').value = src.dumbZoneThreshold;
      $('input-ceiling').value = src.gaugeCeiling;
    }
  }

  function showSettingsFeedback(msg, isError) {
    const el = $('settings-feedback');
    el.textContent = msg;
    el.className = `settings-feedback ${isError ? 'err' : 'ok'}`;
    el.classList.remove('hidden');
  }

  async function saveSettingsPayload(payload) {
    try {
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      state.settings = { ...DEFAULTS, ...(body.settings || payload) };
      state.settingsDirty = false;
      state.draftThresholdMode = null;
      state.etag = '';
      syncSettingsInputs();
      showSettingsFeedback('Saved thresholds.', false);
      await pollMetrics({ force: true });
    } catch (err) {
      showSettingsFeedback(err.message || 'Failed to save settings.', true);
    }
  }

  function bindEvents() {
    // Settings toggle
    $('settings-toggle').addEventListener('click', () => {
      const drawer = $('settings-drawer');
      const isHidden = drawer.classList.toggle('hidden');
      $('settings-toggle').setAttribute('aria-expanded', String(!isHidden));
      if (!isHidden) {
        if (!state.settingsDirty) state.draftThresholdMode = null;
        syncSettingsInputs();
        $('settings-feedback').classList.add('hidden');
      }
    });

    // Threshold mode segmented toggle
    $('mode-auto-btn')?.addEventListener('click', async () => {
      state.draftThresholdMode = 'auto';
      state.settingsDirty = false;
      updateThresholdModeUI('auto', state.effectiveThresholds);
      $('settings-feedback').classList.add('hidden');
      await saveSettingsPayload({ thresholdMode: 'auto' });
    });

    $('mode-manual-btn')?.addEventListener('click', () => {
      state.draftThresholdMode = 'manual';
      state.settingsDirty = true;
      updateThresholdModeUI('manual', state.effectiveThresholds);
      $('settings-feedback').classList.add('hidden');
    });

    // Presets
    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [c, d, m] = btn.dataset.preset.split(',').map(Number);
        state.draftThresholdMode = 'manual';
        state.settingsDirty = true;
        updateThresholdModeUI('manual', state.effectiveThresholds);
        $('input-caution').value = c;
        $('input-dumb').value = d;
        $('input-ceiling').value = m;
        $('settings-feedback').classList.add('hidden');
      });
    });

    // Mark dirty on manual edit
    ['input-caution', 'input-dumb', 'input-ceiling'].forEach((id) => {
      $(id).addEventListener('input', () => {
        state.draftThresholdMode = 'manual';
        state.settingsDirty = true;
      });
    });

    // Save settings form
    $('settings-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const cautionThreshold = Number($('input-caution').value);
      const dumbZoneThreshold = Number($('input-dumb').value);
      const gaugeCeiling = Number($('input-ceiling').value);

      if (!Number.isInteger(cautionThreshold) || cautionThreshold < 1000 || cautionThreshold > 1999999) {
        showSettingsFeedback('Caution must be an integer between 1,000 and 1,999,999.', true);
        return;
      }
      if (!Number.isInteger(dumbZoneThreshold) || dumbZoneThreshold <= cautionThreshold || dumbZoneThreshold > 2000000) {
        showSettingsFeedback('Dumb Zone must be an integer > Caution and <= 2,000,000.', true);
        return;
      }
      if (!Number.isInteger(gaugeCeiling) || gaugeCeiling <= dumbZoneThreshold || gaugeCeiling > 5000000) {
        showSettingsFeedback('Gauge Max must be an integer > Dumb Zone and <= 5,000,000.', true);
        return;
      }

      const trackingMode = state.mode || 'current';
      const pinnedSessionId = trackingMode === 'pinned' ? state.pinnedId : '';
      await saveSettingsPayload({
        thresholdMode: 'manual',
        cautionThreshold,
        dumbZoneThreshold,
        gaugeCeiling,
        trackingMode,
        pinnedSessionId,
      });
    });

    // Reset defaults
    $('settings-reset').addEventListener('click', async () => {
      state.draftThresholdMode = 'auto';
      state.settingsDirty = false;
      $('input-caution').value = DEFAULTS.cautionThreshold;
      $('input-dumb').value = DEFAULTS.dumbZoneThreshold;
      $('input-ceiling').value = DEFAULTS.gaugeCeiling;
      const trackingMode = state.mode || 'current';
      await saveSettingsPayload({
        thresholdMode: 'auto',
        cautionThreshold: DEFAULTS.cautionThreshold,
        dumbZoneThreshold: DEFAULTS.dumbZoneThreshold,
        gaugeCeiling: DEFAULTS.gaugeCeiling,
        trackingMode,
        pinnedSessionId: trackingMode === 'pinned' ? state.pinnedId : '',
      });
    });

    // Tracking selector
    $('tracking-select').addEventListener('change', async (ev) => {
      const changeSeq = ++state.pollSeq;
      const val = ev.target.value;
      if (val.startsWith('pinned:')) {
        state.mode = 'pinned';
        state.pinnedId = val.slice('pinned:'.length);
      } else {
        state.mode = val === 'auto' ? 'auto' : 'current';
        state.pinnedId = '';
      }
      state.etag = '';
      try {
        const res = await apiFetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trackingMode: state.mode,
            pinnedSessionId: state.mode === 'pinned' ? state.pinnedId : '',
          }),
        });
        if (res.ok) {
          const body = await res.json().catch(() => null);
          if (body?.settings) {
            state.settings = { ...DEFAULTS, ...body.settings };
          }
        }
      } catch {
        // Non-fatal; proceed to poll with updated state.mode
      }
      if (changeSeq !== state.pollSeq) return;
      await pollMetrics({ force: true });
    });

    $('tracking-select').addEventListener('focus', () => {
      refreshSessions();
    });

    // Copy /compact button
    $('copy-compact-btn').addEventListener('click', async () => {
      const btn = $('copy-compact-btn');
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText('/compact');
          copied = true;
        }
      } catch {
        // Fallback below
      }
      if (!copied) {
        const ta = document.createElement('textarea');
        ta.value = '/compact';
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        try {
          copied = document.execCommand('copy');
        } catch {
          copied = false;
        }
        ta.remove();
      }
      if (state.copyResetTimer) {
        clearTimeout(state.copyResetTimer);
        state.copyResetTimer = null;
      }
      btn.textContent = copied ? 'Copied!' : 'Run /compact';
      state.copyResetTimer = setTimeout(() => {
        btn.innerHTML = COPY_BTN_HTML;
        state.copyResetTimer = null;
      }, 1800);
    });

    // Chart hover
    const chart = $('growth-chart');
    chart.addEventListener('pointermove', handleChartPointer);
    chart.addEventListener('pointerdown', handleChartPointer);
    chart.addEventListener('pointerleave', () => {
      state.pointerActive = false;
      state.hoverStepIndex = null;
      hideTooltip();
    });

    // Visibility pause/resume
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        setLiveStatus('idle', 'Paused while hidden');
      } else {
        setLiveStatus('live', 'Polling active');
        pollMetrics();
        runWatchLoop();
      }
    });

    // Workspace change listener
    if (window.sidecar?.onWorkspaceChange) {
      window.sidecar.onWorkspaceChange((uris) => {
        const nextUris = normalizeWorkspaceUris(uris);
        const changed = nextUris.length !== state.workspaceUris.length
          || nextUris.some((u, i) => u !== state.workspaceUris[i]);
        if (changed) {
          state.workspaceUris = nextUris;
          state.etag = '';
          pollMetrics({ force: true });
          refreshSessions();
        }
      });
    }
  }

  // ---------- Boot ----------
  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (document.hidden) return;
      state.pollCount += 1;
      pollMetrics();
      if (state.pollCount % SESSIONS_EVERY_N_POLLS === 0) {
        refreshSessions();
      }
    }, POLL_MS);
  }

  function scheduleWatchRetry() {
    if (state.watchRetryTimer || document.hidden) return;
    state.watchRetryTimer = setTimeout(() => {
      state.watchRetryTimer = null;
      runWatchLoop();
    }, 2000);
  }

  async function runWatchLoop() {
    if (document.hidden || state.watchActive) return;
    if (state.watchRetryTimer) {
      clearTimeout(state.watchRetryTimer);
      state.watchRetryTimer = null;
    }
    state.watchActive = true;
    try {
      while (!document.hidden) {
        const res = await apiFetch(
          `/api/watch?since=${state.watchRevision}&timeoutMs=15000`,
          { method: 'GET' }
        );
        if (!res.ok) {
          scheduleWatchRetry();
          return;
        }
        const data = await res.json();
        if (data.closed || data.watching === false) {
          return;
        }
        if (typeof data.revision === 'number') {
          state.watchRevision = data.revision;
        }
        if (data.changed) {
          const prevSessionId = state.lastSessionId;
          state.etag = '';
          pollMetrics({ force: true }).then(() => {
            if (state.lastSessionId !== prevSessionId) {
              refreshSessions();
            }
          });
        }
      }
    } catch {
      scheduleWatchRetry();
    } finally {
      state.watchActive = false;
    }
  }

  async function boot() {
    bindEvents();
    try {
      if (window.sidecar?.getWorkspaceUris) {
        const uris = await window.sidecar.getWorkspaceUris();
        state.workspaceUris = normalizeWorkspaceUris(uris);
      }
    } catch {
      // Ignore if unavailable
    }
    await pollMetrics();
    await refreshSessions();
    startPolling();
    runWatchLoop();
  }

  boot();
})();
