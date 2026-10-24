-- Query 4 (Dice), optimized version (STRAIGHT_JOIN fixes the join order)
-- {{WHERE}} holds the filters picked in the dashboard (year, region, district, card type)
-- plus the drill-down path. They replace the hardcoded d.year = 1998, l.region = 'Prague'
-- and a.card_type = 'classic'; MySQL applies each one at its table in the join order.
SELECT d.year,
       {{LEVEL}},
       a.card_type,
       COUNT(*)                AS transaction_count,
       ROUND(SUM(f.amount), 2) AS total_amount
FROM dim_location l
STRAIGHT_JOIN dim_date d
STRAIGHT_JOIN fact_transaction f
    ON f.district_id = l.district_id
   AND f.date_id = d.date_id
STRAIGHT_JOIN dim_account a
    ON a.account_id = f.account_id
STRAIGHT_JOIN dim_trans_type t
    ON t.trans_type_id = f.trans_type_id
{{WHERE}}
GROUP BY d.year, {{LEVEL}}, a.card_type
ORDER BY d.year, total_amount DESC
