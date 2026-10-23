// Query 4 (Dice): the year, region and card type filters replace the hardcoded
// 1996-1998, 'YOUR_REGION' and 'classic'.
module.exports = {
  title: 'Transactions by region, operation and card type',
  description: 'Compare how account holders in each region use each kind of transaction, by card type. Narrow it down with the year, region and card type filters.',
  hierarchies: ['location', 'trans_type'],
  defaultLevels: { trans_type: 'operation' },
  filters: ['year', 'region', 'district', 'card_type'],
  defaultFilters: { year: [1998], region: ['Prague'], card_type: ['classic'] },
  measures: {
    total_amount: 'Total amount (CZK)',
    transaction_count: 'Transactions',
  },
  // No chart: with year x region x operation x card type there are too many combinations
  // to plot; the table (or Pivot, e.g. card type as columns) reads better.
  chart: 'none',
};
