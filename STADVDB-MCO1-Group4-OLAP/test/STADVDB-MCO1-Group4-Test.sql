-- ETL functional tests
-- Run on the LOCAL connection after dw_etl.sql (needs both financedata and financedata_dw)
-- Expected: every row in all 3 result tabs says PASS

USE financedata_dw;

-- Test 1-15: warehouse row counts, totals and cleaning rules match the expected values and the source data
SELECT check_name, expected, actual,
       IF(expected = actual, 'PASS', 'FAIL') AS result
FROM (
  SELECT 1 AS n, 'dim_date rows' AS check_name,
         '2191' AS expected,
         CAST((SELECT COUNT(*) FROM dim_date) AS CHAR) AS actual
  UNION ALL
  SELECT 2, 'dim_date min / max full_date',
         '1993-01-01 / 1998-12-31',
         (SELECT CONCAT(MIN(full_date), ' / ', MAX(full_date)) FROM dim_date)
  UNION ALL
  SELECT 3, 'dim_location rows',
         '76',
         CAST((SELECT COUNT(*) FROM dim_location) AS CHAR)
  UNION ALL
  SELECT 4, 'dim_account rows',
         '4500',
         CAST((SELECT COUNT(*) FROM dim_account) AS CHAR)
  UNION ALL
  SELECT 5, 'dim_account card_type',
         'none 3608 / classic 659 / junior 145 / gold 88',
         (SELECT CONCAT('none ', SUM(card_type = 'none'),
                        ' / classic ', SUM(card_type = 'classic'),
                        ' / junior ', SUM(card_type = 'junior'),
                        ' / gold ', SUM(card_type = 'gold'))
          FROM dim_account)
  UNION ALL
  SELECT 6, 'dim_account loan_status',
         'A 203 / B 31 / C 403 / D 45 / NULL 3818',
         (SELECT CONCAT('A ', SUM(loan_status = 'A'),
                        ' / B ', SUM(loan_status = 'B'),
                        ' / C ', SUM(loan_status = 'C'),
                        ' / D ', SUM(loan_status = 'D'),
                        ' / NULL ', SUM(loan_status IS NULL))
          FROM dim_account)
  UNION ALL
  SELECT 7, 'dim_account loan_status_desc = No loan',
         '3818',
         CAST((SELECT COUNT(*) FROM dim_account WHERE loan_status_desc = 'No loan') AS CHAR)
  UNION ALL
  SELECT 8, 'dim_account num_clients = 2',
         '869',
         CAST((SELECT COUNT(*) FROM dim_account WHERE num_clients = 2) AS CHAR)
  UNION ALL
  SELECT 9, 'dim_trans_type rows',
         '14',
         CAST((SELECT COUNT(*) FROM dim_trans_type) AS CHAR)
  UNION ALL
  SELECT 10, 'dim_trans_type rows still VYBER or blank operation',
         '0',
         CAST((SELECT COUNT(*) FROM dim_trans_type
               WHERE type = 'VYBER' OR operation = '') AS CHAR)
  UNION ALL
  SELECT 11, 'fact rows (same as financedata.trans)',
         CAST((SELECT COUNT(*) FROM financedata.trans) AS CHAR),
         CAST((SELECT COUNT(*) FROM fact_transaction) AS CHAR)
  UNION ALL
  SELECT 12, 'fact ROUND(SUM(amount), 1) (same as source)',
         CAST((SELECT ROUND(SUM(amount), 1) FROM financedata.trans) AS CHAR),
         CAST((SELECT ROUND(SUM(amount), 1) FROM fact_transaction) AS CHAR)
  UNION ALL
  SELECT 13, 'fact rows: Debit / Withdrawal in Cash / Regular (incl. 16,666 VYBER)',
         '274675',
         CAST((SELECT COUNT(*) FROM fact_transaction f
               JOIN dim_trans_type tt ON tt.trans_type_id = f.trans_type_id
               WHERE tt.type = 'Debit (Withdrawal)'
                 AND tt.operation = 'Withdrawal in Cash'
                 AND tt.k_symbol = 'Regular Transaction') AS CHAR)
  UNION ALL
  SELECT 14, 'fact rows: Credit / Interest Credited (blank operation)',
         '183114',
         CAST((SELECT COUNT(*) FROM fact_transaction f
               JOIN dim_trans_type tt ON tt.trans_type_id = f.trans_type_id
               WHERE tt.operation = 'Interest Credited') AS CHAR)
  UNION ALL
  SELECT 15, 'fact rows whose district_id <> account.district_id',
         '0',
         CAST((SELECT COUNT(*) FROM fact_transaction f
               JOIN financedata.account a ON a.account_id = f.account_id
               WHERE f.district_id <> a.district_id) AS CHAR)
) checks
ORDER BY n;

-- Test 16: fact rows per transaction type match the expected counts
SELECT tt.trans_type_id, tt.type, tt.operation, tt.k_symbol,
       e.expected,
       COUNT(f.trans_id) AS actual,
       IF(COUNT(f.trans_id) = e.expected, 'PASS', 'FAIL') AS result
FROM dim_trans_type tt
JOIN (SELECT  1 AS id, 30338 AS expected UNION ALL SELECT  2, 34888 UNION ALL
      SELECT  3, 156743 UNION ALL SELECT  4, 183114 UNION ALL SELECT  5, 8036 UNION ALL
      SELECT  6, 115254 UNION ALL SELECT  7, 18477 UNION ALL SELECT  8, 13580 UNION ALL
      SELECT  9, 60972 UNION ALL SELECT 10, 2811 UNION ALL SELECT 11, 23 UNION ALL
      SELECT 12, 155832 UNION ALL SELECT 13, 274675 UNION ALL SELECT 14, 1577) e
  ON e.id = tt.trans_type_id
LEFT JOIN fact_transaction f ON f.trans_type_id = tt.trans_type_id
GROUP BY tt.trans_type_id, tt.type, tt.operation, tt.k_symbol, e.expected
ORDER BY tt.trans_type_id;

-- Test 17: every fact row has the same date, amount and balance as its source transaction
SELECT 'fact rows whose date, amount or balance differs from financedata.trans' AS check_name,
       '0' AS expected,
       CAST(COUNT(*) AS CHAR) AS actual,
       IF(COUNT(*) = 0, 'PASS', 'FAIL') AS result
FROM fact_transaction f
JOIN dim_date d          ON d.date_id = f.date_id
JOIN financedata.trans t ON t.trans_id = f.trans_id
WHERE d.full_date <> t.newdate OR f.amount <> t.amount OR f.balance <> t.balance;
