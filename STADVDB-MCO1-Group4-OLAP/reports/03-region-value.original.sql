-- Query 3 (Slice)
-- {{PARAM:year}} is the year picked in the dashboard (default 1998).
-- {{AND_FILTERS}} adds the drill-down path, e.g. AND l.region = 'Prague' when viewing districts.
SELECT {{LEVEL}},
       COUNT(*)                AS transaction_count,
       ROUND(SUM(f.amount), 2) AS total_amount
FROM fact_transaction f
JOIN dim_date d     ON f.date_id = d.date_id
JOIN dim_location l ON f.district_id = l.district_id
WHERE d.year = {{PARAM:year}}
  {{AND_FILTERS}}
GROUP BY {{LEVEL}}
ORDER BY total_amount DESC
