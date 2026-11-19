-- M5 CDN Phase 0 (read-only): public catalogue identity for provenance checks (id, sku, slug).
select concat_ws(E'\t', id, sku, slug) from dpg_app.products;
