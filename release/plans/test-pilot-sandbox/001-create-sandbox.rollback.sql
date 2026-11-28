-- S4 DRAFT. NOT authorised in S2 and never executed by it (release-rollback needs its own approval). Restrictive by design:
-- explicit drops of the registered tables, the schema WITHOUT cascade and the two roles; any unexpected object or dependency makes a statement fail and nothing is removed.
do $rb$
declare n integer;
begin
  if not exists (select 1 from pg_namespace where nspname = 'dpg_pilot') then
    raise exception 'PILOT_CLEANUP_NOTHING_TO_REMOVE';
  end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'dpg_pilot' and c.relkind in ('r', 'v', 'm', 'S', 'p', 'f') and c.relname not in ('pilot_object', 'pilot_baseline');
  if n > 0 then raise exception 'PILOT_CLEANUP_UNREGISTERED_RELATIONS:%', n; end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'dpg_pilot';
  if n > 0 then raise exception 'PILOT_CLEANUP_UNREGISTERED_FUNCTIONS:%', n; end if;
  select count(*) into n from pg_roles r where r.rolname like 'dpg\_pilot\_%' and r.rolname not in ('dpg_pilot_rw', 'dpg_pilot_ro');
  if n > 0 then raise exception 'PILOT_CLEANUP_UNREGISTERED_ROLES:%', n; end if;
  drop table dpg_pilot.pilot_baseline;
  drop table dpg_pilot.pilot_object;
  drop schema dpg_pilot;
  drop role dpg_pilot_rw;
  drop role dpg_pilot_ro;
end
$rb$
