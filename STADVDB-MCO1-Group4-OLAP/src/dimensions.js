/*
 * The warehouse vocabulary the dashboard is allowed to use.
 *
 * Every table and column below comes from dw_etl.sql (financedata_dw).
 * Report SQL must use these table aliases, 
 * because the dashboard inserts columns like "d.year" or "l.region" into it:
 *
 *   f = fact_transaction
 *   d = dim_date
 *   l = dim_location
 *   a = dim_account
 *   t = dim_trans_type
 *
 * Only the columns listed here can ever be inserted into a query,
 * so a user can't inject SQL through the dashboard (identifiers come from this file),
 * and every value the user picks is escaped before it reaches MySQL.
 */

// Hierarchies: used for roll-up and drill-down.
// Levels are listed from the top (most summarised) to the bottom (most detailed).
// "key" is the column name MySQL returns for "column" (d.year comes back as year),
// so the dashboard can read a clicked row's value and drill into it.
const HIERARCHIES = {
  date: {
    label: 'Time',
    allLabel: 'All years',
    levels: [
      { key: 'year', label: 'Year', column: 'd.year' },
      { key: 'quarter', label: 'Quarter', column: 'd.quarter' },
      { key: 'month', label: 'Month', column: 'd.month' },
      { key: 'day', label: 'Day', column: 'd.day' },
    ],
  },
  location: {
    label: 'Location',
    allLabel: 'All regions',
    levels: [
      { key: 'region', label: 'Region', column: 'l.region' },
      { key: 'district_name', label: 'District', column: 'l.district_name' },
    ],
  },
  trans_type: {
    label: 'Transaction type',
    allLabel: 'All types',
    levels: [
      { key: 'type', label: 'Type', column: 't.type' },
      { key: 'operation', label: 'Operation', column: 't.operation' },
      { key: 'k_symbol', label: 'Purpose', column: 't.k_symbol' },
    ],
  },
};

// Filters: used for slice (one value) and dice (several values / dimensions).
// "options" is the query that lists the choices shown in the dropdown.
// It returns a "value" column, plus optional "label" and "parent" columns.
// "parentFilter" narrows the choices when the parent filter is set
// (pick a region and the district list only shows that region's districts).
const FILTERS = {
  year: {
    label: 'Year',
    column: 'd.year',
    options: 'SELECT DISTINCT year AS value FROM dim_date ORDER BY value',
  },
  quarter: {
    label: 'Quarter',
    column: 'd.quarter',
    options: "SELECT DISTINCT quarter AS value, CONCAT('Q', quarter) AS label FROM dim_date ORDER BY value",
  },
  month: {
    label: 'Month',
    column: 'd.month',
    options: 'SELECT DISTINCT month AS value, month_name AS label FROM dim_date ORDER BY value',
  },
  region: {
    label: 'Region',
    column: 'l.region',
    options: 'SELECT DISTINCT region AS value FROM dim_location ORDER BY value',
  },
  district: {
    label: 'District',
    column: 'l.district_name',
    options: 'SELECT district_name AS value, region AS parent FROM dim_location ORDER BY value',
    parentFilter: 'region',
  },
  type: {
    label: 'Transaction type',
    column: 't.type',
    options: 'SELECT DISTINCT type AS value FROM dim_trans_type ORDER BY value',
  },
  operation: {
    label: 'Operation',
    column: 't.operation',
    options: 'SELECT DISTINCT operation AS value, type AS parent FROM dim_trans_type ORDER BY value',
    parentFilter: 'type',
  },
  k_symbol: {
    label: 'Purpose',
    column: 't.k_symbol',
    options: 'SELECT DISTINCT k_symbol AS value, type AS parent FROM dim_trans_type ORDER BY value',
    parentFilter: 'type',
  },
  card_type: {
    label: 'Card type',
    column: 'a.card_type',
    options: 'SELECT DISTINCT card_type AS value FROM dim_account ORDER BY value',
  },
  frequency: {
    label: 'Statement frequency',
    column: 'a.frequency',
    options: 'SELECT DISTINCT frequency AS value FROM dim_account ORDER BY value',
  },
  loan_status: {
    label: 'Loan status',
    column: 'a.loan_status_desc',
    options: 'SELECT DISTINCT loan_status_desc AS value FROM dim_account ORDER BY value',
  },
  num_clients: {
    label: 'Account holders',
    column: 'a.num_clients',
    options: 'SELECT DISTINCT num_clients AS value FROM dim_account WHERE num_clients IS NOT NULL ORDER BY value',
  },
};

module.exports = { HIERARCHIES, FILTERS };