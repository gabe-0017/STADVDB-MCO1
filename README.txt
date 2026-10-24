STADVDB MCO1 - Group 4: OLAP Dashboard
Live site: https://stadvdb-mco1-group-4.onrender.com

LOCAL RUN REQUIREMENTS
- MySQL 8 and MySQL Workbench
- Node.js 18 or newer

LOCAL RUN STEPS
1. Download or clone this repo.

2. Build the databases in MySQL, in this order (skip if you've done this already):
     a. MCO1 - Dataset financedata.sql - creates the source database (financedata)
     b. STADVDB-MCO1-Group4-Schema.sql - creates the data warehouse (financedata_dw)
     c. STADVDB-MCO1-Group4-ETL.sql    - loads the warehouse
   - Note: MCO1 - Dataset financedata.sql is not in this repo (file size exceeds Github's 25MB limit)
   - In Workbench, import the dataset (a) with Server -> Data Import (the file is not recommended to be opened as a script due to its file size)
   - Just run the schema (b) normally in Workbench
   - Before running the etl (c), it's recommended to set Edit -> Preferences -> SQL Editor -> "DBMS connection read timeout" to 0, to allow long load times (just manually stop it if you think it hanged)

3. In the 'STADVDB-MCO1-Group4-OLAP' folder, put your MySQL username and password in '.env.example', then rename it to '.env'.

4. In cmd/terminal, cd into the 'STADVDB-MCO1-Group4-OLAP' folder and run:
   - npm install
   - npm start

5. Open "http://localhost:3000" in your browser.

LOCAL RUN TESTS
- ETL tests: open "STADVDB-MCO1-Group4-OLAP/test/STADVDB-MCO1-Group4-Test.sql" in Workbench and run it on your local connection. Every row should say PASS.
- OLAP tests: with the dashboard running (step 4), open another cmd/terminal in the 'STADVDB-MCO1-Group4-OLAP' folder and run:
   - npm test
   - (results are printed and saved to "test/olap_test_results.csv")
