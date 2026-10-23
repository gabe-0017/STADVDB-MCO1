require('dotenv').config();

const path = require('path');
const express = require('express');
const pool = require('./src/db');
const { HIERARCHIES, FILTERS } = require('./src/dimensions');
const { loadReports, publicView } = require('./src/reports');
const { buildQuery, InputError } = require('./src/queryBuilder');

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROWS = Number(process.env.MAX_ROWS) || 5000;
const QUERY_TIMEOUT_MS = Number(process.env.QUERY_TIMEOUT_MS) || 120000;
const TIMEOUT_CODES = new Set(['PROTOCOL_SEQUENCE_TIMEOUT', 'ER_QUERY_TIMEOUT']);
// A query stopped for taking too long (by the dashboard) [PROTOCOL_SEQUENCE_TIMEOUT]
// or by MySQL's own max_execution_time limit (set in db.js) [ER_QUERY_TIMEOUT]

// mysql2 column type codes that hold numbers.
// Used to right-align and chart them.
const NUMERIC_TYPES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 246]);

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Chart.js and the fonts are served from node_modules (so the dashboard works without internet)
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));
app.use('/vendor/plex-sans', express.static(path.join(__dirname, 'node_modules', '@fontsource', 'ibm-plex-sans')));
app.use('/vendor/plex-mono', express.static(path.join(__dirname, 'node_modules', '@fontsource', 'ibm-plex-mono')));

/* Choices for one filter dropdown (read from its dimension table) */
async function loadFilterOptions(key, filter) {
  try {
    const [rows] = await pool.query(filter.options);
    // Group rows by value so an option can have several parents
    // (an operation can belong to more than one transaction type)
    const byValue = new Map();
    for (const row of rows) {
      if (row.value === null || row.value === undefined) continue;
      const id = String(row.value);
      if (!byValue.has(id)) {
        byValue.set(id, { value: row.value, label: row.label != null ? String(row.label) : String(row.value), parents: [] });
      }
      if (row.parent != null) byValue.get(id).parents.push(row.parent);
    }
    return { key, label: filter.label, parentFilter: filter.parentFilter || null, options: [...byValue.values()] };
  } catch (err) {
    return { key, label: filter.label, parentFilter: filter.parentFilter || null, options: [], error: err.message };
  }
}

// Everything the page needs to draw its controls
app.get('/api/meta', async (req, res) => {
  const reports = loadReports();
  const usedFilters = new Set(reports.flatMap((r) => r.filters || []));
  const filters = await Promise.all(
    Object.entries(FILTERS)
      .filter(([key]) => usedFilters.has(key))
      .map(([key, f]) => loadFilterOptions(key, f)),
  );

  const hierarchies = {};
  for (const [name, h] of Object.entries(HIERARCHIES)) {
    hierarchies[name] = { label: h.label, allLabel: h.allLabel, levels: h.levels.map(({ key, label }) => ({ key, label })) };
  }

  res.json({
    database: process.env.DB_NAME || 'financedata_dw',
    hierarchies,
    filters: Object.fromEntries(filters.map((f) => [f.key, f])),
    reports: reports.map(publicView),
  });
});

/**
 * MySQL's own estimate of what a query costs, from EXPLAIN FORMAT=JSON (no rows are read).
 * The number is in the optimizer's abstract cost units. null if it can't be read.
 */
async function estimateCost(sql) {
  try {
    const [rows] = await pool.query({ sql: `EXPLAIN FORMAT=JSON ${sql}`, timeout: QUERY_TIMEOUT_MS });
    const plan = JSON.parse(rows[0].EXPLAIN);
    const cost = plan.query_block?.cost_info?.query_cost // explain_json_format_version 1
      ?? plan.estimated_total_cost; // explain_json_format_version 2
    return cost === undefined ? null : Number(cost);
  } catch {
    return null; // a missing estimate shouldn't stop the report from showing
  }
}

/**
 * Checks that two versions of a report returned the same rows (in any order).
 * Measures may differ by 1 cent (DOUBLE sums added in a different order). Returns null if they match.
 */
function compareResults(rowsA, rowsB, measureKeys) {
  if (rowsA.length !== rowsB.length) return `${rowsA.length} rows vs ${rowsB.length} rows`;
  const cols = Object.keys(rowsA[0] || {});
  const colsB = Object.keys(rowsB[0] || {});
  if (cols.join() !== colsB.join()) return `different columns: ${cols.join(', ')} vs ${colsB.join(', ')}`;
  const keyCols = cols.filter((c) => !measureKeys.includes(c));
  const keyOf = (r) => JSON.stringify(keyCols.map((c) => r[c]));
  const byKey = new Map(rowsB.map((r) => [keyOf(r), r]));
  for (const a of rowsA) {
    const b = byKey.get(keyOf(a));
    if (!b) return `row ${keyOf(a)} is missing from one version`;
    for (const c of cols) {
      const same = typeof a[c] === 'number' && typeof b[c] === 'number' ? Math.abs(a[c] - b[c]) <= 0.011 : String(a[c]) === String(b[c]);
      if (!same) return `row ${keyOf(a)}, ${c}: ${a[c]} vs ${b[c]}`;
    }
  }
  return null;
}

// Run one report with the user's drill level, drill path, filters, and parameters
app.post('/api/reports/:id/run', async (req, res) => {
  const report = loadReports().find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (report.error) return res.status(500).json({ error: report.error });

  let built;
  try {
    built = buildQuery(report, req.body || {});
  } catch (err) {
    const status = err instanceof InputError ? 400 : 500;
    return res.status(status).json({ error: err.message });
  }

  const started = process.hrtime.bigint();
  try {
    // rowsAsArray keeps duplicate column names apart and keeps column order
    const [rows, fields] = await pool.query({ sql: built.sql, rowsAsArray: true, timeout: QUERY_TIMEOUT_MS });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    if (!Array.isArray(fields)) {
      return res.status(500).json({ error: 'The report SQL must be a single SELECT statement', sql: built.sql });
    }

    res.json({
      columns: fields.map((f) => ({ name: f.name, numeric: NUMERIC_TYPES.has(f.columnType) })),
      rows: rows.slice(0, MAX_ROWS),
      rowCount: rows.length,
      truncated: rows.length > MAX_ROWS,
      ms,
      cost: await estimateCost(built.sql),
      sql: built.sql,
      levels: built.levels,
      levelKeys: built.levelKeys,
    });
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const timedOut = TIMEOUT_CODES.has(err.code);
    res.status(timedOut ? 504 : 500).json({
      error: timedOut ? `The query took longer than ${QUERY_TIMEOUT_MS / 1000} s and was stopped` : err.sqlMessage || err.message,
      sql: built.sql,
      ms,
    });
  }
});

// Run the original/unoptimized and the optimized version of a report with the same choices.
// Each runs twice, alternating (original, optimized, original, optimized), 
// so both get a first run and a run with the data already in memory.
app.post('/api/reports/:id/compare', async (req, res) => {
  const report = loadReports().find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (report.error) return res.status(500).json({ error: report.error });
  if (!report.originalSql) return res.status(400).json({ error: `No original version: add reports/${report.id}.original.sql` });

  const versions = {};
  try {
    versions.original = { sql: buildQuery({ ...report, sql: report.originalSql }, req.body || {}).sql, ms: [] };
    versions.optimized = { sql: buildQuery(report, req.body || {}).sql, ms: [] };
  } catch (err) {
    return res.status(err instanceof InputError ? 400 : 500).json({ error: err.message });
  }

  const last = {};
  let running = 'original';
  try {
    for (let round = 0; round < 2; round++) {
      for (const name of ['original', 'optimized']) {
        running = name;
        const started = process.hrtime.bigint();
        const [rows] = await pool.query({ sql: versions[name].sql, timeout: QUERY_TIMEOUT_MS });
        versions[name].ms.push(Number(process.hrtime.bigint() - started) / 1e6);
        versions[name].rowCount = rows.length;
        last[name] = rows;
      }
    }
    versions.original.cost = await estimateCost(versions.original.sql);
    versions.optimized.cost = await estimateCost(versions.optimized.sql);
    const difference = compareResults(last.original, last.optimized, report.measures.map((m) => m.key));
    res.json({ ...versions, sameResults: difference === null, difference });
  } catch (err) {
    const timedOut = TIMEOUT_CODES.has(err.code);
    res.status(timedOut ? 504 : 500).json({
      error: `${running === 'original' ? 'Original' : 'Optimized'} version: ${timedOut ? `took longer than ${QUERY_TIMEOUT_MS / 1000} s and was stopped` : err.sqlMessage || err.message}`,
    });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`OLAP dashboard running at http://localhost:${PORT}`);
  pool
    .query('SELECT 1')
    .then(() => console.log(`Connected to MySQL database "${process.env.DB_NAME || 'financedata_dw'}"`))
    .catch((err) => console.error(`Could not connect to MySQL: ${err.message}\nCheck the DB_* settings in your .env file.`));
});
