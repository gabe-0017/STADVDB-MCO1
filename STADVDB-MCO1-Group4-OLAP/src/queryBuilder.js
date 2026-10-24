/*
 * Turns a report's SQL template plus the user's choices into one runnable query.
 *
 * Tokens a report's SQL can contain:
 *
 *   {{LEVEL}}        Columns for the current drill level of every hierarchy the report uses (e.g. "d.year, d.quarter").
 *                    Put it in SELECT, GROUP BY and (usually) ORDER BY.
 *   {{LEVEL:date}}   The same, for one hierarchy only (date, location, trans_type).
 *   {{WHERE}}        WHERE <conditions> (or nothing when no filter is active).
 *   {{AND_FILTERS}}  AND <conditions> (for queries that already have a WHERE).
 *   {{PARAM:name}}   The value of a report parameter.
 *
 * The conditions are the drill-down path (e.g. year = 1996 after clicking 1996) plus the slice/dice filters the user picked.
 *
 * Values are escaped with mysql2's escape(),
 * and column names only ever come from src/dimensions.js,
 * so user input can't change the shape of the query.
 */
const { escape } = require('mysql2');
const { HIERARCHIES, FILTERS } = require('./dimensions');

const TOKEN_RE = /\{\{\s*([A-Z_]+)(?:\s*:\s*([A-Za-z0-9_]+))?\s*\}\}/g;
const MAX_FILTER_VALUES = 500;
const EMPTY = '\u0000'; // marks a token that expanded to nothing

class InputError extends Error {}

function isScalar(v) {
  return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200);
}

/* Index of the level the user is looking at for one hierarchy */
function resolveLevelIndex(report, hName, requested) {
  const levels = HIERARCHIES[hName].levels;
  const key = requested || report.defaultLevels[hName] || levels[0].key;
  const idx = levels.findIndex((l) => l.key === key);
  if (idx === -1) throw new InputError(`Unknown level "${key}" for ${HIERARCHIES[hName].label}`);
  return idx;
}

function resolveParam(name, def, raw) {
  const value = raw === undefined || raw === null || raw === '' ? def.default : raw;
  if (def.type === 'select') {
    const allowed = def.options.map((o) => o.value);
    if (!allowed.some((a) => String(a) === String(value))) {
      throw new InputError(`"${value}" is not an allowed value for ${def.label}`);
    }
    return allowed.find((a) => String(a) === String(value));
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new InputError(`${def.label} must be a number`);
  if (def.type === 'integer' && !Number.isInteger(n)) throw new InputError(`${def.label} must be a whole number`);
  if (def.min !== undefined && n < def.min) throw new InputError(`${def.label} must be at least ${def.min}`);
  if (def.max !== undefined && n > def.max) throw new InputError(`${def.label} must be at most ${def.max}`);
  return n;
}

/**
 * @param report  a normalised report (see reports.js)
 * @param input   { levels: {date: 'quarter'}, path: {date: {year: 1996}}, filters: {region: ['Prague']}, params: {top_n: 10} }
 * 
 * @returns { sql, levels: {date: 'quarter'}, levelKeys: ['year', 'quarter'] }
 */
function buildQuery(report, input = {}) {
  const reqLevels = input.levels || {};
  const reqPath = input.path || {};
  const reqFilters = input.filters || {};
  const reqParams = input.params || {};

  const conditions = [];
  const levelColumns = {}; // hierarchy -> ['d.year', 'd.quarter']
  const levelKeys = []; // result-column names of every active level column (in SELECT order)
  const levels = {};

  // 1. Drill level and drill-down path for each hierarchy
  for (const hName of report.hierarchies) {
    const hLevels = HIERARCHIES[hName].levels;
    const idx = resolveLevelIndex(report, hName, reqLevels[hName]);
    levels[hName] = hLevels[idx].key;
    levelColumns[hName] = hLevels.slice(0, idx + 1).map((l) => l.column);
    levelKeys.push(...hLevels.slice(0, idx + 1).map((l) => l.key));

    const path = reqPath[hName] || {};
    for (const [levelKey, value] of Object.entries(path)) {
      const pIdx = hLevels.findIndex((l) => l.key === levelKey);
      if (pIdx === -1) throw new InputError(`Unknown drill level "${levelKey}"`);
      // Only levels above the one being viewed narrow the data.
      // A value for the current level or below is left over from before a roll-up, so drop it.
      if (pIdx >= idx) continue;
      if (!isScalar(value)) throw new InputError(`Invalid drill value for ${hLevels[pIdx].label}`);
      conditions.push(`${hLevels[pIdx].column} = ${escape(value)}`);
    }
  }

  // 2. Slice/dice filters
  for (const [fKey, rawValues] of Object.entries(reqFilters)) {
    if (!report.filters.includes(fKey)) throw new InputError(`This report can't be filtered by "${fKey}"`);
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    if (values.length === 0) continue;
    if (values.length > MAX_FILTER_VALUES) throw new InputError(`Too many values picked for ${FILTERS[fKey].label}`);
    if (!values.every(isScalar)) throw new InputError(`Invalid value picked for ${FILTERS[fKey].label}`);
    const col = FILTERS[fKey].column;
    conditions.push(values.length === 1 ? `${col} = ${escape(values[0])}` : `${col} IN (${values.map((v) => escape(v)).join(', ')})`);
  }

  // 3. Report parameters
  const params = {};
  for (const [name, def] of Object.entries(report.params)) {
    params[name] = resolveParam(name, def, reqParams[name]);
  }

  // 4. Fill in the tokens (only in the SQL itself, not inside comments or quoted strings)
  const tokensUsed = new Set();
  const sql = replaceInCode(report.sql, (code) => code.replace(TOKEN_RE, (match, token, arg) => {
    tokensUsed.add(token);
    switch (token) {
      case 'LEVEL': {
        if (arg) {
          if (!levelColumns[arg]) {
            throw new Error(`${match}: "${arg}" is not in this report's hierarchies [${report.hierarchies.join(', ')}]`);
          }
          return levelColumns[arg].join(', ');
        }
        if (report.hierarchies.length === 0) throw new Error(`${match} is used, but the report lists no hierarchies`);
        return report.hierarchies.map((h) => levelColumns[h].join(', ')).join(', ');
      }
      case 'WHERE':
        return conditions.length ? `WHERE ${conditions.join('\n  AND ')}` : EMPTY;
      case 'AND_FILTERS':
        return conditions.length ? `AND ${conditions.join('\n  AND ')}` : EMPTY;
      case 'PARAM':
        if (!arg || !(arg in params)) throw new Error(`${match}: no parameter named "${arg}" in the report's params`);
        return escape(params[arg]);
      default:
        throw new Error(`Unknown token ${match}`);
    }
  }));

  // A line that held only an empty {{WHERE}} / {{AND_FILTERS}} is removed (so the SQL shown stays tidy)
  const tidy = sql.replace(/^[ \t]*\u0000[ \t]*\r?\n/gm, '').replace(/\u0000/g, '');

  return { sql: tidy.trim(), levels, levelKeys, tokensUsed };
}

/*
 * Applies fn to the parts of the SQL that are code,
 * leaving comments and quoted text untouched,
 * so a token written in a comment is not replaced.
 */
function replaceInCode(sql, fn) {
  let out = '';
  let code = '';
  let i = 0;
  const flush = () => {
    out += fn(code);
    code = '';
  };
  const copyUntil = (end) => {
    flush();
    out += sql.slice(i, end);
    i = end;
  };

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if ((c === '-' && next === '-' && /\s/.test(sql[i + 2] ?? '\n')) || c === '#') {
      const nl = sql.indexOf('\n', i);
      copyUntil(nl === -1 ? sql.length : nl);
    } else if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      copyUntil(close === -1 ? sql.length : close + 2);
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\') j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2; // doubled quote inside a string
        else if (sql[j] === c) break;
        else j += 1;
      }
      copyUntil(Math.min(j + 1, sql.length));
    } else {
      code += c;
      i += 1;
    }
  }
  flush();
  return out;
}

module.exports = { buildQuery, InputError };