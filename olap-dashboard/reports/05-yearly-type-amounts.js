// Query 5 (Pivot): one column per year, built in SQL with conditional aggregation.
module.exports = {
  title: 'Yearly amounts by transaction type',
  description: 'Total amount moved by each kind of transaction, with one column per year, to see how each one grew from 1993 to 1998. Select a type or operation to break it down further.',
  hierarchies: ['trans_type'],
  defaultLevels: { trans_type: 'operation' },
  filters: [],
  measures: {
    amount_1993: '1993 (CZK)',
    amount_1994: '1994 (CZK)',
    amount_1995: '1995 (CZK)',
    amount_1996: '1996 (CZK)',
    amount_1997: '1997 (CZK)',
    amount_1998: '1998 (CZK)',
  },
  chart: 'bar',
};
