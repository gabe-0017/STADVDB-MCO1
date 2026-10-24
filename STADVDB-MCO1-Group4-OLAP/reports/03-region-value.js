// Query 3 (Slice): one year at a time. The Year input replaces the hardcoded 1998.
module.exports = {
  title: 'Transaction value by region',
  description: 'Which regions move the most money in a given year, ranked from highest to lowest. Select a region to compare its districts.',
  hierarchies: ['location'],
  filters: [],
  params: {
    year: {
      type: 'select',
      label: 'Year',
      default: 1998,
      options: [1993, 1994, 1995, 1996, 1997, 1998],
    },
  },
  measures: {
    total_amount: 'Total amount (CZK)',
    transaction_count: 'Transactions',
  },
  chart: 'bar',
};
