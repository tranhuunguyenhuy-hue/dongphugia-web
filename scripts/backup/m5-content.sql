-- DPG-42: per-table row count and content digest for the backup scope, evaluated inside the exported snapshot.
-- Output "<schema>.<table> <rows> <digest>"; the digest is an md5 over sorted per-row md5 hashes (no row data is printed).
-- Fixed text-output settings make the digest independent of session defaults. Scope: psql variable `schemas`.
set timezone = 'UTC';
set datestyle = 'ISO, YMD';
set intervalstyle = 'postgres';
set extra_float_digits = 1;
set bytea_output = 'hex';
select format('select %L || '' '' || count(*) || '' '' || coalesce(md5(string_agg(md5(t::text), '''' order by md5(t::text))), ''empty'') from %I.%I t',
              schemaname || '.' || tablename, schemaname, tablename)
  from pg_tables where schemaname = any(string_to_array(:'schemas', ',')) order by schemaname, tablename
\gexec
