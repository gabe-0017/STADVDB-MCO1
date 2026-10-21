-- =====================================================
-- MCO1 - ETL script: financedata -> financedata_dw
-- Run order: (1) financedata dump, (2) dw_schema.sql, (3) this script
--
-- BEFORE RUNNING IN MYSQL WORKBENCH:
--   The fact load (section 6) takes over a minute. Raise
--   Edit > Preferences > SQL Editor > "DBMS connection read timeout"
--   (e.g. to 600 seconds), then reconnect. Otherwise it fails with
--   Error 2013 "Lost connection to MySQL server during query".
--
-- No UPDATE/DELETE statements are used, so Workbench's
-- Safe Updates mode (error 1175) does not affect this script.
-- =====================================================

USE financedata_dw;

-- -----------------------------------------------------
-- 1. Session settings and empty the tables
-- -----------------------------------------------------
SET SESSION cte_max_recursion_depth = 3000;  -- dim_date needs 2,191 levels (default is 1000)
SET SESSION lc_time_names = 'en_US';         -- so MONTHNAME() returns English names

-- fact table first; TRUNCATE also resets AUTO_INCREMENT, so ids are the same on every run
SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE fact_transaction;
TRUNCATE TABLE dim_date;
TRUNCATE TABLE dim_location;
TRUNCATE TABLE dim_account;
TRUNCATE TABLE dim_trans_type;
SET FOREIGN_KEY_CHECKS = 1;


-- -----------------------------------------------------
-- 2. dim_date: one row per day, 1993-01-01 to 1998-12-31 (2,191 rows)
-- -----------------------------------------------------
INSERT INTO dim_date (full_date, day, month, month_name, quarter, year)
WITH RECURSIVE dates AS (
  SELECT DATE('1993-01-01') AS d
  UNION ALL
  SELECT d + INTERVAL 1 DAY FROM dates WHERE d < '1998-12-31'
)
SELECT d, DAY(d), MONTH(d), MONTHNAME(d), QUARTER(d), YEAR(d)
FROM dates
ORDER BY d;


-- -----------------------------------------------------
-- 3. dim_location: straight copy of district (76 rows)
-- -----------------------------------------------------
INSERT INTO dim_location (district_id, district_name, region, inhabitants, nocities,
                          ratio_urbaninhabitants, average_salary, unemployment,
                          noentrepreneur, nocrimes)
SELECT district_id, district_name, region, inhabitants, nocities,
       ratio_urbaninhabitants, average_salary, unemployment,
       noentrepreneur, nocrimes
FROM financedata.district;


-- -----------------------------------------------------
-- 4. dim_account: account + disp + card + loan (4,500 rows)
--    COALESCE is needed because a LEFT JOIN inserts an explicit NULL,
--    which overrides the column DEFAULT.
-- -----------------------------------------------------
INSERT INTO dim_account (account_id, frequency, date_opened, num_clients, card_type,
                         loan_status, loan_status_desc, loan_amount, loan_duration)
SELECT a.account_id,
       a.frequency,
       a.newdate,
       dc.num_clients,
       COALESCE(ac.card_type, 'none'),
       l.status,
       COALESCE(r.description, 'No loan'),
       l.amount,
       l.duration
FROM financedata.account a
-- number of clients (disp rows) per account
LEFT JOIN (SELECT account_id, COUNT(*) AS num_clients
           FROM financedata.disp
           GROUP BY account_id) dc
       ON dc.account_id = a.account_id
-- card is linked to disp, not to account: card.disp_id -> disp.account_id
LEFT JOIN (SELECT d.account_id, c.type AS card_type
           FROM financedata.card c
           JOIN financedata.disp d ON d.disp_id = c.disp_id) ac
       ON ac.account_id = a.account_id
LEFT JOIN financedata.loan l ON l.account_id = a.account_id
LEFT JOIN financedata.ref_loanstatus r ON r.status = l.status;


-- -----------------------------------------------------
-- 5. Cleaned transactions (helper view) and dim_trans_type (14 rows)
--    The cleaning rules live only in this view; sections 5 and 6
--    both read from it, so the dimension and fact loads can't disagree.
--      rule 1: type 'VYBER' (Czech for withdrawal) -> 'Debit (Withdrawal)'
--      rule 2: blank operation (interest postings) -> 'Interest Credited'
-- -----------------------------------------------------
CREATE OR REPLACE VIEW v_trans_clean AS
SELECT trans_id,
       account_id,
       newdate,
       CASE WHEN type = 'VYBER' THEN 'Debit (Withdrawal)' ELSE type END AS type,
       CASE WHEN operation = '' THEN 'Interest Credited' ELSE operation END AS operation,
       k_symbol,
       amount,
       balance
FROM financedata.trans;

INSERT INTO dim_trans_type (type, operation, k_symbol)
SELECT DISTINCT type, operation, k_symbol
FROM v_trans_clean
ORDER BY type, operation, k_symbol;


-- -----------------------------------------------------
-- 6. fact_transaction: every row of trans (1,056,320 rows)
--    district_id = the account's branch district (account.district_id),
--    not the client's district.
-- -----------------------------------------------------
INSERT INTO fact_transaction (trans_id, date_id, account_id, district_id,
                              trans_type_id, amount, balance)
SELECT t.trans_id,
       dd.date_id,
       t.account_id,
       a.district_id,
       tt.trans_type_id,
       t.amount,
       t.balance
FROM v_trans_clean t
JOIN dim_date dd           ON dd.full_date = t.newdate
JOIN financedata.account a ON a.account_id = t.account_id
JOIN dim_trans_type tt     ON tt.type = t.type
                          AND tt.operation = t.operation
                          AND tt.k_symbol = t.k_symbol;

-- the helper view is not part of the star schema, so remove it
DROP VIEW IF EXISTS v_trans_clean;


-- -----------------------------------------------------
-- 7. Validation
-- -----------------------------------------------------

-- 7.1 Summary: every row should say PASS
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


-- 7.2 dim_trans_type rows and fact rows per type
-- Expected fact_rows for ids 1-14, in this order:
--   30338, 34888, 156743, 183114, 8036, 115254, 18477,
--   13580, 60972, 2811, 23, 155832, 274675, 1577
SELECT tt.trans_type_id, tt.type, tt.operation, tt.k_symbol,
       COUNT(f.trans_id) AS fact_rows
FROM dim_trans_type tt
LEFT JOIN fact_transaction f ON f.trans_type_id = tt.trans_type_id
GROUP BY tt.trans_type_id, tt.type, tt.operation, tt.k_symbol
ORDER BY tt.trans_type_id;
