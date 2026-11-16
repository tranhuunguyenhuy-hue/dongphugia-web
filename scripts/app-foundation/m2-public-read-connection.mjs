import { connectionConfig, TARGET } from '../catalogue-direct/contract.mjs'

export const M2_PUBLIC_TABLES = [
  'products','categories','subcategories','brands','product_images','product_descriptions',
  'product_spec_values','spec_definitions','spec_options','product_documents',
  'product_feature_values','product_features','blog_posts','blog_categories',
]
const connections = []
const requireRead = (condition, reason) => { if (!condition) throw new Error(reason) }

export async function attestM2PublicRole(client) {
  const identity = (await client.query(`SELECT current_user AS role,
    current_setting('transaction_read_only') AS read_only, current_setting('row_security') AS row_security,
    r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
    FROM pg_roles r WHERE r.rolname=current_user`)).rows[0]
  requireRead(identity?.role === 'dpg_m2_snapshot_read' && !identity.rolsuper && !identity.rolcreatedb
    && !identity.rolcreaterole && !identity.rolreplication && identity.rolbypassrls === false,
  'M2_PUBLIC_ROLE_IDENTITY_REQUIRED')
  requireRead(identity.read_only === 'on' && identity.row_security === 'on', 'M2_PUBLIC_READ_ONLY_RLS_REQUIRED')
  const rights = (await client.query(`SELECT n.nspname AS schema, c.relname AS name,
    has_any_column_privilege(c.oid,'SELECT') AS read,
    (has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES')
      OR has_table_privilege(c.oid,'DELETE,TRUNCATE,TRIGGER')) AS write,
    row_security_active(c.oid) AS rls,
    (c.relkind='v' AND n.nspname='extensions' AND c.relname IN ('pg_stat_statements','pg_stat_statements_info')
      AND EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
        WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_extension'::regclass
        AND d.deptype='e' AND e.extname='pg_stat_statements')) AS platform_statistics
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'`)).rows
  for (const right of rights) {
    const allowed = right.schema === 'dpg_app' && M2_PUBLIC_TABLES.includes(right.name)
    requireRead(!right.write && (!right.read || allowed || right.platform_statistics), 'M2_PUBLIC_ROLE_TABLE_BOUNDARY')
    if (allowed) requireRead(right.read && right.rls === true, 'M2_PUBLIC_ROLE_TABLE_RLS_REQUIRED')
  }
  requireRead(rights.filter(r => r.schema === 'dpg_app' && M2_PUBLIC_TABLES.includes(r.name) && r.read).length === M2_PUBLIC_TABLES.length,
    'M2_PUBLIC_ROLE_TABLE_SET')
  const authority = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
      AND pg_has_role(current_user,r.oid,'MEMBER')) AS membership,
    EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND has_schema_privilege(n.oid,'CREATE')) AS ddl,
    has_database_privilege(current_database(),'CREATE') AS dbcreate,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_' AND CASE WHEN c.relkind='S'
        THEN has_sequence_privilege(c.oid,'USAGE,UPDATE') ELSE false END) AS sequence_write`)).rows[0]
  requireRead(authority && !authority.membership && !authority.ddl && !authority.dbcreate && !authority.sequence_write,
    'M2_PUBLIC_ROLE_AUTHORITY_BOUNDARY')
}

export async function connectM2PublicRead() {
  requireRead(process.env.M2_PUBLIC_READ_DATABASE_URL?.trim(), 'M2_PUBLIC_SELECT_SECRET_MISSING')
  requireRead(process.env.DIRECT_TARGET_CA?.trim(), 'M2_SELECT_CA_MISSING')
  const { default: pg } = await import('pg')
  const config = connectionConfig(process.env.M2_PUBLIC_READ_DATABASE_URL, process.env.DIRECT_TARGET_CA, TARGET)
  config.application_name = 'dpg-m2-public-capture'
  // Session settings narrow this connection; they change no database/role defaults.
  config.options = '-c search_path=pg_catalog -c timezone=UTC -c datestyle=ISO,YMD -c row_security=on -c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=15000'
  const client = new pg.Client(config)
  connections.push(client)
  client.on('error', () => { process.exitCode = 1 })
  await client.connect()
  await attestM2PublicRole(client)
  return client
}
export async function closeM2PublicReadConnections() {
  await Promise.allSettled(connections.map(client => client.end()))
}
