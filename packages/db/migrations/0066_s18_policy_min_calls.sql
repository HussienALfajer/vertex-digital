-- S18, ADR 0033 (owner, 2026-10-19): health needs at least 10 calls, and a degraded supplier is
-- healthy again only at 95% held 5 minutes. The policy is append-only: a new row copies the one in
-- force with the higher minimum (an admin's higher value is kept) and the recovery defaults.
INSERT INTO supplier_policy (id, price_review_threshold_bp, cost_stale_minutes,
  health_window_minutes, health_min_calls, degraded_success_bp, degraded_p90_ms, down_success_bp,
  down_consecutive_errors, probe_after_minutes, low_stock_units, recover_success_bp,
  recover_minutes, admin_id)
SELECT '01a11d3c-890c-77e7-af29-5a1800000033', price_review_threshold_bp, cost_stale_minutes,
  health_window_minutes, greatest(health_min_calls, 10), degraded_success_bp, degraded_p90_ms,
  down_success_bp, down_consecutive_errors, probe_after_minutes, low_stock_units,
  greatest(9500, degraded_success_bp), 5, NULL
FROM supplier_policy
ORDER BY created_at DESC, id DESC
LIMIT 1
ON CONFLICT DO NOTHING;
