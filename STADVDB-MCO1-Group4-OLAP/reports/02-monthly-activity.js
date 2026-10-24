// Query 2 (Drill-down): monthly detail. The year picked in the filter replaces @selected_year.
module.exports = {
  title: 'Monthly transaction activity',
  description: 'Transactions per month. Pick a year in the filter to focus on it, select a month to see its days, or roll up to quarters and years.',
  hierarchies: ['date'],
  defaultLevels: { date: 'month' },
  filters: ['year'],
  measures: {
    transaction_count: 'Transactions',
    total_amount: 'Total amount (CZK)',
    average_amount: 'Average amount (CZK)',
  },
  chart: 'line',
};
