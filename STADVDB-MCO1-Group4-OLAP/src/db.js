const fs = require('fs');
const mysql = require('mysql2/promise');

/**
 * SSL/TLS settings for hosted MySQL (local MySQL needs none)
 *   DB_SSL=true    Encrypt the connection and verify the server's certificate.
 *   DB_SSL_CA=...  The provider's CA certificate (turns SSL on by itself).
 *                  Either a file path or the certificate text itself.
 */
function sslOptions() {
  const ca = (process.env.DB_SSL_CA || '').trim();
  const on = /^(1|true|yes|on|required)$/i.test(process.env.DB_SSL || '');
  if (!on && !ca) return undefined;

  const ssl = { minVersion: 'TLSv1.2', rejectUnauthorized: true };
  if (ca) {
    // Certificate text pasted into an env var (sometimes with literal "\n" instead of line breaks)
    ssl.ca = ca.includes('-----BEGIN') ? ca.replace(/\\n/g, '\n') : fs.readFileSync(ca, 'utf8');
  }
  return ssl;
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'financedata_dw',
  ssl: sslOptions(),
  waitForConnections: true,
  connectionLimit: 5,
  // DECIMAL results come back as JS numbers instead of strings, so the browser can chart and format them.
  // amount/balance are DOUBLE and are numbers anyway, but SUM()/AVG() over INT columns return DECIMAL.
  decimalNumbers: true,
  // DATE columns come back as 'YYYY-MM-DD' strings, not JS Date objects.
  dateStrings: true,
});

// MySQL itself stops any SELECT that runs longer than the dashboard's time limit. 
// Without this, a query the dashboard has given up on keeps running inside MySQL and slows down everything after it.
const LIMIT_MS = Number(process.env.QUERY_TIMEOUT_MS) || 120000;
pool.on('connection', (conn) => {
  conn.query(`SET SESSION max_execution_time = ${LIMIT_MS}`, (err) => {
    if (err) console.warn(`Could not set max_execution_time: ${err.message}`);
  });
});

module.exports = pool;
