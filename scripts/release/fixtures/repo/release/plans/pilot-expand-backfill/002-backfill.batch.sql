-- Idempotent bounded batch: touches at most 2 unlabelled rows per run, so an interrupted backfill simply continues.
update dpg_app.products set price_label = case when price_vnd is null then 'Liên hệ báo giá' else price_vnd::text || ' đ' end
where id in (select id from dpg_app.products where price_label is null order by id limit 2);
