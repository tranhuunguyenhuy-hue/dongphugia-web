-- S4 (separately approved; destructive cleanup): removes ONLY what 001-create-sandbox registered. Fails closed (no change) on any doubt.
do $rb$
declare n integer;
declare dep integer;
begin
  if not exists (select 1 from pg_namespace where nspname = 'dpg_pilot') then
    raise exception 'PILOT_CLEANUP_NOTHING_TO_REMOVE';
  end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'dpg_pilot' and c.relkind in ('r', 'v', 'm', 'S', 'p', 'f')
      and not exists (select 1 from dpg_pilot.pilot_object o where o.kind in ('table', 'view', 'sequence') and o.identity = 'dpg_pilot.' || c.relname);
  if n > 0 then raise exception 'PILOT_CLEANUP_UNREGISTERED_RELATIONS:%', n; end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'dpg_pilot'
      and not exists (select 1 from dpg_pilot.pilot_object o where o.kind = 'function' and o.identity = 'dpg_pilot.' || p.proname);
  if n > 0 then raise exception 'PILOT_CLEANUP_UNREGISTERED_FUNCTIONS:%', n; end if;
  select count(*) into n from pg_roles r where r.rolname like 'dpg\_pilot\_%'
    and not exists (select 1 from dpg_pilot.pilot_object o where o.kind = 'role' and o.identity = r.rolname);
  if n > 0 then raise exception 'PILOT_CLEANUP_UNREGISTERED_ROLES:%', n; end if;
  -- anything outside the pilot schema that depends on a pilot relation, function or type: views, foreign keys, triggers, policies
  select count(*) into dep from pg_depend d
    join pg_rewrite rw on d.classid = 'pg_rewrite'::regclass and rw.oid = d.objid
    join pg_class vc on vc.oid = rw.ev_class join pg_namespace vn on vn.oid = vc.relnamespace
    join pg_class tc on tc.oid = d.refobjid join pg_namespace tn on tn.oid = tc.relnamespace
    where tn.nspname = 'dpg_pilot' and vn.nspname <> 'dpg_pilot';
  n := dep;
  select count(*) into dep from pg_constraint k join pg_class tc on tc.oid = k.confrelid join pg_namespace tn on tn.oid = tc.relnamespace
    join pg_class sc on sc.oid = k.conrelid join pg_namespace sn on sn.oid = sc.relnamespace
    where k.contype = 'f' and tn.nspname = 'dpg_pilot' and sn.nspname <> 'dpg_pilot';
  n := n + dep;
  select count(*) into dep from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace ps on ps.oid = p.pronamespace
    join pg_class sc on sc.oid = t.tgrelid join pg_namespace sn on sn.oid = sc.relnamespace
    where not t.tgisinternal and ps.nspname = 'dpg_pilot' and sn.nspname <> 'dpg_pilot';
  n := n + dep;
  select count(*) into dep from pg_depend d join pg_policy pol on d.classid = 'pg_policy'::regclass and pol.oid = d.objid
    join pg_class pc on pc.oid = pol.polrelid join pg_namespace pn on pn.oid = pc.relnamespace
    join pg_class tc on tc.oid = d.refobjid join pg_namespace tn on tn.oid = tc.relnamespace
    where tn.nspname = 'dpg_pilot' and pn.nspname <> 'dpg_pilot';
  n := n + dep;
  if n > 0 then raise exception 'PILOT_CLEANUP_FOREIGN_DEPENDENTS:%', n; end if;
  -- the pilot roles must hold no privilege and own nothing outside the pilot schema (otherwise DROP ROLE would also fail)
  select count(*) into n from pg_shdepend s join pg_roles r on r.oid = s.refobjid and s.refclassid = 'pg_authid'::regclass
    where r.rolname like 'dpg\_pilot\_%' and s.dbid = (select oid from pg_database where datname = current_database())
      and not (s.classid = 'pg_namespace'::regclass and s.objid = (select oid from pg_namespace where nspname = 'dpg_pilot'));
  if n > 0 then raise exception 'PILOT_CLEANUP_ROLE_DEPENDENCIES_OUTSIDE_SANDBOX:%', n; end if;
  drop schema dpg_pilot cascade;
  drop role dpg_pilot_rw;
  drop role dpg_pilot_ro;
end
$rb$
