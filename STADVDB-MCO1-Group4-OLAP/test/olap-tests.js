/*
 * STADVDB MCO1 Group 4 - OLAP functional tests
 *
 * Runs each dashboard report with different parameter values, and checks the results in two ways:
 *   1. Against the SOURCE database (financedata), computed straight from the raw tables without using the warehouse, 
 *      applying the same cleaning rules as the ETL ('VYBER' -> 'Debit (Withdrawal)', blank operation -> 'Interest Credited').
 *   2. Against each other: roll-up subtotals equal the rows below them, 
 *      drilled-down values add up to the level above, 
 *      and slice/pivot totals match report 1.
 *
 * How to run (your local MySQL must have both financedata and financedata_dw):
 *   1. Start the dashboard in one terminal: npm start
 *   2. Run the tests in a second terminal: npm test
 * Every test is printed with PASS/FAIL, and all results are saved to "test/olap_test_results.csv"
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

const BASE_URL = (process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const SOURCE_DB = process.env.TEST_SOURCE_DB || 'financedata';
const OUT_FILE = path.join(__dirname, 'olap_test_results.csv');

// Amounts are DOUBLE, so a SUM done in a different order can round the last cent differently
// Amounts may therefore differ by at most 1 cent (counts must match exactly)
const CENT = 0.011;

const Q1 = '01-transaction-totals';
const Q2 = '02-monthly-activity';
const Q3 = '03-region-value';
const Q4 = '04-region-operation-card';
const Q5 = '05-yearly-type-amounts';
const YEARS = [1993, 1994, 1995, 1996, 1997, 1998];

// The values the tests compare. For each one:
//   name  - the column name the report returns (e.g. total_amount), so the same value can be found in both the dashboard's result and the expected result
//   sql   - how to calculate the expected value from the source data
//   label - short name used in the printed messages and the CSV
//   exact - true = must match exactly (counts); otherwise may differ by 1 cent (amounts)
const COUNT = { name: 'transaction_count', label: 'transactions', sql: 'COUNT(*)', exact: true };
const TOTAL = { name: 'total_amount', label: 'total', sql: 'ROUND(SUM(amount), 2)' };
const AVG = { name: 'average_amount', label: 'average', sql: 'ROUND(AVG(amount), 2)' };
const YEAR_COLS = YEARS.map((y) => ({
  name: `amount_${y}`,
  label: String(y),
  sql: `ROUND(SUM(CASE WHEN year = ${y} THEN amount ELSE 0 END), 2)`,
}));

// Helpers

/* One row per source transaction (cleaned the same way the ETL cleans it) */
function sourceRows(withCard) {
  if (!/^[A-Za-z0-9_]+$/.test(SOURCE_DB)) throw new Error('TEST_SOURCE_DB may only contain letters, digits and _');
  const db = `\`${SOURCE_DB}\``;
  return `
    SELECT t.amount,
           YEAR(t.newdate) AS year, QUARTER(t.newdate) AS quarter,
           MONTH(t.newdate) AS month, DAY(t.newdate) AS day,
           CASE WHEN t.type = 'VYBER' THEN 'Debit (Withdrawal)' ELSE t.type END AS type,
           CASE WHEN t.operation = '' THEN 'Interest Credited' ELSE t.operation END AS operation,
           t.k_symbol,
           dist.region, dist.district_name
           ${withCard ? ", COALESCE(card.card_type, 'none') AS card_type" : ''}
    FROM ${db}.trans t
    JOIN ${db}.account a     ON a.account_id = t.account_id
    JOIN ${db}.district dist ON dist.district_id = a.district_id
    ${withCard ? `LEFT JOIN (SELECT d.account_id, MAX(c.type) AS card_type
                             FROM ${db}.card c JOIN ${db}.disp d ON d.disp_id = c.disp_id
                             GROUP BY d.account_id) card
                         ON card.account_id = t.account_id` : ''}`;
  // The GROUP BY gives one card type per account, 
  // and makes MySQL build this lookup once (with an index) 
  // instead of scanning the card table again for every transaction.
}

/* Expected values, grouped by `keys`, computed from the source database */
async function expected({ keys, measures, where = [], params = [], card = false }) {
  const select = [...keys, ...measures.map((m) => `${m.sql} AS ${m.name}`)].join(', ');
  const sql = `SELECT ${select} FROM (${sourceRows(card)}) s`
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + (keys.length ? ` GROUP BY ${keys.join(', ')}` : '');
  const [rows] = await pool.query(sql, params);
  return rows;
}

/* Runs a report through the dashboard's API (the same request the browser sends) */
async function dashboard(reportId, body = {}) {
  const res = await fetch(`${BASE_URL}/api/reports/${reportId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (data.truncated) throw new Error(`the dashboard cut the result at ${data.rows.length} of ${data.rowCount} rows; raise MAX_ROWS in .env`);
  return data.rows.map((r) => Object.fromEntries(data.columns.map((c, i) => [c.name, r[i]])));
}

/* HTTP status the dashboard answers with (for tests that expect a rejection) */
async function dashboardStatus(reportId, body) {
  try {
    await dashboard(reportId, body);
    return 200;
  } catch (err) {
    if (!err.status) throw err;
    return err.status;
  }
}

const keyOf = (row, keys) => JSON.stringify(keys.map((k) => (row[k] === null || row[k] === undefined ? null : String(row[k]))));
const isDetail = (keys) => (row) => keys.every((k) => row[k] !== null && row[k] !== undefined);
const sum = (rows, name) => rows.reduce((acc, r) => acc + Number(r[name]), 0);
const close = (a, b, tolerance = CENT) => Math.abs(Number(a) - Number(b)) <= tolerance;
const fmt = (n, exact) => Number(n).toLocaleString('en-US', exact
  ? { maximumFractionDigits: 0 }
  : { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* 
 * Row-by-row comparison
 * Returns a list of differences (empty = PASS)
 */
function compareRows(expRows, actRows, keys, measures) {
  const problems = [];
  const exp = new Map(expRows.map((r) => [keyOf(r, keys), r]));
  const act = new Map();
  for (const r of actRows) {
    const k = keyOf(r, keys);
    if (act.has(k)) problems.push(`duplicate row ${k}`);
    act.set(k, r);
  }
  for (const [k, e] of exp) {
    const a = act.get(k);
    if (!a) {
      problems.push(`missing row ${k}`);
      continue;
    }
    for (const m of measures) {
      const ok = m.exact ? Number(e[m.name]) === Number(a[m.name]) : close(e[m.name], a[m.name]);
      if (!ok) problems.push(`${k} ${m.label}: expected ${e[m.name]}, got ${a[m.name]}`);
    }
  }
  for (const k of act.keys()) if (!exp.has(k)) problems.push(`unexpected row ${k}`);
  return problems;
}

/* Short description of a result set (for the expected/actual columns of the CSV) */
function summarize(rows, measures) {
  const parts = measures.slice(0, 2).map((m) => `${m.label} ${fmt(sum(rows, m.name), m.exact)}`);
  return [`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`, ...parts].join('; ');
}

/* The usual test: report rows vs. source rows. */
async function checkAgainstSource({ report, body = {}, keys, measures, where, params, card, actualFilter }) {
  let actual = await dashboard(report, body);
  actual = actual.filter(actualFilter || isDetail(keys));
  const exp = await expected({ keys, measures, where, params, card });
  return {
    expected: summarize(exp, measures),
    actual: summarize(actual, measures),
    problems: compareRows(exp, actual, keys, measures),
    rows: actual,
  };
}

/* "level=quarter; path year=1996; filter year=1995,1997; param year=1998" */
function describeBody(body = {}) {
  const parts = [];
  for (const [, level] of Object.entries(body.levels || {})) parts.push(`level ${level}`);
  for (const p of Object.values(body.path || {})) {
    for (const [k, v] of Object.entries(p)) parts.push(`path ${k}=${v}`);
  }
  for (const [k, v] of Object.entries(body.filters || {})) parts.push(`filter ${k}=${[].concat(v).join(',')}`);
  for (const [k, v] of Object.entries(body.params || {})) parts.push(`param ${k}=${v}`);
  return parts.join('; ') || 'defaults';
}

// Test cases

const tests = [];
const cache = {}; // results reused by the consistency checks

function test(id, report, operation, description, body, fn) {
  tests.push({ id, report, operation, description, body, fn });
}

function defineTests(ctx) {
  const { R1, R2, D2 } = ctx;

  // Report 1: Transaction totals over time (WITH ROLLUP)
  test('Q1-01', Q1, 'Roll-up', 'Yearly count, total and average match the source', {}, async () => {
    const r = await checkAgainstSource({ report: Q1, keys: ['year'], measures: [COUNT, TOTAL, AVG] });
    cache.q1Years = r.rows;
    return r;
  });

  test('Q1-02', Q1, 'Roll-up', 'Grand total row (ROLLUP) equals all source transactions', {}, async () => {
    const rows = await dashboard(Q1, {});
    const grand = rows.filter((row) => row.year === null);
    const exp = await expected({ keys: [], measures: [COUNT, TOTAL, AVG] });
    const problems = grand.length === 1 ? compareRows(exp, grand, [], [COUNT, TOTAL, AVG]) : [`expected 1 grand total row, got ${grand.length}`];
    return { expected: summarize(exp, [COUNT, TOTAL]), actual: summarize(grand, [COUNT, TOTAL]), problems };
  });

  for (const year of [1993, 1996, 1998]) {
    const body = { levels: { date: 'quarter' }, path: { date: { year } } };
    test(`Q1-0${[1993, 1996, 1998].indexOf(year) + 3}`, Q1, 'Drill-down', `Quarters of ${year} match the source`, body, () => checkAgainstSource({
      report: Q1, body, keys: ['year', 'quarter'], measures: [COUNT, TOTAL, AVG], where: ['year = ?'], params: [year],
    }));
  }

  {
    const body = { levels: { date: 'month' }, path: { date: { year: 1997, quarter: 2 } } };
    test('Q1-06', Q1, 'Drill-down', 'Months of Q2 1997 match the source', body, () => checkAgainstSource({
      report: Q1, body, keys: ['year', 'quarter', 'month'], measures: [COUNT, TOTAL, AVG],
      where: ['year = ?', 'quarter = ?'], params: [1997, 2],
    }));
  }

  {
    const body = { levels: { date: 'day' }, path: { date: { year: 1998, quarter: 4, month: 12 } } };
    test('Q1-07', Q1, 'Drill-down', 'Days of December 1998 (lowest level) match the source', body, () => checkAgainstSource({
      report: Q1, body, keys: ['year', 'quarter', 'month', 'day'], measures: [COUNT, TOTAL, AVG],
      where: ['year = ?', 'quarter = ?', 'month = ?'], params: [1998, 4, 12],
    }));
  }

  {
    const body = { levels: { date: 'month' }, path: { date: { year: 1996 } } };
    test('Q1-08', Q1, 'Roll-up', 'Subtotals for 1996 equal the sum of the rows below them', body, async () => {
      const rows = await dashboard(Q1, body);
      const problems = [];
      const months = rows.filter((r) => r.month !== null && r.quarter !== null && r.year !== null);
      const quarterSubs = rows.filter((r) => r.year === 1996 && r.quarter !== null && r.month === null);
      const yearSub = rows.find((r) => r.year === 1996 && r.quarter === null);
      const grand = rows.find((r) => r.year === null);
      if (quarterSubs.length !== 4) problems.push(`expected 4 quarter subtotals, got ${quarterSubs.length}`);
      for (const q of quarterSubs) {
        const below = months.filter((m) => m.quarter === q.quarter);
        if (Number(q.transaction_count) !== sum(below, 'transaction_count')) problems.push(`Q${q.quarter} count ${q.transaction_count} != sum of months ${sum(below, 'transaction_count')}`);
        if (!close(q.total_amount, sum(below, 'total_amount'), CENT * (below.length + 1))) problems.push(`Q${q.quarter} total ${q.total_amount} != sum of months ${sum(below, 'total_amount').toFixed(2)}`);
      }
      if (!yearSub) problems.push('no 1996 subtotal row');
      else {
        if (Number(yearSub.transaction_count) !== sum(quarterSubs, 'transaction_count')) problems.push('1996 count != sum of quarter subtotals');
        if (!close(yearSub.total_amount, sum(quarterSubs, 'total_amount'), CENT * 5)) problems.push('1996 total != sum of quarter subtotals');
      }
      if (!grand || !yearSub || Number(grand.transaction_count) !== Number(yearSub.transaction_count)) problems.push('grand total != 1996 subtotal (only 1996 is shown)');
      return {
        expected: `4 quarter subtotals = sums of their months; 1996 = ${fmt(sum(months, 'transaction_count'), true)} transactions`,
        actual: yearSub ? `1996 subtotal = ${fmt(yearSub.transaction_count, true)} transactions` : 'no subtotal row',
        problems,
      };
    });
  }

  {
    const body = { filters: { year: [1995, 1997] } };
    test('Q1-09', Q1, 'Dice', 'Year filter 1995 + 1997: only those years, and the grand total is their sum', body, async () => {
      const r = await checkAgainstSource({
        report: Q1, body, keys: ['year'], measures: [COUNT, TOTAL, AVG], where: ['year IN (?, ?)'], params: [1995, 1997],
      });
      const rows = await dashboard(Q1, body);
      const grand = rows.find((row) => row.year === null);
      if (!grand || Number(grand.transaction_count) !== sum(r.rows, 'transaction_count')) r.problems.push('grand total != sum of 1995 and 1997');
      return r;
    });
  }

  // Report 2: Monthly transaction activity
  [1993, 1998].forEach((year, i) => {
    const body = { filters: { year: [year] } };
    test(`Q2-0${i + 1}`, Q2, 'Slice', `Months of ${year} (Year filter) match the source`, body, () => checkAgainstSource({
      report: Q2, body, keys: ['year', 'quarter', 'month'], measures: [COUNT, TOTAL, AVG], where: ['year = ?'], params: [year],
    }));
  });

  test('Q2-03', Q2, 'Drill-down', 'All months of all years (no filter) match the source', {}, async () => {
    const r = await checkAgainstSource({ report: Q2, keys: ['year', 'quarter', 'month'], measures: [COUNT, TOTAL, AVG] });
    cache.q2Months = r.rows;
    return r;
  });

  {
    const body = { levels: { date: 'day' }, path: { date: { year: 1996, quarter: 1, month: 2 } } };
    test('Q2-04', Q2, 'Drill-down', 'Days of February 1996 (leap year) match the source', body, () => checkAgainstSource({
      report: Q2, body, keys: ['year', 'quarter', 'month', 'day'], measures: [COUNT, TOTAL, AVG],
      where: ['year = ?', 'month = ?'], params: [1996, 2],
    }));
  }

  {
    const body = { levels: { date: 'quarter' }, filters: { year: [1997] } };
    test('Q2-05', Q2, 'Roll-up', 'Rolled up to quarters of 1997, matches the source', body, () => checkAgainstSource({
      report: Q2, body, keys: ['year', 'quarter'], measures: [COUNT, TOTAL, AVG], where: ['year = ?'], params: [1997],
    }));
  }

  test('Q2-06', Q2, 'Roll-up', 'Monthly totals add up to the yearly totals of report 1', {}, async () => {
    const months = cache.q2Months || (await dashboard(Q2, {}));
    const years = cache.q1Years || (await dashboard(Q1, {})).filter((r) => r.year !== null);
    const problems = [];
    for (const y of years) {
      const ms = months.filter((m) => m.year === y.year);
      if (sum(ms, 'transaction_count') !== Number(y.transaction_count)) problems.push(`${y.year}: months count ${sum(ms, 'transaction_count')} != report 1 ${y.transaction_count}`);
      if (!close(sum(ms, 'total_amount'), y.total_amount, CENT * (ms.length + 1))) problems.push(`${y.year}: months total ${sum(ms, 'total_amount').toFixed(2)} != report 1 ${y.total_amount}`);
    }
    return { expected: summarize(years, [COUNT, TOTAL]), actual: summarize(months, [COUNT, TOTAL]), problems };
  });

  // Report 3: Transaction value by region (slice by year)
  YEARS.forEach((year, i) => {
    const body = { params: { year } };
    test(`Q3-0${i + 1}`, Q3, 'Slice', `Region totals for ${year} match the source, highest first`, body, async () => {
      const r = await checkAgainstSource({
        report: Q3, body, keys: ['region'], measures: [COUNT, TOTAL], where: ['year = ?'], params: [year],
      });
      for (let k = 1; k < r.rows.length; k++) {
        if (Number(r.rows[k].total_amount) > Number(r.rows[k - 1].total_amount)) {
          r.problems.push(`not sorted by total: ${r.rows[k].region} comes after a smaller total`);
          break;
        }
      }
      cache.q3 = cache.q3 || {};
      cache.q3[year] = r.rows;
      return r;
    });
  });

  {
    const body = { levels: { location: 'district_name' }, path: { location: { region: R1 } }, params: { year: 1997 } };
    test('Q3-07', Q3, 'Drill-down', `Districts of ${R1} in 1997 match the source`, body, () => checkAgainstSource({
      report: Q3, body, keys: ['region', 'district_name'], measures: [COUNT, TOTAL],
      where: ['year = ?', 'region = ?'], params: [1997, R1],
    }));
  }

  test('Q3-08', Q3, 'Slice', 'Region totals for each year add up to report 1\'s total for that year', {}, async () => {
    const years = cache.q1Years || (await dashboard(Q1, {})).filter((r) => r.year !== null);
    const problems = [];
    let regionsTotal = 0;
    for (const y of years) {
      const regions = (cache.q3 && cache.q3[y.year]) || (await dashboard(Q3, { params: { year: y.year } }));
      regionsTotal += sum(regions, 'transaction_count');
      if (sum(regions, 'transaction_count') !== Number(y.transaction_count)) problems.push(`${y.year}: regions ${sum(regions, 'transaction_count')} != report 1 ${y.transaction_count}`);
      if (!close(sum(regions, 'total_amount'), y.total_amount, CENT * (regions.length + 1))) problems.push(`${y.year}: regions total != report 1 total`);
    }
    return {
      expected: `${fmt(sum(years, 'transaction_count'), true)} transactions over ${years.length} years`,
      actual: `${fmt(regionsTotal, true)} transactions summed over regions`,
      problems,
    };
  });

  {
    const body = { params: { year: 1999 } };
    test('Q3-09', Q3, 'Validation', 'A year outside the data (1999) is rejected', body, async () => {
      const status = await dashboardStatus(Q3, body);
      return { expected: 'HTTP 400 (rejected)', actual: `HTTP ${status}`, problems: status === 400 ? [] : ['the request was not rejected'] };
    });
  }

  {
    const body = { filters: { region: [R1] } };
    test('Q3-10', Q3, 'Validation', 'A filter this report does not offer is rejected', body, async () => {
      const status = await dashboardStatus(Q3, body);
      return { expected: 'HTTP 400 (rejected)', actual: `HTTP ${status}`, problems: status === 400 ? [] : ['the request was not rejected'] };
    });
  }

  // Report 4: Transactions by region, operation and card type (dice)
  const q4Keys = ['year', 'region', 'type', 'operation', 'card_type'];
  const q4Dice = (id, description, filters, where, params) => {
    const body = { filters };
    test(id, Q4, 'Dice', description, body, async () => {
      const r = await checkAgainstSource({ report: Q4, body, keys: q4Keys, measures: [COUNT, TOTAL], where, params, card: true });
      // every row must respect the chosen filter values
      for (const [col, values] of Object.entries({ year: filters.year, region: filters.region, card_type: filters.card_type })) {
        if (!values) continue;
        const bad = r.rows.filter((row) => !values.map(String).includes(String(row[col])));
        if (bad.length) r.problems.push(`${bad.length} rows outside the ${col} filter`);
      }
      return r;
    });
  };

  q4Dice('Q4-01', `Original query 4: 1996-1998, ${R1}, classic cards`,
    { year: [1996, 1997, 1998], region: [R1], card_type: ['classic'] },
    ['year IN (?, ?, ?)', 'region = ?', 'card_type = ?'], [1996, 1997, 1998, R1, 'classic']);
  q4Dice('Q4-02', '1993 and gold cards, all regions',
    { year: [1993], card_type: ['gold'] }, ['year = ?', 'card_type = ?'], [1993, 'gold']);
  q4Dice('Q4-03', `${R2} and junior cards, all years`,
    { region: [R2], card_type: ['junior'] }, ['region = ?', 'card_type = ?'], [R2, 'junior']);
  q4Dice('Q4-04', 'No filters: every year x region x operation x card type', {}, [], []);

  {
    const body = { levels: { location: 'district_name' }, path: { location: { region: R1 } }, filters: { year: [1997], card_type: ['none'] } };
    test('Q4-05', Q4, 'Drill-down', `Districts of ${R1}, 1997, accounts without a card`, body, () => checkAgainstSource({
      report: Q4, body, keys: ['year', 'region', 'district_name', 'type', 'operation', 'card_type'], measures: [COUNT, TOTAL],
      where: ['region = ?', 'year = ?', 'card_type = ?'], params: [R1, 1997, 'none'], card: true,
    }));
  }

  {
    const body = { levels: { trans_type: 'k_symbol' }, filters: { year: [1998], region: [R2] } };
    test('Q4-06', Q4, 'Drill-down', `Purpose level for ${R2} in 1998`, body, () => checkAgainstSource({
      report: Q4, body, keys: ['year', 'region', 'type', 'operation', 'k_symbol', 'card_type'], measures: [COUNT, TOTAL],
      where: ['year = ?', 'region = ?'], params: [1998, R2], card: true,
    }));
  }

  {
    const body = { levels: { trans_type: 'type' }, filters: { year: [1995] } };
    test('Q4-07', Q4, 'Roll-up', 'Rolled up to transaction type (Credit / Debit) for 1995', body, () => checkAgainstSource({
      report: Q4, body, keys: ['year', 'region', 'type', 'card_type'], measures: [COUNT, TOTAL],
      where: ['year = ?'], params: [1995], card: true,
    }));
  }

  {
    const body = { filters: { region: [R1], district: [D2] } };
    test('Q4-08', Q4, 'Dice', `A district outside the chosen region (${D2} in ${R1}) returns no rows`, body, async () => {
      const rows = await dashboard(Q4, body);
      return { expected: '0 rows', actual: `${rows.length} rows`, problems: rows.length === 0 ? [] : ['rows were returned'] };
    });
  }

  {
    const body = { filters: { region: ["x' OR '1'='1"] } };
    test('Q4-09', Q4, 'Validation', 'Quote characters in a filter value are treated as data, not SQL', body, async () => {
      const rows = await dashboard(Q4, body);
      return { expected: '0 rows (no region has that name)', actual: `${rows.length} rows`, problems: rows.length === 0 ? [] : ['the value changed the query'] };
    });
  }

  // Report 5: Yearly amounts by transaction type (pivot)
  test('Q5-01', Q5, 'Pivot', 'One amount column per year, per operation, matches the source', {}, async () => {
    const r = await checkAgainstSource({ report: Q5, keys: ['type', 'operation'], measures: YEAR_COLS });
    cache.q5 = r.rows;
    return r;
  });

  {
    const body = { levels: { trans_type: 'type' } };
    test('Q5-02', Q5, 'Roll-up', 'Rolled up to transaction type, matches the source', body, () => checkAgainstSource({
      report: Q5, body, keys: ['type'], measures: YEAR_COLS,
    }));
  }

  {
    const body = { levels: { trans_type: 'k_symbol' }, path: { trans_type: { type: 'Credit' } } };
    test('Q5-03', Q5, 'Drill-down', 'Purposes within Credit match the source', body, () => checkAgainstSource({
      report: Q5, body, keys: ['type', 'operation', 'k_symbol'], measures: YEAR_COLS, where: ['type = ?'], params: ['Credit'],
    }));
  }

  {
    const body = { levels: { trans_type: 'k_symbol' }, path: { trans_type: { type: 'Debit (Withdrawal)', operation: 'Withdrawal in Cash' } } };
    test('Q5-04', Q5, 'Drill-down', 'Purposes within Debit (Withdrawal) > Withdrawal in Cash match the source', body, () => checkAgainstSource({
      report: Q5, body, keys: ['type', 'operation', 'k_symbol'], measures: YEAR_COLS,
      where: ['type = ?', 'operation = ?'], params: ['Debit (Withdrawal)', 'Withdrawal in Cash'],
    }));
  }

  test('Q5-05', Q5, 'Pivot', 'Each year column adds up to report 1\'s total for that year', {}, async () => {
    const ops = cache.q5 || (await dashboard(Q5, {}));
    const years = cache.q1Years || (await dashboard(Q1, {})).filter((r) => r.year !== null);
    const problems = [];
    for (const y of years) {
      const col = `amount_${y.year}`;
      if (!close(sum(ops, col), y.total_amount, CENT * (ops.length + 1))) problems.push(`${y.year}: column sum ${sum(ops, col).toFixed(2)} != report 1 ${y.total_amount}`);
    }
    return {
      expected: `report 1 total ${fmt(sum(years, 'total_amount'))}`,
      actual: `sum of year columns ${fmt(YEARS.reduce((acc, y) => acc + sum(ops, `amount_${y}`), 0))}`,
      problems,
    };
  });
}

// Runner

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  console.log(`OLAP functional tests\n  dashboard: ${BASE_URL}\n  expected values from: ${SOURCE_DB} (database "${process.env.DB_NAME || 'financedata_dw'}" server)\n`);

  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    const health = await res.json();
    if (!health.ok) throw new Error(health.error || 'the dashboard cannot reach its database');
  } catch (err) {
    console.error(`Cannot reach the dashboard at ${BASE_URL}: ${err.message}\nStart it first with "npm start" in another terminal.`);
    process.exit(2);
  }

  // Region and district names are read from the data (not hardcoded)
  const db = `\`${SOURCE_DB}\``;
  const [regions] = await pool.query(`SELECT DISTINCT region FROM ${db}.district ORDER BY region`);
  if (regions.length < 2) throw new Error('need at least 2 regions in the source data');
  const R1 = regions[0].region;
  const R2 = regions[1].region;
  const [[d2]] = await pool.query(`SELECT district_name FROM ${db}.district WHERE region = ? ORDER BY district_name LIMIT 1`, [R2]);
  defineTests({ R1, R2, D2: d2.district_name });

  const results = [];
  for (const t of tests) {
    const started = Date.now();
    let outcome;
    try {
      outcome = await t.fn();
    } catch (err) {
      outcome = { expected: '', actual: '', problems: [`error: ${err.message}`] };
    }
    const pass = outcome.problems.length === 0;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${t.id}  ${t.operation.padEnd(10)}  ${t.description}  (${secs} s)`);
    if (!pass) for (const p of outcome.problems.slice(0, 3)) console.log(`        ${p}`);
    results.push({
      test_id: t.id,
      report: t.report,
      operation: t.operation,
      description: t.description,
      parameters: describeBody(t.body),
      expected: outcome.expected,
      actual: outcome.actual,
      result: pass ? 'PASS' : 'FAIL',
      notes: outcome.problems.slice(0, 3).join(' | '),
    });
  }

  const header = Object.keys(results[0]);
  const lines = [header.join(','), ...results.map((r) => header.map((h) => csvCell(r[h])).join(','))];
  fs.writeFileSync(OUT_FILE, `${lines.join('\r\n')}\r\n`);

  const failed = results.filter((r) => r.result === 'FAIL').length;
  console.log(`\n${results.length - failed} of ${results.length} tests passed. Results saved to ${path.relative(process.cwd(), OUT_FILE)}`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`The tests could not run: ${err.message}`);
  await pool.end().catch(() => {});
  process.exit(2);
});