-- Derived Tables
SELECT
    l.region,
    SUM(dt.transaction_count) AS transaction_count,
    ROUND(SUM(dt.total_amount), 2) AS total_amount
FROM (
    SELECT
        f.district_id,
        COUNT(*) AS transaction_count,
        SUM(f.amount) AS total_amount
    FROM fact_transaction f
    JOIN dim_date d ON f.date_id = d.date_id
    WHERE d.year = 1998
    GROUP BY f.district_id
) AS dt
JOIN dim_location l ON dt.district_id = l.district_id
GROUP BY l.region
ORDER BY total_amount DESC;