-- Query 3 (Slice), optimized version (derived table)
-- {{PARAM:year}} is the year picked in the dashboard (default 1998).
-- {{WHERE}} adds the drill-down path, e.g. WHERE l.region = 'Prague' when viewing districts.
SELECT {{LEVEL}},
       SUM(dt.transaction_count)      AS transaction_count,
       ROUND(SUM(dt.total_amount), 2) AS total_amount
FROM (
    SELECT f.district_id,
           COUNT(*)      AS transaction_count,
           SUM(f.amount) AS total_amount
    FROM fact_transaction f
    JOIN dim_date d ON f.date_id = d.date_id
    WHERE d.year = {{PARAM:year}}
    GROUP BY f.district_id
) AS dt
JOIN dim_location l ON dt.district_id = l.district_id
{{WHERE}}
GROUP BY {{LEVEL}}
ORDER BY total_amount DESC
