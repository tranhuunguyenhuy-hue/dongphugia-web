-- DPG-42 (v2): per-object security and definition inventory for the backup scope (names, flags and hashes only, never
-- row data). Compared exactly after the ownership-preserving restore, so a swapped grant, grantor, grant option, RLS flag,
-- sequence definition or column/view definition fails even when aggregate counts stay equal. Scope: psql variable `schemas`.
-- Lines: tacl/cacl/facl/nacl/defacl <object> <grantee> <privilege> <grantor> <grantable> | rls <table> <enabled> <forced>
--        | seqdef <seq> <type> <start> <increment> <min> <max> <cycle> <owned_by> | coldef <table.column> <md5>
--        | viewdef <view> <md5> | ext <extension> (extensions that in-scope objects depend on).
select line from (
  select 'tacl ' || n.nspname || '.' || c.relname || ' ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
         || ' ' || a.privilege_type || ' ' || pg_get_userbyid(a.grantor) || ' ' || a.is_grantable::text as line
    from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
    where n.nspname = any(string_to_array(:'schemas', ',')) and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  union all select 'cacl ' || n.nspname || '.' || c.relname || '.' || att.attname || ' ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
         || ' ' || a.privilege_type || ' ' || pg_get_userbyid(a.grantor) || ' ' || a.is_grantable::text
    from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(att.attacl) a
    where n.nspname = any(string_to_array(:'schemas', ',')) and att.attacl is not null and not att.attisdropped
  union all select 'facl ' || p.oid::regprocedure::text || ' ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
         || ' ' || a.privilege_type || ' ' || pg_get_userbyid(a.grantor) || ' ' || a.is_grantable::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = any(string_to_array(:'schemas', ','))
  union all select 'nacl ' || n.nspname || ' ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
         || ' ' || a.privilege_type || ' ' || pg_get_userbyid(a.grantor) || ' ' || a.is_grantable::text
    from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where n.nspname = any(string_to_array(:'schemas', ','))
  union all select 'defacl ' || coalesce(n.nspname, '*') || ':' || pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text || ' '
         || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ' ' || a.privilege_type || ' ' || pg_get_userbyid(a.grantor) || ' ' || a.is_grantable::text
    from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a
    where n.nspname = any(string_to_array(:'schemas', ','))
  union all select 'rls ' || n.nspname || '.' || c.relname || ' ' || c.relrowsecurity::text || ' ' || c.relforcerowsecurity::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = any(string_to_array(:'schemas', ',')) and c.relkind in ('r', 'p')
  union all select 'seqdef ' || s.schemaname || '.' || s.sequencename || ' ' || s.data_type::text || ' ' || s.start_value || ' ' || s.increment_by || ' ' || s.min_value
         || ' ' || s.max_value || ' ' || s.cycle::text || ' ' || coalesce((select dn.nspname || '.' || dc.relname || '.' || da.attname from pg_depend d
              join pg_class dc on dc.oid = d.refobjid join pg_namespace dn on dn.oid = dc.relnamespace join pg_attribute da on da.attrelid = dc.oid and da.attnum = d.refobjsubid
              where d.classid = 'pg_class'::regclass and d.objid = (quote_ident(s.schemaname) || '.' || quote_ident(s.sequencename))::regclass and d.deptype in ('a', 'i') limit 1), 'unowned')
    from pg_sequences s where s.schemaname = any(string_to_array(:'schemas', ','))
  union all select 'coldef ' || n.nspname || '.' || c.relname || '.' || att.attname || ' ' || md5(format_type(att.atttypid, att.atttypmod) || '|' || att.attnotnull::text || '|'
         || att.attidentity::text || '|' || att.attgenerated::text || '|' || coalesce(pg_get_expr(ad.adbin, ad.adrelid), '') || '|' || coalesce(att.attcollation::regcollation::text, ''))
    from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef ad on ad.adrelid = att.attrelid and ad.adnum = att.attnum
    where n.nspname = any(string_to_array(:'schemas', ',')) and c.relkind in ('r', 'p', 'v', 'm', 'f') and att.attnum > 0 and not att.attisdropped
  union all select 'viewdef ' || n.nspname || '.' || c.relname || ' ' || md5(pg_get_viewdef(c.oid, true))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = any(string_to_array(:'schemas', ',')) and c.relkind in ('v', 'm')
  union all select distinct 'ext ' || e.extname from pg_depend d join pg_extension e on e.oid = d.refobjid
    where d.refclassid = 'pg_extension'::regclass and (
      (d.classid = 'pg_proc'::regclass and d.objid in (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any(string_to_array(:'schemas', ','))))
      or (d.classid = 'pg_type'::regclass and d.objid in (select att.atttypid from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace
                                                         where n.nspname = any(string_to_array(:'schemas', ',')) and att.attnum > 0)))
) s order by line;
