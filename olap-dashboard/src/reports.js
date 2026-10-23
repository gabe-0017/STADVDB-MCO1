/*
 * Loads every report in the 'reports' folder.
 *
 * One report = one .js file (its settings).
 * The SQL goes either in the file's "sql" field or in a .sql file with the same name next to it.
 * e.g. 01-monthly-volume.js + 01-monthly-volume.sql
 *
 * Reports appear in the dashboard in file-name order to control the order.
 * i.e. prefix them 01-, 02-, 03-, etc.
 *
 * The folder is re-read on every request,
 * so after editing a report you only need to refresh the browser,
 * not restart the server.
 */
const fs = require('fs');
const path = require('path');
const { HIERARCHIES, FILTERS } = require('./dimensions');
const { buildQuery } = require('./queryBuilder');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const CHART_TYPES = ['bar', 'line', 'none'];

function humanize(name) {
  const s = String(name).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normalizeMeasures(measures) {
  if (!measures) return [];
  if (Array.isArray(measures)) return measures.map((key) => ({ key, label: humanize(key) }));
  return Object.entries(measures).map(([key, label]) => ({ key, label: String(label) }));
}

function normalizeParams(params = {}) {
  const out = {};
  for (const [name, p] of Object.entries(params)) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`params: "${name}" must use only letters, digits and _`);
    const type = p.type || 'integer';
    if (!['integer', 'number', 'select'].includes(type)) throw new Error(`params.${name}.type must be integer, number or select`);
    const def = { type, label: p.label || humanize(name), default: p.default, min: p.min, max: p.max };
    if (type === 'select') {
      if (!Array.isArray(p.options) || p.options.length === 0) throw new Error(`params.${name} needs an options list`);
      def.options = p.options.map((o) => (typeof o === 'object' ? { value: o.value, label: String(o.label ?? o.value) } : { value: o, label: String(o) }));
      if (def.default === undefined) def.default = def.options[0].value;
    } else if (def.default === undefined) {
      throw new Error(`params.${name} needs a default value`);
    }
    out[name] = def;
  }
  return out;
}

function normalize(id, def, sqlFromFile, originalSql) {
  if (!def || typeof def !== 'object') throw new Error('module.exports must be an object');

  const report = {
    id,
    title: String(def.title || humanize(id)),
    description: def.description ? String(def.description) : '',
    hierarchies: def.hierarchies || [],
    defaultLevels: def.defaultLevels || {},
    filters: def.filters || [],
    defaultFilters: def.defaultFilters || {},
    params: normalizeParams(def.params),
    measures: normalizeMeasures(def.measures),
    labels: def.labels || {},
    chart: def.chart || 'bar',
    sql: typeof def.sql === 'string' ? def.sql : sqlFromFile,
  };

  if (!report.sql || !report.sql.trim()) {
    throw new Error(`No SQL found. Add a "sql" field or create reports/${id}.sql`);
  }
  for (const h of report.hierarchies) {
    if (!HIERARCHIES[h]) throw new Error(`hierarchies: unknown "${h}". Use: ${Object.keys(HIERARCHIES).join(', ')}`);
  }
  for (const [h, level] of Object.entries(report.defaultLevels)) {
    if (!report.hierarchies.includes(h)) throw new Error(`defaultLevels: "${h}" is not in hierarchies`);
    if (!HIERARCHIES[h].levels.some((l) => l.key === level)) throw new Error(`defaultLevels: "${level}" is not a level of ${h}`);
  }
  for (const f of report.filters) {
    if (!FILTERS[f]) throw new Error(`filters: unknown "${f}". Use: ${Object.keys(FILTERS).join(', ')}`);
  }
  // Filters already picked when the report opens (the user can change or clear them)
  for (const [f, values] of Object.entries(report.defaultFilters)) {
    if (!report.filters.includes(f)) throw new Error(`defaultFilters: "${f}" is not in filters`);
    if (!Array.isArray(values) || values.length === 0) throw new Error(`defaultFilters.${f} must be a list of values, e.g. [1998]`);
  }
  if (!CHART_TYPES.includes(report.chart)) throw new Error(`chart must be one of: ${CHART_TYPES.join(', ')}`);
  // Dry run with default settings, so a typo in a token shows up as soon as the page loads
  const dryRun = buildQuery(report, {});
  if (report.hierarchies.length && !dryRun.tokensUsed.has('LEVEL')) {
    throw new Error('The report has hierarchies, so its SQL needs a {{LEVEL}} token in SELECT and GROUP BY');
  }
  // The original/unoptimized version must use the same tokens, so both can run with the same choices
  if (originalSql && originalSql.trim()) {
    report.originalSql = originalSql;
    try {
      buildQuery({ ...report, sql: originalSql }, {});
    } catch (err) {
      throw new Error(`${id}.original.sql: ${err.message}`);
    }
  }
  
  // Friendly column headings: level and filter labels, then measures, then the report's own
  const columnLabels = {};
  for (const h of Object.values(HIERARCHIES)) for (const l of h.levels) columnLabels[l.key] = l.label;
  for (const f of Object.values(FILTERS)) columnLabels[f.column.split('.')[1]] = f.label;
  for (const m of report.measures) columnLabels[m.key] = m.label;
  Object.assign(columnLabels, report.labels);
  report.columnLabels = columnLabels;

  return report;
}

function loadReports() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  const files = fs
    .readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
    .sort();

  return files.map((file) => {
    const id = file.replace(/\.js$/, '');
    const full = path.join(REPORTS_DIR, file);
    try {
      delete require.cache[require.resolve(full)];
      const def = require(full);
      const sqlPath = path.join(REPORTS_DIR, `${id}.sql`);
      const sqlFromFile = fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf8') : undefined;
      // Optional unoptimized version, shown by "Compare with original" (e.g. 01-transaction-totals.original.sql)
      const originalPath = path.join(REPORTS_DIR, `${id}.original.sql`);
      const originalSql = fs.existsSync(originalPath) ? fs.readFileSync(originalPath, 'utf8') : undefined;
      return normalize(id, def, sqlFromFile, originalSql);
    } catch (err) {
      return { id, title: humanize(id), error: `reports/${file}: ${err.message}` };
    }
  });
}

/* What the browser needs to draw a report's controls (no SQL) */
function publicView(r) {
  if (r.error) return { id: r.id, title: r.title, error: r.error };
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    hierarchies: r.hierarchies,
    defaultLevels: r.defaultLevels,
    filters: r.filters,
    defaultFilters: r.defaultFilters,
    params: r.params,
    measures: r.measures,
    columnLabels: r.columnLabels,
    chart: r.chart,
    hasOriginal: Boolean(r.originalSql),
  };
}

module.exports = { loadReports, publicView };
