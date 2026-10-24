// Query 1 (Roll-up): totals per year, with subtotals and a grand total from WITH ROLLUP.
module.exports = {
  title: 'Transaction totals over time',
  description: 'How many transactions the bank processed and how much money moved, with subtotals and a grand total. Select a year to break it down by quarter, month or day.',
  hierarchies: ['date'],
  filters: ['year'],
  measures: {
    transaction_count: 'Transactions',
    total_amount: 'Total amount (CZK)',
    average_amount: 'Average amount (CZK)',
  },
  chart: 'bar',
};
