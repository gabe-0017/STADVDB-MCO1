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
