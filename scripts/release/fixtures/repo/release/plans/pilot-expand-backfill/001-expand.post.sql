select exists (select 1 from information_schema.columns where table_schema = 'dpg_app' and table_name = 'products' and column_name = 'price_label' and is_nullable = 'YES') as ok
