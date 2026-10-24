-- Query 5 (Pivot), optimized version (derived table)
-- Each SUM(CASE ...) turns one year into its own column (conditional aggregation).
-- The years are fixed because SQL needs the column list up front; the data covers 1993-1998.
-- {{WHERE}} adds the drill-down path, e.g. WHERE t.type = 'Credit' when viewing its operations.
SELECT {{LEVEL}},
       ROUND(SUM(CASE WHEN d.year = 1993 THEN dt.total_amount ELSE 0 END), 2) AS amount_1993,
       ROUND(SUM(CASE WHEN d.year = 1994 THEN dt.total_amount ELSE 0 END), 2) AS amount_1994,
       ROUND(SUM(CASE WHEN d.year = 1995 THEN dt.total_amount ELSE 0 END), 2) AS amount_1995,
       ROUND(SUM(CASE WHEN d.year = 1996 THEN dt.total_amount ELSE 0 END), 2) AS amount_1996,
       ROUND(SUM(CASE WHEN d.year = 1997 THEN dt.total_amount ELSE 0 END), 2) AS amount_1997,
       ROUND(SUM(CASE WHEN d.year = 1998 THEN dt.total_amount ELSE 0 END), 2) AS amount_1998
FROM (
    SELECT f.date_id,
           f.trans_type_id,
           SUM(f.amount) AS total_amount
    FROM fact_transaction f
    GROUP BY f.date_id, f.trans_type_id
) AS dt
JOIN dim_date d       ON dt.date_id = d.date_id
JOIN dim_trans_type t ON dt.trans_type_id = t.trans_type_id
{{WHERE}}
GROUP BY {{LEVEL}}
ORDER BY {{LEVEL}}
