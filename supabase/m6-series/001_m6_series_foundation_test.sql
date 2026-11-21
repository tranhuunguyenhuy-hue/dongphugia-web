-- M6 (#432) Staging/TEST only. Series reference options for spec "Bo suu tap" + integrity trigger + ledger.
-- Additive and idempotent. The spec definition is resolved by KEY, never by id. Rollback: 001_m6_series_foundation_rollback.sql
do $$ begin
  if not exists (select 1 from dpg_control.target_contract where environment='preview_synthetic' and production_writes_allowed=false and production_data_allowed=false) then
    raise exception 'M6_TARGET_GUARD_FAILED:not_the_synthetic_staging_target';
  end if;
end $$;

insert into dpg_app.spec_definitions(key,label,data_type,is_filterable,is_pdp_visible,sort_order)
select 'Bộ sưu tập','Bộ sưu tập','text',false,true,0
where not exists (select 1 from dpg_app.spec_definitions where key='Bộ sưu tập');

-- One level of series, official brand names. Slug is namespaced by brand (<brand>-<series>); aliases keep legacy spellings.
insert into dpg_app.spec_options(spec_definition_id,value,slug,sort_order,aliases,is_active)
select d.id,v.value,v.slug,v.so,v.aliases,true
from dpg_app.spec_definitions d
cross join (values
  ('toto-ga-series','GA Series',array['GA','GA SERIES']::text[],10),
  ('toto-gb-series','GB Series',array['GB','GB SERIES']::text[],20),
  ('toto-gc-series','GC Series',array['GC','GC SERIES']::text[],30),
  ('toto-ge-series','GE Series',array['GE','GE SERIES']::text[],40),
  ('toto-gf-series','GF Series',array['GF','GF SERIES']::text[],50),
  ('toto-gm-series','GM Series',array['GM','GM SERIES']::text[],60),
  ('toto-go-series','GO Series',array['GO','GO SERIES']::text[],70),
  ('toto-gr-series','GR Series',array['GR','GR SERIES']::text[],80),
  ('toto-gs-series','GS Series',array['GS','GS SERIES']::text[],90),
  ('toto-lb-series','LB Series',array['LB','LB SERIES']::text[],100),
  ('toto-lc-series','LC Series',array['LC','LC SERIES']::text[],110),
  ('toto-lf-series','LF Series',array['LF','LF SERIES']::text[],120),
  ('toto-ln-series','LN Series',array['LN','LN SERIES']::text[],130),
  ('toto-za-series','ZA Series',array['ZA','ZA SERIES']::text[],140),
  ('toto-zl-series','ZL Series',array['ZL','ZL SERIES']::text[],150),
  ('inax-s100-line','S100 LINE',array['S100','Dòng S100']::text[],10),
  ('inax-s200-line','S200 LINE',array['S200','Dòng S200']::text[],20),
  ('inax-s400-line','S400 LINE',array['S400','Dòng S400']::text[],30),
  ('inax-s600-line','S600 LINE',array['S600','Dòng S600']::text[],40)
) as v(slug,value,aliases,so)
where d.key='Bộ sưu tập'
on conflict (spec_definition_id,slug) do nothing;

create schema if not exists dpg_control;
create table if not exists dpg_control.series_assignment_ledger(
  id bigserial primary key, run_id text not null, action text not null,
  product_id integer, sku text not null, series_slug text not null,
  row_existed boolean, before_option_id integer, before_value_text text, before_raw_key text, before_raw_value text,
  before_source text, before_confidence text, evidence_url text, evidence_note text, created_at timestamptz not null default now());
alter table dpg_control.series_assignment_ledger enable row level security;

-- Integrity: a series option can only be attached under the series definition, only if active, and only to a product of the SAME brand.
create or replace function dpg_app.series_assignment_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, dpg_app as $fn$
declare def_id integer; opt record; brand text;
begin
  if new.option_id is null then return new; end if;
  select id into def_id from dpg_app.spec_definitions where key='Bộ sưu tập';
  select spec_definition_id, slug, is_active into opt from dpg_app.spec_options where id=new.option_id;
  if not found then return new; end if;
  if opt.spec_definition_id is distinct from new.spec_definition_id and (opt.spec_definition_id = def_id or new.spec_definition_id = def_id) then
    raise exception 'SERIES_OPTION_DEFINITION_MISMATCH' using errcode='23514';
  end if;
  if new.spec_definition_id = def_id then
    if not opt.is_active then raise exception 'SERIES_OPTION_INACTIVE' using errcode='23514'; end if;
    select b.slug into brand from dpg_app.products p join dpg_app.brands b on b.id=p.brand_id where p.id=new.product_id;
    if brand is null or left(opt.slug, length(brand)+1) <> brand||'-' then
      raise exception 'SERIES_CROSS_BRAND_DENIED' using errcode='23514';
    end if;
  end if;
  return new;
end $fn$;
drop trigger if exists series_assignment_guard on dpg_app.product_spec_values;
create trigger series_assignment_guard before insert or update of option_id, spec_definition_id, product_id
  on dpg_app.product_spec_values for each row execute function dpg_app.series_assignment_guard();
