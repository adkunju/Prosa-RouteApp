-- store_sku_forecast (25 Sep 2026)
-- Sold per day for each delivery = (delivered − returns linked to THAT delivery) / days until the next visit.
-- One row per store+product+day (a visit split across batches counts once).
-- A delivery is SETTLED once the store was visited on/after its expiry (unsold packs would have come back)
-- or something from it already came back. Only settled deliveries count for the rate and for "sold out";
-- stores with nothing settled yet fall back to all completed deliveries.
-- recent_soldouts: of the last 2 settled deliveries, how many came back empty (app adds +1 pack at 2).
CREATE OR REPLACE VIEW public.store_sku_forecast WITH (security_invoker = true) AS
WITH lines AS (
  SELECT dl.id, COALESCE(dl.store_id, ps.store_id) AS store_id, dl.sku_id, dl.delivered_on, dl.qty_delivered, pb.expires_on
  FROM delivery_lines dl LEFT JOIN plan_stops ps ON ps.id = dl.plan_stop_id LEFT JOIN production_batches pb ON pb.id = dl.batch_id
  WHERE COALESCE(dl.store_id, ps.store_id) IS NOT NULL AND dl.qty_delivered > 0
), rr AS (SELECT delivery_line_id, sum(qty_returned) AS ret FROM returns WHERE delivery_line_id IS NOT NULL GROUP BY delivery_line_id
), store_seen AS (
  SELECT store_id, max(d) AS last_seen FROM (
    SELECT store_id, delivered_on AS d FROM lines
    UNION ALL SELECT store_id, returned_on FROM returns WHERE store_id IS NOT NULL) x
  GROUP BY store_id
), visits AS (
  SELECT l.store_id, l.sku_id, l.delivered_on, sum(l.qty_delivered)::integer AS q, sum(COALESCE(rr.ret, 0))::integer AS ret,
         COALESCE(max(l.expires_on), l.delivered_on + max(sk.shelf_life_days)) AS exp_on
  FROM lines l LEFT JOIN rr ON rr.delivery_line_id = l.id JOIN skus sk ON sk.id = l.sku_id
  GROUP BY l.store_id, l.sku_id, l.delivered_on
), gaps AS (SELECT v.*, lead(v.delivered_on) OVER w AS nxt FROM visits v WINDOW w AS (PARTITION BY v.store_id, v.sku_id ORDER BY v.delivered_on)
), done AS (
  SELECT g.store_id, g.sku_id, g.delivered_on, g.nxt - g.delivered_on AS days_gap,
         GREATEST(g.q - g.ret, 0)::numeric / (g.nxt - g.delivered_on)::numeric AS rate, (g.ret = 0) AS sold_out,
         (ss.last_seen >= g.exp_on OR g.ret > 0) AS settled
  FROM gaps g JOIN store_seen ss ON ss.store_id = g.store_id
  WHERE g.nxt IS NOT NULL AND g.nxt > g.delivered_on
), settled AS (
  SELECT d.*, row_number() OVER (PARTITION BY store_id, sku_id ORDER BY delivered_on DESC) AS rn FROM done d WHERE settled
), s_stats AS (
  SELECT store_id, sku_id, count(rate) AS visit_count, avg(rate) AS avg_rate, COALESCE(stddev(rate), 0::numeric) AS rate_stddev,
         avg(days_gap) AS avg_gap_days, bool_or(sold_out) AS has_stockout_gap,
         (count(*) FILTER (WHERE rn <= 2 AND sold_out))::integer AS recent_soldouts,
         COALESCE(bool_or(sold_out) FILTER (WHERE rn = 1), false) AS last_soldout
  FROM settled GROUP BY store_id, sku_id
), a_stats AS (
  SELECT store_id, sku_id, count(rate) AS visit_count, avg(rate) AS avg_rate, COALESCE(stddev(rate), 0::numeric) AS rate_stddev,
         avg(days_gap) AS avg_gap_days, false AS has_stockout_gap, 0 AS recent_soldouts, false AS last_soldout
  FROM done GROUP BY store_id, sku_id
), stats AS (
  SELECT * FROM s_stats
  UNION ALL
  SELECT a.* FROM a_stats a WHERE NOT EXISTS (SELECT 1 FROM s_stats s WHERE s.store_id = a.store_id AND s.sku_id = a.sku_id)
), latest AS (SELECT DISTINCT ON (store_id, sku_id) store_id, sku_id, delivered_on AS last_visit_date, q AS last_delivered_qty FROM visits ORDER BY store_id, sku_id, delivered_on DESC)
SELECT l.store_id, l.sku_id, s.name AS store_name, sk.name AS sku_name, l.last_visit_date, l.last_delivered_qty, st.visit_count,
       round(st.avg_rate, 2) AS avg_daily_rate, round(st.rate_stddev, 2) AS rate_stddev, round(st.avg_gap_days, 1) AS avg_gap_days,
       st.has_stockout_gap, sk.shelf_life_days, sk.unit_cost, sk.unit_price,
       CASE WHEN st.avg_rate > 0::numeric THEN l.last_visit_date + LEAST((sk.shelf_life_days - 1)::numeric, GREATEST(1::numeric, floor(l.last_delivered_qty::numeric / st.avg_rate)))::integer END AS next_visit_due,
       CASE WHEN st.visit_count < 8 THEN 'low'::text ELSE 'high'::text END AS confidence,
       s.is_pickup, sk.min_delivery_qty, s.pipeline_status, st.recent_soldouts, st.last_soldout
FROM latest l JOIN stats st ON st.store_id = l.store_id AND st.sku_id = l.sku_id JOIN stores s ON s.id = l.store_id JOIN skus sk ON sk.id = l.sku_id
WHERE s.is_active = true AND NOT s.exclude_from_forecast;
REVOKE ALL ON public.store_sku_forecast FROM anon;
