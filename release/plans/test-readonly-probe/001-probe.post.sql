select exists (select 1 from information_schema.tables where table_schema = 'dpg_release' and table_name = 'pilot_probe') as ok
