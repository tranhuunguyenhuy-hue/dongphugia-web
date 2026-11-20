import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderEnvironmentWorkerReviewSummary } from './render-environment-worker-review-summary.mjs'
import { API_ORIGIN_ACKNOWLEDGEMENT } from './run-environment-worker-wrangler-deploy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
async function applyGitHubEnvFile(file: string, base: Record<string, string>) {
  const env = { ...base }
  const contents = await readFile(file, 'utf8')
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue
    const separator = line.indexOf('=')
    if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return env
}

describe('Staging release review summary trust boundary', () => {
  it('renders dispatch token identity on a clean runner despite candidate GITHUB_ENV mutation', async () => {
    const approvedTokenId = 'a'.repeat(32)
    const candidateTokenId = 'b'.repeat(32)
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dpg-review-env-mutation-'))
    const githubEnvFile = path.join(temporaryDirectory, 'github_env')

    try {
      await writeFile(githubEnvFile, '', 'utf8')
      await appendFile(
        githubEnvFile,
        `DEPLOYMENT_TOKEN_ID=${candidateTokenId}\nRELEASE_DEPLOYMENT_TOKEN_ID=${candidateTokenId}\nRELEASE_API_ORIGIN_ACK=${API_ORIGIN_ACKNOWLEDGEMENT}\n`,
        'utf8',
      )
      const candidateJobEnvironment = await applyGitHubEnvFile(githubEnvFile, {
        DEPLOYMENT_TOKEN_ID: approvedTokenId,
        RELEASE_DEPLOYMENT_TOKEN_ID: approvedTokenId,
        RELEASE_API_ORIGIN_ACK: 'none',
      })
      expect(candidateJobEnvironment.DEPLOYMENT_TOKEN_ID).toBe(candidateTokenId)
      expect(candidateJobEnvironment.RELEASE_DEPLOYMENT_TOKEN_ID).toBe(candidateTokenId)
      expect(candidateJobEnvironment.RELEASE_API_ORIGIN_ACK).toBe(API_ORIGIN_ACKNOWLEDGEMENT)

      const immutableInputs = {
        sourceSha: 'c'.repeat(40),
        artifactSha256: 'd'.repeat(64),
        deploymentTokenId: approvedTokenId,
      }
      const summary = renderEnvironmentWorkerReviewSummary({
        serverUrl: 'https://github.com',
        repository: 'tranhuunguyenhuy-hue/dongphugia.com.vn',
        runId: '43284051382',
        sourceSha: immutableInputs.sourceSha,
        artifactSha256: immutableInputs.artifactSha256,
        deploymentTokenId: immutableInputs.deploymentTokenId,
        apiOriginAcknowledgement: 'none',
      })
      expect(summary).toContain(`Deployment token ID to inspect: ${approvedTokenId}`)
      expect(summary).not.toContain(candidateTokenId)
      expect(summary).toContain(`Source SHA: ${immutableInputs.sourceSha}`)
      expect(summary).toContain(`Candidate artifact content SHA-256: ${immutableInputs.artifactSha256}`)
      expect(summary).toContain('API-origin warning acknowledgement requested: none')
      expect(summary).toContain('retains Wrangler --strict')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('rejects malformed or multiline identity values before writing a review summary', () => {
    const valid = {
      serverUrl: 'https://github.com',
      repository: 'tranhuunguyenhuy-hue/dongphugia.com.vn',
      runId: '43284051382',
      sourceSha: 'c'.repeat(40),
      artifactSha256: 'd'.repeat(64),
      deploymentTokenId: 'a'.repeat(32),
      apiOriginAcknowledgement: 'none',
    }
    expect(() => renderEnvironmentWorkerReviewSummary({
      ...valid,
      deploymentTokenId: `${'b'.repeat(32)}\n- fake reviewer evidence`,
    })).toThrow('ENVIRONMENT_WORKER_REVIEW_SUMMARY_TOKEN_ID_INVALID')
    expect(() => renderEnvironmentWorkerReviewSummary({
      ...valid,
      artifactSha256: 'not-a-digest',
    })).toThrow('ENVIRONMENT_WORKER_REVIEW_SUMMARY_ARTIFACT_SHA256_INVALID')
    expect(() => renderEnvironmentWorkerReviewSummary({
      ...valid,
      apiOriginAcknowledgement: 'skip-all-conflicts',
    })).toThrow('ENVIRONMENT_WORKER_REVIEW_SUMMARY_API_ORIGIN_ACK_INVALID')
  })
})
