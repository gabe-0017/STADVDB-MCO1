-- MCO1 - Data Warehouse for financedata
-- Star schema: 1 fact table (fact_transaction) + 4 dimension tables

CREATE DATABASE IF NOT EXISTS financedata_dw;
USE financedata_dw;

DROP TABLE IF EXISTS fact_transaction;
DROP TABLE IF EXISTS dim_date;
DROP TABLE IF EXISTS dim_location;
DROP TABLE IF EXISTS dim_account;
DROP TABLE IF EXISTS dim_trans_type;


-- -----------------------------------------------------
-- dim_date
-- hierarchy: day -> month -> quarter -> year
-- one row per day from 1993-01-01 to 1998-12-31
-- -----------------------------------------------------
CREATE TABLE dim_date (
  date_id INT NOT NULL AUTO_INCREMENT,
  full_date DATE NOT NULL,
  day INT NOT NULL,
  month INT NOT NULL,
  month_name VARCHAR(45) NOT NULL,
  quarter INT NOT NULL,
  year INT NOT NULL,
  PRIMARY KEY (date_id),
  UNIQUE KEY (full_date)
) ENGINE=InnoDB;


-- -----------------------------------------------------
-- dim_location (from the district table)
-- hierarchy: district -> region
-- -----------------------------------------------------
CREATE TABLE dim_location (
  district_id INT NOT NULL,
  district_name VARCHAR(45) NOT NULL,
  region VARCHAR(45) NOT NULL,
  inhabitants INT,
  nocities INT,
  ratio_urbaninhabitants DOUBLE,
  average_salary INT,
  unemployment DOUBLE,
  noentrepreneur INT,
  nocrimes INT,
  PRIMARY KEY (district_id)
) ENGINE=InnoDB;


-- -----------------------------------------------------
-- dim_account
-- account info + disp + card + loan put together in one table
-- (every account has at most 1 loan and at most 1 card so this works)
-- loan_status is the status at the end of the data (Dec 1998)
-- -----------------------------------------------------
CREATE TABLE dim_account (
  account_id INT NOT NULL,
  frequency VARCHAR(45),
  date_opened DATE,
  num_clients INT,                               -- owner + disponent
  card_type VARCHAR(45) DEFAULT 'none',          -- none / junior / classic / gold
  loan_status CHAR(1),                           -- A, B, C, D or NULL if no loan
  loan_status_desc VARCHAR(45) DEFAULT 'No loan',
  loan_amount INT,
  loan_duration INT,                             -- in months
  PRIMARY KEY (account_id)
) ENGINE=InnoDB;


-- -----------------------------------------------------
-- dim_trans_type
-- hierarchy: k_symbol -> operation -> type
-- ex. Household Payment -> Remittance to Another Bank -> Debit
-- -----------------------------------------------------
CREATE TABLE dim_trans_type (
  trans_type_id INT NOT NULL AUTO_INCREMENT,
  type VARCHAR(45) NOT NULL,
  operation VARCHAR(45) NOT NULL,
  k_symbol VARCHAR(45) NOT NULL,
  PRIMARY KEY (trans_type_id)
) ENGINE=InnoDB;


-- -----------------------------------------------------
-- fact_transaction
-- 1 row = 1 transaction from the trans table
-- measures: amount, balance
-- (balance is the account balance after the transaction, so don't SUM it over time)
-- -----------------------------------------------------
CREATE TABLE fact_transaction (
  trans_id INT NOT NULL,
  date_id INT NOT NULL,
  account_id INT NOT NULL,
  district_id INT NOT NULL,
  trans_type_id INT NOT NULL,
  amount DOUBLE NOT NULL,
  balance DOUBLE NOT NULL,
  PRIMARY KEY (trans_id),
  CONSTRAINT fk_fact_date FOREIGN KEY (date_id) REFERENCES dim_date (date_id),
  CONSTRAINT fk_fact_account FOREIGN KEY (account_id) REFERENCES dim_account (account_id),
  CONSTRAINT fk_fact_location FOREIGN KEY (district_id) REFERENCES dim_location (district_id),
  CONSTRAINT fk_fact_trans_type FOREIGN KEY (trans_type_id) REFERENCES dim_trans_type (trans_type_id)
) ENGINE=InnoDB;
