-- Query 4 (Dice)
-- {{WHERE}} holds the filters picked in the dashboard (year, region, district, card type)
-- plus the drill-down path. The alias for dim_trans_type is t (the dashboard expects it).
SELECT d.year,
       {{LEVEL}},
       a.card_type,
       COUNT(*)                AS transaction_count,
       ROUND(SUM(f.amount), 2) AS total_amount
FROM fact_transaction f
JOIN dim_date d       ON f.date_id = d.date_id
JOIN dim_location l   ON f.district_id = l.district_id
JOIN dim_account a    ON f.account_id = a.account_id
JOIN dim_trans_type t ON f.trans_type_id = t.trans_type_id
{{WHERE}}
GROUP BY d.year, {{LEVEL}}, a.card_type
ORDER BY d.year, total_amount DESC
