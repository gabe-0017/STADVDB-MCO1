-- Query 1 (Roll-up), optimized version
-- WITH ROLLUP adds a subtotal row for every level above the one shown, plus a grand total.
-- The dashboard shows those rows as "All". No ORDER BY: with ROLLUP it would sort the
-- subtotal rows (NULL) to the top instead of under their group.
-- {{WHERE}} holds the year filter and the drill-down path (both on dim_date d).
SELECT {{LEVEL}},
       SUM(x.transaction_count)      AS transaction_count,
       ROUND(SUM(x.total_amount), 2) AS total_amount,
       ROUND(
           SUM(x.total_amount) / SUM(x.transaction_count), 2
       ) AS average_amount
FROM dim_date d
JOIN (
    SELECT date_id,
           COUNT(*)    AS transaction_count,
           SUM(amount) AS total_amount
    FROM fact_transaction
    GROUP BY date_id
) x ON d.date_id = x.date_id
{{WHERE}}
GROUP BY {{LEVEL}} WITH ROLLUP
