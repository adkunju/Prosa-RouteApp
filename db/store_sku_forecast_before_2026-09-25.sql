-- store_sku_forecast as it was before 25 Sep 2026 (returns assumed to sit on the NEXT visit's delivery line)
CREATE OR REPLACE VIEW public.store_sku_forecast WITH (security_invoker = true) AS
 WITH lines AS (
         SELECT dl.id,
            COALESCE(dl.store_id, ps.store_id) AS store_id,
            dl.sku_id,
            dl.delivered_on,
            dl.qty_delivered
           FROM delivery_lines dl
             LEFT JOIN plan_stops ps ON ps.id = dl.plan_stop_id
          WHERE COALESCE(dl.store_id, ps.store_id) IS NOT NULL
        ), visit_data AS (
         SELECT l_1.store_id,
            l_1.sku_id,
            l_1.delivered_on,
            l_1.qty_delivered,
            COALESCE(r.qty_returned, 0) AS qty_returned,
            lag(l_1.qty_delivered) OVER w AS prev_delivered,
            lag(l_1.delivered_on) OVER w AS prev_date
           FROM lines l_1
             LEFT JOIN returns r ON r.delivery_line_id = l_1.id
          WINDOW w AS (PARTITION BY l_1.store_id, l_1.sku_id ORDER BY l_1.delivered_on)
        ), gaps AS (
         SELECT visit_data.store_id,
            visit_data.sku_id,
            visit_data.delivered_on,
            visit_data.qty_returned,
            visit_data.prev_delivered,
            visit_data.prev_date,
            visit_data.delivered_on - visit_data.prev_date AS days_gap,
                CASE
                    WHEN visit_data.prev_date IS NOT NULL AND (visit_data.delivered_on - visit_data.prev_date) > 0 THEN GREATEST(visit_data.prev_delivered - visit_data.qty_returned, 0)::numeric / (visit_data.delivered_on - visit_data.prev_date)::numeric
                    ELSE NULL::numeric
                END AS rate,
                CASE
                    WHEN visit_data.qty_returned = 0 AND visit_data.prev_date IS NOT NULL THEN true
                    ELSE false
                END AS possible_stockout
           FROM visit_data
        ), stats AS (
         SELECT gaps.store_id,
            gaps.sku_id,
            count(gaps.rate) AS visit_count,
            avg(gaps.rate) AS avg_rate,
            COALESCE(stddev(gaps.rate), 0::numeric) AS rate_stddev,
            avg(gaps.days_gap) AS avg_gap_days,
            bool_or(gaps.possible_stockout) AS has_stockout_gap
           FROM gaps
          WHERE gaps.rate IS NOT NULL
          GROUP BY gaps.store_id, gaps.sku_id
        ), latest AS (
         SELECT DISTINCT ON (l_1.store_id, l_1.sku_id) l_1.store_id,
            l_1.sku_id,
            l_1.delivered_on AS last_visit_date,
            l_1.qty_delivered AS last_delivered_qty
           FROM lines l_1
          ORDER BY l_1.store_id, l_1.sku_id, l_1.delivered_on DESC
        )
 SELECT l.store_id,
    l.sku_id,
    s.name AS store_name,
    sk.name AS sku_name,
    l.last_visit_date,
    l.last_delivered_qty,
    st.visit_count,
    round(st.avg_rate, 2) AS avg_daily_rate,
    round(st.rate_stddev, 2) AS rate_stddev,
    round(st.avg_gap_days, 1) AS avg_gap_days,
    st.has_stockout_gap,
    sk.shelf_life_days,
    sk.unit_cost,
    sk.unit_price,
        CASE
            WHEN st.avg_rate > 0::numeric THEN l.last_visit_date + LEAST((sk.shelf_life_days - 1)::numeric, GREATEST(1::numeric, floor(l.last_delivered_qty::numeric / st.avg_rate)))::integer
            ELSE NULL::date
        END AS next_visit_due,
        CASE
            WHEN st.visit_count < 8 THEN 'low'::text
            ELSE 'high'::text
        END AS confidence,
    s.is_pickup,
    sk.min_delivery_qty,
    s.pipeline_status
   FROM latest l
     JOIN stats st ON st.store_id = l.store_id AND st.sku_id = l.sku_id
     JOIN stores s ON s.id = l.store_id
     JOIN skus sk ON sk.id = l.sku_id
  WHERE s.is_active = true AND NOT s.exclude_from_forecast;
