-- Query 5 (Pivot)
-- Each SUM(CASE ...) turns one year into its own column (conditional aggregation).
-- The years are fixed because SQL needs the column list up front; the data covers 1993-1998.
SELECT {{LEVEL}},
       ROUND(SUM(CASE WHEN d.year = 1993 THEN f.amount ELSE 0 END), 2) AS amount_1993,
       ROUND(SUM(CASE WHEN d.year = 1994 THEN f.amount ELSE 0 END), 2) AS amount_1994,
       ROUND(SUM(CASE WHEN d.year = 1995 THEN f.amount ELSE 0 END), 2) AS amount_1995,
       ROUND(SUM(CASE WHEN d.year = 1996 THEN f.amount ELSE 0 END), 2) AS amount_1996,
       ROUND(SUM(CASE WHEN d.year = 1997 THEN f.amount ELSE 0 END), 2) AS amount_1997,
       ROUND(SUM(CASE WHEN d.year = 1998 THEN f.amount ELSE 0 END), 2) AS amount_1998
FROM fact_transaction f
JOIN dim_date d       ON f.date_id = d.date_id
JOIN dim_trans_type t ON f.trans_type_id = t.trans_type_id
{{WHERE}}
GROUP BY {{LEVEL}}
ORDER BY {{LEVEL}}
