USE financedata_dw;
SELECT d.year,
       SUM(x.transaction_count) AS transaction_count,
       ROUND(SUM(x.total_amount), 2) AS total_amount,
       ROUND(
           SUM(x.total_amount) / SUM(x.transaction_count), 2
       ) AS average_amount
FROM dim_date d
JOIN (
    SELECT date_id,
           COUNT(*) AS transaction_count,
           SUM(amount) AS total_amount
    FROM fact_transaction
    GROUP BY date_id
) x ON d.date_id = x.date_id
GROUP BY d.year WITH ROLLUP;