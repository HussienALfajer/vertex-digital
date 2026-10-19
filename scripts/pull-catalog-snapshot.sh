#!/usr/bin/env bash
# Copies the production catalog into a local, git-ignored snapshot for `pnpm db:seed-local`
# (development only). Read-only on the server: one READ ONLY transaction exports the catalog
# tables as JSON, and the catalog images are packed from the files directory. No customer,
# order, ledger, deposit or credential row is read.
#
#   bash scripts/pull-catalog-snapshot.sh [ssh host, default: vertex] [output dir, default: storage/catalog-snapshot]
#
# The snapshot holds: the categories, games, input fields and products; the margin rules, price
# reviews and price history; the supplier offers, category tree and routes of the real suppliers
# (`wdgzone`, `manual`; never `fake`); the newest supplier and order policies; the stored-file
# rows of the games' images with their files; and `meta.json` (the production admin's id, so the
# seed can give the local admin its actions).
set -euo pipefail

host="${1:-vertex}"
out="${2:-storage/catalog-snapshot}"
site=/srv/digital.vertexmedia.pro
mkdir -p "$out"

# A fresh directory with an unguessable name, root's alone (the server is shared, ADR 0009);
# postgres writes only into its `out` subdirectory. Removed on exit, whatever happens.
remote_dir="$(ssh "$host" 'mktemp -d /tmp/vertexdigital-catalog-snapshot.XXXXXXXXXX')"
trap 'ssh "$host" "rm -r -- \"$remote_dir\""' EXIT

# The export runs as the postgres superuser through runuser, as the deploy scripts read the
# database; default_transaction_read_only makes any write in the session fail.
ssh "$host" "bash -s" <<EOF
set -euo pipefail
umask 077
chmod 711 "$remote_dir"
mkdir -p "$remote_dir/out/tables"
chown -R postgres "$remote_dir/out"
cd /tmp
runuser -u postgres -- env PGOPTIONS='-c default_transaction_read_only=on' \
  psql -d vertex_digital -X -q -v ON_ERROR_STOP=1 -At <<'SQL' > /dev/null
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\o $remote_dir/out/tables/stored_files.json
SELECT coalesce(json_agg(f ORDER BY f.id), '[]') FROM stored_files f
WHERE f.id IN (SELECT cover_file_id FROM catalog_games UNION SELECT id_guide_file_id FROM catalog_games);
\o $remote_dir/out/tables/catalog_categories.json
SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM catalog_categories t;
\o $remote_dir/out/tables/catalog_games.json
SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM catalog_games t;
\o $remote_dir/out/tables/catalog_input_fields.json
SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM catalog_input_fields t;
\o $remote_dir/out/tables/catalog_products.json
SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM catalog_products t;
\o $remote_dir/out/tables/margin_rules.json
SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM margin_rules t;
\o $remote_dir/out/tables/supplier_offers.json
SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM supplier_offers t
WHERE t.supplier_id IN (SELECT id FROM suppliers WHERE code <> 'fake');
\o $remote_dir/out/tables/supplier_categories.json
SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM supplier_categories t
WHERE t.supplier_id IN (SELECT id FROM suppliers WHERE code <> 'fake');
\o $remote_dir/out/tables/product_routes.json
SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM product_routes t
WHERE t.supplier_id IN (SELECT id FROM suppliers WHERE code <> 'fake');
\o $remote_dir/out/tables/price_reviews.json
SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM price_reviews t
WHERE t.route_id IN (SELECT id FROM product_routes WHERE supplier_id IN (SELECT id FROM suppliers WHERE code <> 'fake'));
\o $remote_dir/out/tables/product_prices.json
SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM product_prices t
WHERE t.route_id IN (SELECT id FROM product_routes WHERE supplier_id IN (SELECT id FROM suppliers WHERE code <> 'fake'));
\o $remote_dir/out/tables/supplier_policy.json
SELECT coalesce(json_agg(t), '[]') FROM (SELECT * FROM supplier_policy ORDER BY created_at DESC LIMIT 1) t;
\o $remote_dir/out/tables/order_policy.json
SELECT coalesce(json_agg(t), '[]') FROM (SELECT * FROM order_policy ORDER BY created_at DESC LIMIT 1) t;
\o $remote_dir/out/meta.json
SELECT json_build_object('adminIds', coalesce(json_agg(id), '[]'), 'exportedAt', now()) FROM admin_users;
\o
COMMIT;
SQL
runuser -u postgres -- env PGOPTIONS='-c default_transaction_read_only=on' psql -d vertex_digital -X -At -c \
  "SELECT storage_key FROM stored_files WHERE id IN (SELECT cover_file_id FROM catalog_games UNION SELECT id_guide_file_id FROM catalog_games)" \
  > "$remote_dir/files.txt"
tar -C "$site/shared/files" -czf "$remote_dir/files.tar.gz" -T "$remote_dir/files.txt"
tar -czf "$remote_dir/snapshot.tar.gz" -C "$remote_dir/out" tables meta.json -C "$remote_dir" files.tar.gz
EOF

scp -q "$host:$remote_dir/snapshot.tar.gz" "$out/snapshot.tar.gz"
tar -C "$out" -xzf "$out/snapshot.tar.gz"
mkdir -p "$out/files"
tar -C "$out/files" -xzf "$out/files.tar.gz"
rm "$out/snapshot.tar.gz" "$out/files.tar.gz"
echo "Catalog snapshot written to $out"
