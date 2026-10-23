/*
 * Dashboard front end (plain JavaScript, no build step).
 *
 * What the user can do, in OLAP terms:
 *   drill down - click a value in the table or a bar in the chart, or pick a lower level
 *   roll up    - click an earlier step in the path, the "Roll up" button, or a higher level
 *   slice/dice - pick one or several values in the filters
 *   pivot      - turn one column of the result into the table's columns
 *
 * Every choice is stored in the page address,
 * so the browser's Back button undoes the last step and a copied link reopens the same view.
 */
(() => {
  'use strict';

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  // Numeric columns that describe a category rather than measure an amount
  const NUMERIC_DIMENSIONS = new Set(['year', 'quarter', 'month', 'day', 'num_clients',
    'district_id', 'account_id', 'trans_type_id', 'date_id', 'trans_id']);
  const MAX_SERIES = 8;
  const BAR_LIMIT = 120; // more points than this are drawn as a line

  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

  const $main = document.getElementById('main');
  const $list = document.getElementById('report-list');

  let meta = null;         // /api/meta
  let report = null;       // the selected report
  const states = {};       // report id -> user choices
  let lastResult = null;   // last successful /run response
  let runSeq = 0;          // ignores answers to queries that were superseded
  let chart = null;        // Chart.js instance for the current report
  let closePopover = null; // function to close the currently open filter popover
  let applyPopover = null; // function to apply the open popover's picks and close it
  let ui = {};             // containers of the current report page

  // helpers

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const chevron = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
    return svg;
  };

  /*
   * drops DOUBLE rounding noise
   * a sum of many DOUBLEs can be off in the 15th digit, so keep 12 significant digits
   * still 2 decimals for totals up to 10 billion
   */
  const clean = (n) => Number(n.toPrecision(12));

  /*
   * withDecimals: true = always 2 decimals, false = never, undefined = decide per value.
   * A table passes the same choice for every cell of a column, so the column lines up.
   */
  function fmtNumber(v, withDecimals) {
    if (v === null || v === undefined || v === '') return '';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const decimals = withDecimals ?? !Number.isInteger(clean(n));
    return decimals ? nf2.format(n) : nf0.format(n);
  }

  /* True if any value in the list has a fractional part (i.e. the column needs decimals) */
  function needsDecimals(values) {
    return values.some((v) => typeof v === 'number' && !Number.isInteger(clean(v)));
  }

  /* How a dimension value is written */
  function fmtDim(key, v) {
    if (v === null || v === undefined) return '';
    if (key === 'quarter') return `Q${v}`;
    if (key === 'month' && MONTHS[v - 1]) return MONTHS[v - 1];
    if (v === '') return '(blank)';
    return String(v);
  }

  function columnLabel(name) {
    if (report.columnLabels[name]) return report.columnLabels[name];
    const s = name.replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  const plural = (label) => `${label.toLowerCase()}s`;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

  // state

  function defaultState(r) {
    const params = {};
    for (const [name, p] of Object.entries(r.params || {})) params[name] = p.default;
    return { levels: {}, path: {}, filters: {}, params, measure: null, pivot: '' };
  }

  function st() {
    return states[report.id];
  }

  function levelIndex(hName) {
    const levels = meta.hierarchies[hName].levels;
    const key = st().levels[hName] || report.defaultLevels[hName] || levels[0].key;
    const idx = levels.findIndex((l) => l.key === key);
    return idx === -1 ? 0 : idx;
  }

  /* Path values for the levels above the given level index (in hierarchy order) */
  function pathEntries(hName, belowIdx) {
    const levels = meta.hierarchies[hName].levels;
    const path = st().path[hName] || {};
    const out = [];
    for (let i = 0; i < belowIdx; i++) {
      if (!(levels[i].key in path)) break;
      out.push({ index: i, key: levels[i].key, label: levels[i].label, value: path[levels[i].key] });
    }
    return out;
  }

  function setLevel(hName, idx) {
    const levels = meta.hierarchies[hName].levels;
    const kept = {};
    for (const e of pathEntries(hName, idx)) kept[e.key] = e.value;
    st().levels[hName] = levels[idx].key;
    st().path[hName] = kept;
  }

  function activeFilters() {
    const out = {};
    for (const [k, vals] of Object.entries(st().filters)) if (vals && vals.length) out[k] = vals;
    return out;
  }

  // address bar

  function writeUrl(push) {
    const s = st();
    const payload = { levels: s.levels, path: s.path, filters: activeFilters(), params: s.params, measure: s.measure, pivot: s.pivot };
    const hash = `#report=${encodeURIComponent(report.id)}&view=${encodeURIComponent(JSON.stringify(payload))}`;
    if (hash === location.hash) return;
    if (push) history.pushState(null, '', hash);
    else history.replaceState(null, '', hash);
  }

  function readUrl() {
    const params = new URLSearchParams(location.hash.slice(1));
    const id = params.get('report');
    const r = meta.reports.find((x) => x.id === id);
    if (!r) return null;
    if (!r.error) {
      let saved = {};
      try {
        saved = JSON.parse(params.get('view') || '{}');
      } catch (err) {
        // A link that was cut off or hand-edited (open the report's default view instead)
        console.warn('Ignoring the view in the address, it is not valid JSON:', err.message);
      }
      states[r.id] = restoreState(r, saved);
    }
    return r;
  }

  /* 
   * Rebuilds a report's state from the view saved in the address,
   * keeping only values this report can use, 
   * so an edited or outdated link can't break the page.
   */
  function restoreState(r, saved) {
    const s = defaultState(r);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return s;
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const isScalar = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

    for (const hName of r.hierarchies) {
      const levelKeys = meta.hierarchies[hName].levels.map((l) => l.key);
      const level = isObj(saved.levels) ? saved.levels[hName] : undefined;
      if (levelKeys.includes(level)) s.levels[hName] = level;

      const path = isObj(saved.path) && isObj(saved.path[hName]) ? saved.path[hName] : {};
      const kept = {};
      for (const key of levelKeys) {
        if (!isScalar(path[key])) break; // a drill path has no gaps: stop at the first missing level
        kept[key] = path[key];
      }
      s.path[hName] = kept;
    }

    if (isObj(saved.filters)) {
      for (const fKey of r.filters) {
        const raw = saved.filters[fKey];
        const values = (Array.isArray(raw) ? raw : [raw]).filter(isScalar);
        if (values.length) s.filters[fKey] = values;
      }
    }

    if (isObj(saved.params)) {
      for (const name of Object.keys(r.params || {})) {
        if (isScalar(saved.params[name])) s.params[name] = saved.params[name];
      }
    }

    s.measure = typeof saved.measure === 'string' ? saved.measure : null;
    s.pivot = typeof saved.pivot === 'string' ? saved.pivot : '';
    return s;
  }

  window.addEventListener('popstate', () => {
    if (!meta) return;
    const r = readUrl();
    if (r) openReport(r, { fromUrl: true });
  });

  // start up

  async function init() {
    try {
      const res = await fetch('/api/meta');
      if (!res.ok) throw new Error(`The server answered ${res.status}`);
      meta = await res.json();
    } catch (err) {
      $main.replaceChildren(errorBox('The dashboard could not load', `Make sure the server is running (npm start). ${err.message}`));
      return;
    }

    renderSidebar();
    if (meta.reports.length === 0) {
      $main.replaceChildren(h('div', { class: 'message' },
        h('h2', { text: 'No reports yet' })));
      return;
    }
    const fromUrl = readUrl();
    // replace: the first view takes over the page's own history entry instead of adding one,
    // otherwise the first Back press would land on an empty address and do nothing
    openReport(fromUrl || meta.reports.find((r) => !r.error) || meta.reports[0], { fromUrl: Boolean(fromUrl), replace: true });
  }

  function renderSidebar() {
    $list.replaceChildren(...meta.reports.map((r) => h('li', null,
      h('button', {
        class: 'report-link',
        type: 'button',
        'data-id': r.id,
        'aria-current': report && report.id === r.id ? 'page' : null,
        onclick: () => {
          if (report && report.id === r.id) return;
          openReport(r, { fromUrl: false });
        },
      }, r.title, r.error ? h('span', { class: 'broken', text: 'Needs fixing' }) : null))));
  }

  function openReport(r, { fromUrl, replace = false }) {
    report = r;
    lastResult = null;
    if (closePopover) closePopover(false);
    renderSidebar();
    if (chart) { chart.destroy(); chart = null; }

    if (r.error) {
      $main.replaceChildren(
        h('header', { class: 'report-head' }, h('h1', { text: r.title })),
        h('div', { style: 'margin-top:24px' }, errorBox('This report has a mistake in its settings', r.error, 'Fix the file, then refresh this page.')),
      );
      if (!fromUrl) history[replace ? 'replaceState' : 'pushState'](null, '', `#report=${encodeURIComponent(r.id)}`);
      return;
    }

    if (!states[r.id]) states[r.id] = defaultState(r);
    if (!fromUrl) writeUrl(!replace);
    renderReportPage();
    run();
  }

  // report page

  function renderReportPage() {
    ui = {
      drills: h('div', { class: 'drills' }),
      filters: h('div', { class: 'filters', role: 'group', 'aria-label': 'Filters' }),
      body: h('div', { class: 'results-body' }),
      veil: h('div', { class: 'loading-veil', hidden: true }, h('span', { text: 'Running the query…' })),
      compare: h('div', { class: 'compare-slot' }),
      query: h('div', { class: 'query-slot' }),
    };
    $main.replaceChildren(...[
      h('header', { class: 'report-head' },
        h('h1', { text: report.title }),
        report.description ? h('p', { text: report.description }) : null),
      report.hierarchies.length ? ui.drills : null,
      ui.filters,
      h('section', { class: 'results', 'aria-live': 'polite' }, ui.body, ui.veil),
      ui.compare,
      ui.query,
    ].filter(Boolean));
    renderControls();
  }

  function renderControls() {
    renderDrills();
    renderFilters();
  }

  /* Commit a change: update the address bar, redraw the controls, run the query */
  function commit() {
    writeUrl(true);
    renderControls();
    run();
  }

  // drill path (roll-up/drill-down)

  function renderDrills() {
    ui.drills.replaceChildren(...report.hierarchies.map((hName) => {
      const hier = meta.hierarchies[hName];
      const idx = levelIndex(hName);
      const entries = pathEntries(hName, idx);

      const steps = [{ label: hier.allLabel || `All ${plural(hier.levels[0].label)}`, targetLevel: 0, keep: 0 }];
      for (const e of entries) steps.push({ label: fmtDim(e.key, e.value), targetLevel: e.index + 1, keep: e.index + 1 });

      const crumbs = [];
      steps.forEach((step, i) => {
        if (i > 0) crumbs.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '›' }));
        const isCurrent = step.targetLevel === idx && step.keep === entries.length;
        crumbs.push(isCurrent
          ? h('span', { class: 'crumb crumb-current', 'aria-current': 'location', text: step.label })
          : h('button', {
            class: 'crumb',
            type: 'button',
            title: `Roll up to ${step.label}`,
            onclick: () => { setLevel(hName, step.targetLevel); commit(); },
          }, step.label));
      });

      const levelButtons = hier.levels.map((lvl, i) => h('button', {
        type: 'button',
        'aria-pressed': String(i === idx),
        onclick: () => { if (i !== idx) { setLevel(hName, i); commit(); } },
      }, lvl.label));

      return h('div', { class: 'drill' },
        h('div', { class: 'drill-label', text: hier.label }),
        h('nav', { class: 'crumbs', 'aria-label': `${hier.label} path` }, crumbs),
        h('div', { class: 'drill-controls' },
          h('span', { class: 'drill-controls-label', text: 'Break down by' }),
          h('div', { class: 'segmented', role: 'group', 'aria-label': `${hier.label} level` }, levelButtons),
          h('button', {
            class: 'btn',
            type: 'button',
            disabled: idx === 0,
            title: idx > 0 ? `Show ${plural(hier.levels[idx - 1].label)}` : null,
            onclick: () => { setLevel(hName, idx - 1); commit(); },
          }, 'Roll up')));
    }));
  }

  /* Drill one level down into the value of a result row */
  function drillInto(hName, columns, row) {
    const levels = meta.hierarchies[hName].levels;
    const idx = levelIndex(hName);
    if (idx >= levels.length - 1) return;
    const path = {};
    for (let i = 0; i <= idx; i++) {
      const ci = columns.findIndex((c) => c.name === levels[i].key);
      if (ci === -1 || row[ci] === null) return;
      path[levels[i].key] = row[ci];
    }
    st().path[hName] = path;
    st().levels[hName] = levels[idx + 1].key;
    commit();
  }

  // filters (slice/dice)

  function visibleOptions(fKey) {
    const f = meta.filters[fKey];
    if (!f) return [];
    const parentVals = f.parentFilter ? st().filters[f.parentFilter] || [] : [];
    if (!parentVals.length) return f.options;
    const wanted = new Set(parentVals.map(String));
    return f.options.filter((o) => o.parents.some((p) => wanted.has(String(p))));
  }

  /* After a parent filter changes, drop child picks that no longer belong to it */
  function pruneChildren(parentKey) {
    for (const fKey of report.filters) {
      const f = meta.filters[fKey];
      if (!f || f.parentFilter !== parentKey || !st().filters[fKey]) continue;
      const allowed = new Set(visibleOptions(fKey).map((o) => String(o.value)));
      st().filters[fKey] = st().filters[fKey].filter((v) => allowed.has(String(v)));
      pruneChildren(fKey);
    }
  }

  function filterSummary(fKey) {
    const vals = st().filters[fKey] || [];
    if (!vals.length) return 'All';
    const f = meta.filters[fKey];
    const first = f.options.find((o) => String(o.value) === String(vals[0]));
    const label = first ? first.label : String(vals[0]);
    return vals.length === 1 ? label : `${label} +${vals.length - 1}`;
  }

  function renderFilters() {
    const items = [];
    for (const fKey of report.filters) {
      const f = meta.filters[fKey];
      if (!f) continue;
      const active = (st().filters[fKey] || []).length > 0;
      const wrap = h('div', { class: 'filter' });
      const btn = h('button', {
        class: `filter-btn${active ? ' active' : ''}`,
        type: 'button',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
        onclick: () => openFilter(fKey, wrap, btn),
      }, h('span', { text: `${f.label}:` }), h('span', { class: 'value', text: filterSummary(fKey) }), chevron());
      wrap.append(btn);
      items.push(wrap);
    }

    for (const [name, p] of Object.entries(report.params || {})) {
      const value = st().params[name];
      const onchange = (e) => {
        const raw = e.target.value;
        st().params[name] = p.type === 'select' ? (p.options.find((o) => String(o.value) === raw) || {}).value : raw === '' ? p.default : Number(raw);
        commit();
      };
      const input = p.type === 'select'
        ? h('select', { onchange }, p.options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)))
        : h('input', { type: 'number', value, min: p.min, max: p.max, step: p.type === 'integer' ? 1 : 'any', onchange });
      items.push(h('label', { class: 'param' }, p.label, input));
    }

    if (!items.length) {
      ui.filters.replaceChildren();
      ui.filters.hidden = true;
      return;
    }
    ui.filters.hidden = false;
    const anyActive = Object.keys(activeFilters()).length > 0;
    ui.filters.replaceChildren(
      h('span', { class: 'filters-label', text: 'Filter' }),
      ...items,
      ...(anyActive ? [h('button', {
        class: 'btn btn-quiet',
        type: 'button',
        onclick: () => { st().filters = {}; commit(); },
      }, 'Clear filters')] : []),
    );
  }

  function openFilter(fKey, wrap, btn) {
    // Clicking the open filter's own button applies the picks and closes it (same as clicking outside)
    if (wrap.querySelector('.popover')) {
      applyPopover();
      return;
    }
    if (closePopover) closePopover(false);

    const f = meta.filters[fKey];
    const options = visibleOptions(fKey);
    const picked = new Set((st().filters[fKey] || []).map(String));
    let query = '';

    // Options matching the search box (all options when it's empty)
    const matches = () => {
      const q = query.trim().toLowerCase();
      return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    };

    const list = h('ul', { class: 'popover-list' });
    const drawList = () => {
      const shown = matches();
      if (f.error) {
        list.replaceChildren(h('li', { class: 'popover-empty', text: `Couldn't load the choices: ${f.error}` }));
        return;
      }
      if (!shown.length) {
        list.replaceChildren(h('li', { class: 'popover-empty', text: 'No matches' }));
        return;
      }
      list.replaceChildren(...shown.map((o) => {
        const id = String(o.value);
        return h('li', null, h('label', null,
          h('input', {
            type: 'checkbox',
            checked: picked.has(id),
            onchange: (e) => (e.target.checked ? picked.add(id) : picked.delete(id)),
          }),
          o.label === '' ? '(blank)' : o.label));
      }));
    };

    const search = options.length > 10 ? h('input', {
      class: 'popover-search',
      type: 'search',
      placeholder: `Find a ${f.label.toLowerCase()}`,
      'aria-label': `Find a ${f.label.toLowerCase()}`,
      oninput: (e) => { query = e.target.value; drawList(); },
    }) : null;

    const apply = () => {
      const values = options.filter((o) => picked.has(String(o.value))).map((o) => o.value);
      const before = JSON.stringify(st().filters[fKey] || []);
      close(false);
      if (JSON.stringify(values) === before) return;
      st().filters[fKey] = values;
      pruneChildren(fKey);
      commit();
    };

    const pop = h('div', { class: 'popover', role: 'dialog', 'aria-label': `${f.label} filter` },
      search,
      h('div', { class: 'popover-tools' },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { matches().forEach((o) => picked.add(String(o.value))); drawList(); } }, 'Select all'),
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { picked.clear(); drawList(); } }, 'Clear')),
      list,
      h('div', { class: 'popover-foot' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(true) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: apply }, 'Apply')));

    const onDocDown = (e) => { if (!wrap.contains(e.target)) apply(); };
    const onKey = (e) => {
      if (e.key === 'Escape') close(true);
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') apply();
    };
    function close(refocus) {
      pop.remove();
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onDocDown);
      wrap.removeEventListener('keydown', onKey);
      closePopover = null;
      applyPopover = null;
      if (refocus) btn.focus();
    }

    drawList();
    wrap.append(pop);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onDocDown);
    wrap.addEventListener('keydown', onKey);
    closePopover = close;
    applyPopover = apply;
    (search || pop.querySelector('input, button')).focus();
  }

  // running a report

  async function run() {
    const seq = ++runSeq;
    const s = st();
    const id = report.id;
    ui.veil.hidden = false;
    if (!lastResult) ui.body.replaceChildren();
    ui.compare.replaceChildren(); // a comparison belongs to the previous choices

    let res;
    let data;
    try {
      res = await fetch(`/api/reports/${encodeURIComponent(id)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ levels: s.levels, path: s.path, filters: activeFilters(), params: s.params }),
      });
    } catch (err) {
      data = { error: `Lost contact with the server: ${err.message}` };
      res = { ok: false };
    }
    if (!data) {
      try {
        data = await res.json();
      } catch {
        // Not JSON (e.g. the hosting platform's own error page while the app restarts or wakes up)
        data = { error: `The server answered with an error page (HTTP ${res.status}) instead of a report. If the app was just deployed or was asleep, wait a minute and try again.` };
        res = { ok: false };
      }
    }
    if (seq !== runSeq || !report || report.id !== id) return; // a newer query has started
    ui.veil.hidden = true;

    if (!res.ok) {
      lastResult = null;
      if (chart) { chart.destroy(); chart = null; }
      ui.body.replaceChildren(errorBox('The report could not run', data.error, hintFor(data.error)));
      renderQuery(data.sql);
      return;
    }
    lastResult = data;
    renderResults(data);
    renderQuery(data.sql);
  }

  function hintFor(message = '') {
    if (/ECONNREFUSED|connect/i.test(message)) return 'MySQL is not reachable. Start MySQL and check DB_HOST and DB_PORT in the .env file.';
    if (/Access denied/i.test(message)) return 'Check DB_USER and DB_PASSWORD in the .env file.';
    if (/Unknown database/i.test(message)) return 'Check DB_NAME in the .env file, and that the ETL script has been run.';
    if (/doesn't exist|Unknown column|syntax/i.test(message)) return 'This is a problem in the report SQL. Open "Show query" below to see the exact statement that was sent.';
    return null;
  }

  // results

  /* Splits the result columns into dimensions (categories) and values (numbers) */
  function classify(data) {
    const levelKeys = new Set(data.levelKeys);
    const declared = report.measures.map((m) => m.key);
    const valueIdx = [];
    const dimIdx = [];
    data.columns.forEach((c, i) => {
      const isValue = declared.includes(c.name) || (c.numeric && !levelKeys.has(c.name) && !NUMERIC_DIMENSIONS.has(c.name));
      (isValue ? valueIdx : dimIdx).push(i);
    });
    // Declared measures first (in the order the report lists them)
    valueIdx.sort((a, b) => {
      const ra = declared.indexOf(data.columns[a].name);
      const rb = declared.indexOf(data.columns[b].name);
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a - b;
    });
    const levelIdx = dimIdx.filter((i) => levelKeys.has(data.columns[i].name));
    return { valueIdx, dimIdx, levelIdx };
  }

  /* Hierarchies whose current level can still be drilled (with the column holding that level) */
  function drillTargets(columns) {
    const out = [];
    for (const hName of report.hierarchies) {
      const levels = meta.hierarchies[hName].levels;
      const idx = levelIndex(hName);
      if (idx >= levels.length - 1) continue;
      const col = columns.findIndex((c) => c.name === levels[idx].key);
      if (col !== -1) out.push({ hName, col, level: levels[idx], next: levels[idx + 1] });
    }
    return out;
  }

  /* Short label for a chart axis (or just the deepest location/type) */
  function rowLabel(names, values) {
    const has = (n) => names.includes(n);
    const parts = [];
    names.forEach((n, i) => {
      const v = values[i];
      if (n === 'quarter' && has('month')) return;
      if (n === 'region' && has('district_name')) return;
      if (n === 'type' && has('operation')) return;
      if (n === 'operation' && has('k_symbol')) return;
      parts.push(n === 'month' && MONTHS[v - 1] ? MONTHS[v - 1].slice(0, 3) : fmtDim(n, v));
    });
    return parts.join(' ');
  }

  function renderResults(data) {
    const { columns, rows } = data;
    const { valueIdx, dimIdx, levelIdx } = classify(data);
    const s = st();

    // keep the view choices valid for this result
    const valueNames = valueIdx.map((i) => columns[i].name);
    if (!valueNames.includes(s.measure)) s.measure = valueNames[0] || null;
    const pivotChoices = dimIdx.length >= 2 ? dimIdx : [];
    if (s.pivot && !pivotChoices.some((i) => columns[i].name === s.pivot)) s.pivot = '';
    writeUrl(false);

    const isSubtotal = (row) => levelIdx.some((i) => row[i] === null);
    const measureIdx = columns.findIndex((c) => c.name === s.measure);
    const pivotIdx = s.pivot ? columns.findIndex((c) => c.name === s.pivot) : -1;

    // toolbar
    const costText = data.cost === null || data.cost === undefined ? '' : `, estimated cost ${fmtNumber(data.cost)}`;
    const metaText = data.truncated
      ? [`Showing the first ${nf0.format(rows.length)} of `, h('strong', { text: nf0.format(data.rowCount) }), ` rows, query took ${fmtMs(data.ms)}${costText}`]
      : [h('strong', { text: nf0.format(data.rowCount) }), ` ${data.rowCount === 1 ? 'row' : 'rows'}, query took ${fmtMs(data.ms)}${costText}`];

    const controls = [];
    if (valueIdx.length > 1) {
      controls.push(h('label', null, 'Measure',
        h('select', {
          onchange: (e) => { s.measure = e.target.value; writeUrl(false); renderResults(data); },
        }, valueIdx.map((i) => h('option', { value: columns[i].name, selected: columns[i].name === s.measure }, columnLabel(columns[i].name))))));
    }
    if (pivotChoices.length && valueIdx.length) {
      controls.push(h('label', null, 'Pivot',
        h('select', {
          onchange: (e) => { s.pivot = e.target.value; writeUrl(false); renderResults(data); },
        },
        h('option', { value: '', selected: !s.pivot }, 'Off'),
        pivotChoices.map((i) => h('option', { value: columns[i].name, selected: columns[i].name === s.pivot }, `${columnLabel(columns[i].name)} as columns`)))));
    }
    let view = null;
    if (rows.length) controls.push(h('button', { class: 'btn', type: 'button', onclick: () => view && downloadCsv(view) }, 'Download CSV'));
    if (report.hasOriginal) controls.push(h('button', { class: 'btn', type: 'button', onclick: runCompare }, 'Compare with original'));

    const bar = h('div', { class: 'results-bar' },
      h('div', { class: 'results-meta' }, metaText),
      h('div', { class: 'view-controls' }, controls));

    if (!rows.length) {
      if (chart) { chart.destroy(); chart = null; }
      const filtered = Object.keys(activeFilters()).length > 0;
      ui.body.replaceChildren(bar, h('div', { class: 'message' },
        h('h2', { text: 'Nothing to show' }),
        h('p', { text: filtered ? 'No transactions match these filters.' : 'The query returned no rows.' }),
        filtered ? h('button', { class: 'btn', type: 'button', onclick: () => { st().filters = {}; commit(); } }, 'Clear filters') : null));
      return;
    }

    // build the view (flat or pivoted)
    view = pivotIdx !== -1 && measureIdx !== -1
      ? buildPivot(columns, rows, dimIdx, pivotIdx, measureIdx, isSubtotal)
      : buildFlat(columns, rows, dimIdx, valueIdx, measureIdx, isSubtotal);

    // chart
    const panels = [bar];
    if (report.chart !== 'none' && view.series.length && view.chartLabels.length) {
      const canvas = h('canvas', { role: 'img', 'aria-label': view.chartTitle });
      const notes = [];
      let type = report.chart;
      if (type === 'bar' && view.chartLabels.length > BAR_LIMIT) {
        type = 'line';
        notes.push(`Drawn as a line because there are ${nf0.format(view.chartLabels.length)} points.`);
      }
      if (view.seriesTotal > MAX_SERIES) notes.push(`The chart shows the first ${MAX_SERIES} of ${view.seriesTotal} columns; the table shows all of them.`);
      panels.push(h('div', { class: 'panel chart-panel' },
        h('div', { class: 'chart-box' }, canvas),
        notes.length ? h('p', { class: 'chart-note', text: notes.join(' ') }) : null));
      requestAnimationFrame(() => drawChart(canvas, view, type));
    } else if (chart) {
      chart.destroy();
      chart = null;
    }

    // table
    panels.push(h('div', { class: 'panel table-wrap' }, view.table));

    // hint
    const targets = drillTargets(columns);
    let hint;
    if (view.pivoted && targets.length) hint = 'Turn pivot off to drill down from the table.';
    else if (targets.length === 1) hint = `Select a ${targets[0].level.label.toLowerCase()} in the table or chart to see its ${plural(targets[0].next.label)}.`;
    else if (targets.length > 1) hint = 'Select a highlighted value in the table to drill down into it.';
    else if (report.hierarchies.length) hint = 'This is the most detailed level. Use the path above to roll up.';
    if (hint) panels.push(h('p', { class: 'hint', text: hint }));

    ui.body.replaceChildren(...panels);
  }

  function buildFlat(columns, rows, dimIdx, valueIdx, measureIdx, isSubtotal) {
    const targets = drillTargets(columns);
    const valueSet = new Set(valueIdx);
    const order = [...dimIdx, ...valueIdx];
    const wholeRow = targets.length === 1;
    const decimals = new Map(valueIdx.map((i) => [i, needsDecimals(rows.map((r) => r[i]))]));

    const thead = h('thead', null, h('tr', null, order.map((i) => h('th', {
      scope: 'col',
      class: valueSet.has(i) ? 'num' : null,
    }, columnLabel(columns[i].name)))));

    const tbody = h('tbody', null, rows.map((row) => {
      const subtotal = isSubtotal(row);
      const cells = order.map((i) => {
        const name = columns[i].name;
        if (valueSet.has(i)) return h('td', { class: 'num' }, fmtNumber(row[i], decimals.get(i)));
        if (row[i] === null) return h('td', { class: subtotal ? null : 'null' }, subtotal ? 'All' : '');
        const target = !subtotal && targets.find((t) => t.col === i);
        if (target) {
          return h('td', null, h('button', {
            class: 'cell-drill',
            type: 'button',
            title: `Drill into ${fmtDim(name, row[i])}`,
            onclick: (e) => { e.stopPropagation(); drillInto(target.hName, columns, row); },
          }, fmtDim(name, row[i])));
        }
        return h('td', null, fmtDim(name, row[i]));
      });
      const drillable = wholeRow && !subtotal;
      return h('tr', {
        class: subtotal ? 'subtotal' : drillable ? 'drillable' : null,
        onclick: drillable ? () => drillInto(targets[0].hName, columns, row) : null,
      }, cells);
    }));

    // Chart: one series, the chosen measure, subtotal rows left out
    const chartRows = rows.filter((r) => !isSubtotal(r));
    const dimNames = dimIdx.map((i) => columns[i].name);
    const measureLabel = measureIdx !== -1 ? columnLabel(columns[measureIdx].name) : '';
    const levelWords = report.hierarchies.map((hn) => meta.hierarchies[hn].levels[levelIndex(hn)].label.toLowerCase());

    return {
      pivoted: false,
      table: h('table', { class: 'data' }, thead, tbody),
      chartLabels: measureIdx !== -1 ? chartRows.map((r) => rowLabel(dimNames, dimIdx.map((i) => r[i]))) : [],
      series: measureIdx !== -1 ? [{ label: measureLabel, data: chartRows.map((r) => r[measureIdx]) }] : [],
      seriesTotal: 1,
      chartTitle: levelWords.length ? `${measureLabel} by ${levelWords.join(' and ')}` : measureLabel,
      onPick: wholeRow ? (index) => drillInto(targets[0].hName, columns, chartRows[index]) : null,
      csv: {
        header: order.map((i) => columnLabel(columns[i].name)),
        rows: rows.map((r) => order.map((i) => (valueSet.has(i) ? r[i] : r[i] === null && isSubtotal(r) ? 'All' : fmtDim(columns[i].name, r[i])))),
      },
    };
  }

  function buildPivot(columns, rows, dimIdx, pivotIdx, measureIdx, isSubtotal) {
    const rowDims = dimIdx.filter((i) => i !== pivotIdx);
    const pivotName = columns[pivotIdx].name;
    const colKeys = new Map(); // JSON(value) -> value
    const groups = new Map(); // JSON(row dims) -> { dims, cells }

    for (const r of rows) {
      if (isSubtotal(r)) continue;
      const ck = JSON.stringify(r[pivotIdx]);
      if (!colKeys.has(ck)) colKeys.set(ck, r[pivotIdx]);
      const rk = JSON.stringify(rowDims.map((i) => r[i]));
      if (!groups.has(rk)) groups.set(rk, { dims: rowDims.map((i) => r[i]), cells: new Map() });
      groups.get(rk).cells.set(ck, r[measureIdx]);
    }

    const cols = [...colKeys.entries()];
    if (cols.every(([, v]) => typeof v === 'number')) cols.sort((a, b) => a[1] - b[1]);
    const groupList = [...groups.values()];
    const measureLabel = columnLabel(columns[measureIdx].name);
    const decimals = needsDecimals(rows.map((r) => r[measureIdx]));

    const thead = h('thead', null, h('tr', null,
      rowDims.map((i) => h('th', { scope: 'col' }, columnLabel(columns[i].name))),
      cols.map(([, v]) => h('th', { scope: 'col', class: 'num' }, fmtDim(pivotName, v)))));
    const tbody = h('tbody', null, groupList.map((g) => h('tr', null,
      g.dims.map((v, j) => h('td', null, fmtDim(columns[rowDims[j]].name, v))),
      cols.map(([ck]) => (g.cells.has(ck)
        ? h('td', { class: 'num' }, fmtNumber(g.cells.get(ck), decimals))
        : h('td', { class: 'num null' }, '–'))))));

    const rowNames = rowDims.map((i) => columns[i].name);
    return {
      pivoted: true,
      table: h('table', { class: 'data' }, h('caption', { class: 'visually-hidden', text: `${measureLabel}, ${columnLabel(pivotName)} as columns` }), thead, tbody),
      chartLabels: groupList.map((g) => rowLabel(rowNames, g.dims)),
      series: cols.slice(0, MAX_SERIES).map(([ck, v]) => ({
        label: fmtDim(pivotName, v),
        data: groupList.map((g) => (g.cells.has(ck) ? g.cells.get(ck) : null)),
      })),
      seriesTotal: cols.length,
      chartTitle: `${measureLabel} by ${columnLabel(pivotName).toLowerCase()}`,
      onPick: null,
      csv: {
        header: [...rowDims.map((i) => columnLabel(columns[i].name)), ...cols.map(([, v]) => fmtDim(pivotName, v))],
        rows: groupList.map((g) => [...g.dims.map((v, j) => fmtDim(columns[rowDims[j]].name, v)), ...cols.map(([ck]) => (g.cells.has(ck) ? g.cells.get(ck) : ''))]),
      },
    };
  }

  // chart

  function drawChart(canvas, view, type) {
    if (!canvas.isConnected) return;
    if (chart) chart.destroy();
    const font = { family: css('--font'), size: 12 };
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const many = view.chartLabels.length > 60;

    chart = new Chart(canvas, {
      type,
      data: {
        labels: view.chartLabels,
        datasets: view.series.map((s, i) => {
          const color = css(`--series-${i + 1}`);
          return type === 'bar'
            ? { label: s.label, data: s.data, backgroundColor: color, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 44, categoryPercentage: 0.8, barPercentage: 0.9 }
            : { label: s.label, data: s.data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: many ? 0 : 4, pointHoverRadius: 5, tension: 0, spanGaps: false };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reduceMotion ? false : { duration: 250 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          title: { display: true, text: view.chartTitle, align: 'start', color: css('--ink'), font: { ...font, size: 14, weight: '500' }, padding: { bottom: 12 } },
          legend: {
            display: view.series.length > 1,
            position: 'top',
            align: 'start',
            labels: { color: css('--ink-2'), font, usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, boxHeight: 10 },
          },
          tooltip: {
            backgroundColor: css('--ink'),
            titleColor: css('--surface'),
            bodyColor: css('--surface'),
            titleFont: font,
            bodyFont: font,
            padding: 10,
            callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtNumber(ctx.parsed.y)}` },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: css('--line-strong') },
            ticks: { color: css('--muted'), font, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 },
          },
          y: {
            beginAtZero: true,
            grid: { color: css('--grid') },
            border: { display: false },
            ticks: { color: css('--muted'), font, callback: (v) => compact.format(v) },
          },
        },
        onClick: view.onPick ? (evt, els) => { if (els.length) view.onPick(els[0].index); } : undefined,
        onHover: (evt, els) => {
          evt.native.target.style.cursor = view.onPick && els.length ? 'pointer' : 'default';
        },
      },
    });
  }

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (lastResult) renderResults(lastResult);
  });

  // comparison: original vs optimized

  /* Runs the original and the optimized version with the current choices and shows them side by side */
  async function runCompare() {
    const s = st();
    const id = report.id;
    const seq = runSeq; // any new choice runs the report again, which changes runSeq
    ui.compare.replaceChildren(h('div', { class: 'panel compare' }, h('p', { class: 'compare-status', text: 'Running both versions twice…' })));
    ui.compare.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    let res;
    let data;
    try {
      res = await fetch(`/api/reports/${encodeURIComponent(id)}/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ levels: s.levels, path: s.path, filters: activeFilters(), params: s.params }),
      });
    } catch (err) {
      data = { error: `Lost contact with the server: ${err.message}` };
      res = { ok: false };
    }
    if (!data) {
      try {
        data = await res.json();
      } catch {
        data = { error: `The server answered with an error page (HTTP ${res.status}) instead of a comparison. If the app was just deployed or was asleep, wait a minute and try again.` };
        res = { ok: false };
      }
    }
    if (seq !== runSeq || !report || report.id !== id) return; // the choices or the report changed meanwhile
    if (!res.ok) {
      ui.compare.replaceChildren(errorBox('The comparison could not run', data.error));
      return;
    }
    renderCompare(data);
  }

  function renderCompare(data) {
    const column = (title, v) => h('div', { class: 'compare-col' },
      h('h3', { text: title }),
      h('dl', { class: 'compare-stats' },
        h('dt', { text: 'Run 1' }), h('dd', { text: fmtMs(v.ms[0]) }),
        h('dt', { text: 'Run 2' }), h('dd', { text: fmtMs(v.ms[1]) }),
        h('dt', { text: 'Estimated cost' }), h('dd', { text: v.cost === null ? 'not available' : fmtNumber(v.cost) }),
        h('dt', { text: 'Rows' }), h('dd', { text: nf0.format(v.rowCount) })),
      // comment lines dropped so the two queries line up
      h('pre', { class: 'compare-sql' }, h('code', { text: v.sql.replace(/^[ \t]*--.*(\r?\n|$)/gm, '').trim() })));

    // e.g. "4.2× faster", "1.3× slower", or "about the same" when within 5%
    const ratio = (orig, opt, better, worse) => {
      if (!orig || !opt) return 'not available';
      const r = orig / opt;
      if (Math.abs(r - 1) < 0.05) return 'about the same';
      return r > 1 ? `${r.toFixed(1)}× ${better}` : `${(1 / r).toFixed(1)}× ${worse}`;
    };
    // the second runs are compared (both have the data already in memory)
    const timeRatio = ratio(data.original.ms[1], data.optimized.ms[1], 'faster', 'slower');
    const costRatio = ratio(data.original.cost, data.optimized.cost, 'lower', 'higher');

    ui.compare.replaceChildren(h('section', { class: 'panel compare', 'aria-label': 'Original vs optimized' },
      h('h2', { text: 'Original vs optimized' }),
      h('p', { class: `compare-check ${data.sameResults ? 'same' : 'differ'}` },
        data.sameResults
          ? `Same results: both versions returned the same ${nf0.format(data.optimized.rowCount)} rows.`
          : `Results differ: ${data.difference}.`),
      h('p', { class: 'compare-summary', text: `Optimized version: second run ${timeRatio}; estimated cost ${costRatio}.` }),
      h('div', { class: 'compare-grid' }, column('Original', data.original), column('Optimized', data.optimized)),
      h('p', { class: 'hint', text: 'Run 1 may include reading data from disk; run 2 usually has it in memory. Times vary between runs. Estimated cost is MySQL’s own estimate (EXPLAIN), in its cost units.' })));
  }

  // query panel, CSV, errors
  
  function renderQuery(sql) {
    if (!sql) {
      ui.query.replaceChildren();
      return;
    }
    const wasOpen = ui.query.querySelector('details')?.open;
    const code = h('code', { text: sql });
    const copyBtn = h('button', {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(sql);
          copyBtn.textContent = 'Copied';
        } catch {
          const range = document.createRange();
          range.selectNodeContents(code);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          copyBtn.textContent = 'Press Ctrl+C';
        }
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1600);
      },
    }, 'Copy');
    ui.query.replaceChildren(h('details', { class: 'query-details', open: wasOpen || null },
      h('summary', null, 'Show query'),
      h('div', { class: 'panel query-box' }, h('pre', null, code), copyBtn)));
  }

  function downloadCsv(view) {
    const esc = (v) => {
      if (typeof v === 'number' && !Number.isInteger(v)) v = clean(v);
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [view.csv.header, ...view.csv.rows].map((r) => r.map(esc).join(','));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }); // \uFEFF (BOM) makes Excel read the file as UTF-8
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `${report.id}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function errorBox(title, message, hint) {
    return h('div', { class: 'message error', role: 'alert' },
      h('h2', { text: title }),
      message ? h('p', { text: message }) : null,
      hint ? h('p', { text: hint }) : null);
  }

  init();
})();
