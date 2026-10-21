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
      sql: built.sql,
      levels: built.levels,
      levelKeys: built.levelKeys,
    });
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const timedOut = err.code === 'PROTOCOL_SEQUENCE_TIMEOUT';
    res.status(timedOut ? 504 : 500).json({
      error: timedOut ? `The query took longer than ${QUERY_TIMEOUT_MS / 1000} s and was stopped` : err.sqlMessage || err.message,
      sql: built.sql,
      ms,
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