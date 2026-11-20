import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const tokenIdentityChecker = readFileSync(path.join(here, 'verify-environment-worker-deployment-token.mjs'), 'utf8')
const releaseProtectionChecker = readFileSync(path.join(here, 'verify-environment-worker-release-protection.mjs'), 'utf8')
const productionBaselineChecker = readFileSync(path.join(here, 'verify-production-public-baseline.mjs'), 'utf8')
const deploymentVerifier = readFileSync(path.join(here, 'verify-environment-worker-deployment.mjs'), 'utf8')
const artifactDigestScript = readFileSync(path.join(here, 'environment-worker-artifact-digest.mjs'), 'utf8')
const buildScript = readFileSync(path.join(here, 'build-environment-worker.mts'), 'utf8')
const namespaceScript = readFileSync(path.join(here, 'namespace-admin-vite-rsc-globals.mjs'), 'utf8')
const localRunner = readFileSync(path.join(here, 'run-local-preview.mjs'), 'utf8')
const browserVerifier = readFileSync(path.join(here, 'environment-worker-browser.mjs'), 'utf8')
const reviewSummaryScript = readFileSync(path.join(here, 'render-environment-worker-review-summary.mjs'), 'utf8')
const deployRunner = readFileSync(path.join(here, 'run-environment-worker-wrangler-deploy.mjs'), 'utf8')

describe('Environment Worker build, release-protection and deployment scripts', () => {
  it('keeps token identity, release protection, Production baseline and the strict deploy runner fail-closed', () => {
    expect(reviewSummaryScript).toContain('Deployment token ID to inspect')
    expect(reviewSummaryScript).toContain('external human review')
    expect(reviewSummaryScript).toContain('Workers Editor role scoped to the existing dpg-staging Worker (Individual Workers scope)')
    expect(reviewSummaryScript).toContain('API-origin warning acknowledgement requested')
    expect(reviewSummaryScript).toContain('retains Wrangler --strict')
    expect(deployRunner).toContain("'--strict'")
    expect(deployRunner).toContain("delete childEnv.CI")
    expect(deployRunner).toContain("delete childEnv.GITHUB_ACTIONS")
    expect(deployRunner).toContain('ENVIRONMENT_WORKER_WRANGLER_UNEXPECTED_CONFIRMATION_DECLINED')
    expect(tokenIdentityChecker).toContain('/tokens/verify')
    expect(tokenIdentityChecker).toContain('policyScopeMachineVerified: false')
    expect(tokenIdentityChecker).toContain('external-required-reviewer-approval')
    expect(releaseProtectionChecker).toContain('/environments/${ENVIRONMENT}')
    expect(releaseProtectionChecker).toContain('/deployment-branch-policies')
    expect(releaseProtectionChecker).toContain('can_admins_bypass !== false')
    expect(releaseProtectionChecker).toContain('tranhuunguyenhuy-hue')
    expect(releaseProtectionChecker).not.toContain('CLOUDFLARE_API_TOKEN')
    expect(productionBaselineChecker).toContain("method: 'GET'")
    expect(productionBaselineChecker).not.toMatch(/method:\s*'(?:POST|PUT|PATCH|DELETE)'/)
    expect(deploymentVerifier).toContain("method: 'HEAD'")
    expect(artifactDigestScript).toContain('createHash(\'sha256\')')
  })

  it('keeps the local Preview build script local-only and on one origin for Public and Admin', () => {
    expect(buildScript).toContain("preview: { workerName: 'dpg-local-preview', origin: 'http://127.0.0.1:8787', localOnly: true }")
    expect(buildScript).toContain('workers_dev: !target.localOnly')
    expect(localRunner).toContain("const origin = 'http://127.0.0.1:8787'")
    expect(localRunner).toContain("'dev', '--local'")
  })

  it('keeps local Wrangler persistence outside the candidate', () => {
    expect(browserVerifier).toContain("mkdtemp(path.join(os.tmpdir(), 'dpg-environment-worker-'))")
    expect(browserVerifier).toContain("'--persist-to', persistenceDirectory")
    expect(browserVerifier).toContain("rm(path.join(artifactRoot, '.wrangler'), { recursive: true, force: true })")
    expect(browserVerifier).toContain("rm(persistenceDirectory, { recursive: true, force: true })")
  })

  it('namespaces Admin RSC globals before combining both framework runtimes', () => {
    expect(buildScript).toContain('namespaceAdminViteRscGlobals')
    expect(buildScript).toContain("contract: 'dpg:combined-environment-worker:v2'")
    expect(namespaceScript).toContain('__vite_rsc_client_require__')
    expect(namespaceScript).toContain('__vite_rsc_require__')
    expect(namespaceScript).toContain('__vite_rsc_server_require__')
    expect(namespaceScript).toContain('__dpg_rsc0_')
    expect(namespaceScript).toContain('ADMIN_VITE_RSC_RUNTIME_GLOBAL_MISSING')
  })
})
