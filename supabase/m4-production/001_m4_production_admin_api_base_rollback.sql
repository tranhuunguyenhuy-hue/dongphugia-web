-- Rollback of: M4 PRODUCTION: Admin API role, support tables and products.version (project bonxyxluzlxfkdetryoo).
-- Removes the role, policies and support tables. products.version is deliberately KEPT (harmless; dropping it is a separate decision).

do $$ declare p record; begin for p in select schemaname, tablename, policyname from pg_policies where schemaname = 'dpg_app' and policyname like 'admin_api_%' loop execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename); end loop; end $$;
drop table if exists dpg_app.admin_api_nonces;
drop table if exists dpg_app.admin_api_login_attempts;
do $$ begin if exists (select 1 from pg_roles where rolname='dpg_admin_api') then execute 'revoke dpg_admin_api from postgres'; execute 'drop owned by dpg_admin_api'; execute 'drop role dpg_admin_api'; end if; end $$;
