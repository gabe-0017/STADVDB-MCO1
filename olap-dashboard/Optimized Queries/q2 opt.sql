SELECT d.year, d.quarter, d.month,
       COUNT(*) AS transaction_count,
       ROUND(SUM(f.amount), 2) AS total_amount,
       ROUND(AVG(f.amount), 2) AS average_amount
FROM fact_transaction f
JOIN dim_date d ON f.date_id = d.date_id
GROUP BY d.year, d.quarter, d.month
ORDER BY d.year, d.quarter, d.month;