-- Query 1 (Roll-up)
-- WITH ROLLUP adds a subtotal row for every level above the one shown, plus a grand total.
-- The dashboard shows those rows as "All". No ORDER BY: with ROLLUP it would sort the
-- subtotal rows (NULL) to the top instead of under their group.
SELECT {{LEVEL}},
       COUNT(*)                AS transaction_count,
       ROUND(SUM(f.amount), 2) AS total_amount,
       ROUND(AVG(f.amount), 2) AS average_amount
FROM fact_transaction f
JOIN dim_date d ON f.date_id = d.date_id
{{WHERE}}
GROUP BY {{LEVEL}} WITH ROLLUP
