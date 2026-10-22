STADVDB MCO1 - Group 4: OLAP Dashboard
Live site: https://stadvdb-mco1-group-4.onrender.com

LOCAL RUN REQUIREMENTS
- MySQL 8 and MySQL Workbench
- Node.js 18 or newer

LOCAL RUN STEPS
1. Download or clone this repo.

2. Build the databases in MySQL, in this order (skip if you've done this already):
     a. MCO1 - Dataset financedata.sql - creates the source database (financedata)
     b. dw_schema.sql                  - creates the data warehouse (financedata_dw)
     c. dw_etl.sql                     - loads the warehouse
   - In Workbench, import the dataset (a) with Server -> Data Import (the file is too large to open as a script)
   - Suggestion: Before running the etl (c), set Edit -> Preferences -> SQL Editor -> "DBMS connection read timeout" to 0, to allow long load times (just manually stop it if you think it hanged)

3. In the 'olap-dashboard' folder, put your MySQL username and password in '.env.example', then rename it to '.env'.

4. In cmd/terminal, cd into the 'olap-dashboard' folder and run:
   - npm install
   - npm start

5. Open "http://localhost:3000" in your browser.

LOCAL RUN TESTS
- ETL tests: open "olap-dashboard/test/etl_tests.sql" in Workbench and run it on your local connection. Every row should say PASS.
- OLAP tests: with the dashboard running (step 4), open another cmd/terminal in the 'olap-dashboard' folder and run:
   - npm test
  (results are printed and saved to "test/olap_test_results.csv")
