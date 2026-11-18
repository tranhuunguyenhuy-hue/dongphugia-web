// Pure description of the Production (M4) migration files, shared by the generator script and the drift test.
import { generateAdminResourceMigration } from './grants.ts'
import { generateProductionBase, PRODUCTION_GUARD } from './production-base.ts'
import { CUSTOM_GRANTS } from './custom-grants.ts'
import { RESOURCES } from './resources.ts'

export const PRODUCTION_ROLE = 'dpg_admin_api'

export function productionMigrationFiles(): [string, string][] {
  const base = generateProductionBase({ role: PRODUCTION_ROLE, policyPrefix: 'admin_api_', guard: PRODUCTION_GUARD, title: 'M4 PRODUCTION: Admin API role, support tables and products.version (project bonxyxluzlxfkdetryoo).' })
  const resources = generateAdminResourceMigration(RESOURCES, {
    role: PRODUCTION_ROLE, policyPrefix: 'admin_api_', guard: PRODUCTION_GUARD, extra: CUSTOM_GRANTS,
    title: 'M4 PRODUCTION: column-level grants + RLS policies for the Admin resources (project bonxyxluzlxfkdetryoo).',
    baseTables: ['admin_users'], basePolicies: ['admin_users.select', 'admin_users.update'],
    rollbackRegrant: [`grant update (last_login_at) on dpg_app.admin_users to ${PRODUCTION_ROLE};`],
  })
  return [
    ['supabase/m4-production/001_m4_production_admin_api_base.sql', base.forward], ['supabase/m4-production/001_m4_production_admin_api_base_rollback.sql', base.rollback],
    ['supabase/m4-production/002_m4_production_admin_resources.sql', resources.forward], ['supabase/m4-production/002_m4_production_admin_resources_rollback.sql', resources.rollback],
  ]
}
