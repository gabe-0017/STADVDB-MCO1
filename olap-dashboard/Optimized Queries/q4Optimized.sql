SELECT
    d.year,l.region,t.operation,a.card_type,
    COUNT(*) AS transaction_count,
    ROUND(SUM(f.amount), 2) AS total_amount
FROM dim_location l
STRAIGHT_JOIN dim_date d
    ON d.year = 1998
STRAIGHT_JOIN fact_transaction f
    ON f.district_id = l.district_id
   AND f.date_id = d.date_id
STRAIGHT_JOIN dim_account a
    ON a.account_id = f.account_id
   AND a.card_type = 'classic'
STRAIGHT_JOIN dim_trans_type t
    ON t.trans_type_id = f.trans_type_id
WHERE l.region = 'Prague'
GROUP BY
    d.year,
    l.region,
    t.operation,
    a.card_type
ORDER BY
    d.year,
    total_amount DESC;