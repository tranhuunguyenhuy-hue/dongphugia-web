-- Synthetic "old schema" for the pilot (no Production data, no PII).
create schema dpg_app;
create table dpg_app.products (id serial primary key, name text not null, price_vnd bigint, legacy_note text);
insert into dpg_app.products (name, price_vnd, legacy_note) values ('Bồn cầu A', 2652900, 'x'), ('Bồn cầu B', null, null), ('Lavabo C', 1336600, null), ('Vòi D', null, 'y'), ('Sen E', 3684000, null);
create schema dpg_control;
create table dpg_control.target_contract (project_name text, region text, environment text, hard_database_ceiling_bytes bigint, production_data_allowed boolean, production_writes_allowed boolean);
insert into dpg_control.target_contract values ('dpg-release-ci', 'local', 'ci_synthetic', 367001600, false, false);
