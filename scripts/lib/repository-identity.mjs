// Repository identity for active GitHub guards (Issue #426).
// Exactly one allowed repository (renamed from dongphugia.com.vn on 2026-11-20, Issue #426).
// Never widen to wildcards; owner, branch, actor, SHA and Owner-GO gates stay separate.
export const OWNER = 'tranhuunguyenhuy-hue'
export const REPOSITORY_NAMES = Object.freeze(['dongphugia-web'])
export const ALLOWED_REPOSITORIES = Object.freeze(REPOSITORY_NAMES.map((name) => `${OWNER}/${name}`))
export const DEFAULT_REPOSITORY = ALLOWED_REPOSITORIES[0]

export function isAllowedRepository(value) {
  return typeof value === 'string' && ALLOWED_REPOSITORIES.includes(value)
}

// Exact `<owner>/<repo>/.github/workflows/<file>@refs/heads/main` for an allowed repository.
export function isAllowedWorkflowRef(ref, workflowFile) {
  return typeof ref === 'string'
    && ALLOWED_REPOSITORIES.some((repository) => ref === `${repository}/.github/workflows/${workflowFile}@refs/heads/main`)
}

// Repository to use for self-referencing GitHub API paths. Fail-closed: when
// GITHUB_REPOSITORY is set it must be one of the allowed names; outside Actions
// (local tests) the current canonical name is used.
export function currentRepository(env = process.env) {
  const value = env.GITHUB_REPOSITORY
  if (value === undefined || value === '') return DEFAULT_REPOSITORY
  if (!isAllowedRepository(value)) throw new Error('REPOSITORY_IDENTITY_INVALID')
  return value
}
