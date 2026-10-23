-- Query 2 (Drill-down), original version: runs as if the team's index didn't exist
-- Starts at the month level ({{LEVEL}} = d.year, d.quarter, d.month); the dashboard shows
-- month numbers as names, so month_name isn't needed.
SELECT {{LEVEL}},
       COUNT(*)                AS transaction_count,
       ROUND(SUM(f.amount), 2) AS total_amount,
       ROUND(AVG(f.amount), 2) AS average_amount
FROM fact_transaction f IGNORE INDEX (idx_fact_date_amount)
JOIN dim_date d ON f.date_id = d.date_id
{{WHERE}}
GROUP BY {{LEVEL}}
ORDER BY {{LEVEL}}
