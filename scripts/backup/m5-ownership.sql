-- DPG-42: object ownership and SECURITY DEFINER identity for the backup scope (names only, never row data).
-- Compared after an ownership-preserving scratch restore, so a SECURITY DEFINER function keeps running as its reviewed owner.
-- Scope: psql variable `schemas` (comma separated). Lines: "owner <kind> <role> <secdef|plain> <object>" (object last: may contain spaces).
select line from (
  select 'owner schema ' || pg_get_userbyid(nspowner) || ' plain ' || nspname as line
    from pg_namespace where nspname = any(string_to_array(:'schemas', ','))
  union all select 'owner rel_' || c.relkind::text || ' ' || pg_get_userbyid(c.relowner) || ' plain ' || n.nspname || '.' || c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = any(string_to_array(:'schemas', ',')) and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  union all select 'owner function ' || pg_get_userbyid(p.proowner) || case when p.prosecdef then ' secdef ' else ' plain ' end || p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any(string_to_array(:'schemas', ','))
) o order by line;
