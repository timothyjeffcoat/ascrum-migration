import { describe, expect, it } from 'vitest'
import { verifyRequiredChecks, type GitHubGet } from './requiredChecks.ts'

const REPO = 'example/ascrum-migration'
const SHA = 'a'.repeat(40)
const PR_HEAD = 'b'.repeat(40)
const ACTIONS = 15368
const CODE_SCANNING = 57789

const required = [
  { context: 'lint', app_id: ACTIONS },
  { context: 'e2e', app_id: ACTIONS },
  { context: 'CodeQL', app_id: CODE_SCANNING },
]

const run = (name: string, conclusion: string | null, app = ACTIONS, status = 'completed') => ({
  name,
  status,
  conclusion,
  app: { id: app },
})

type World = {
  head?: string
  protection?: unknown
  commitRuns?: unknown[]
  commitStatuses?: unknown[]
  pulls?: unknown[]
  prRuns?: unknown[]
}

function fake(world: World): { github: GitHubGet; calls: string[] } {
  const calls: string[] = []
  const github: GitHubGet = async (path) => {
    calls.push(path)
    if (path === `/repos/${REPO}/branches/migration`) {
      return {
        commit: { sha: world.head ?? SHA },
        protection: world.protection ?? { enabled: true, required_status_checks: { checks: required } },
      }
    }
    if (path.startsWith(`/repos/${REPO}/commits/${SHA}/check-runs`)) return { check_runs: world.commitRuns ?? [] }
    if (path.startsWith(`/repos/${REPO}/commits/${SHA}/status`)) return { statuses: world.commitStatuses ?? [] }
    if (path === `/repos/${REPO}/commits/${SHA}/pulls`) return world.pulls ?? []
    if (path.startsWith(`/repos/${REPO}/commits/${PR_HEAD}/check-runs`)) return { check_runs: world.prRuns ?? [] }
    if (path.startsWith(`/repos/${REPO}/commits/${PR_HEAD}/status`)) return { statuses: [] }
    throw new Error(`unexpected GET ${path}`)
  }
  return { github, calls }
}

const mergedPr = {
  number: 67,
  merged_at: '2026-11-24T15:58:42Z',
  merge_commit_sha: SHA,
  base: { ref: 'migration' },
  head: { sha: PR_HEAD },
}
const green = [run('lint', 'success'), run('e2e', 'success')]

const verify = (world: World) =>
  verifyRequiredChecks({ github: fake(world).github, repo: REPO, branch: 'migration', sha: SHA })

describe('AC-AWS-01: the deploy gate (required checks on the commit)', () => {
  it('AC-AWS-01: passes when every required check succeeded on the commit, CodeQL on the merged PR head', async () => {
    const result = await verify({
      commitRuns: green,
      pulls: [mergedPr],
      prRuns: [run('CodeQL', 'success', CODE_SCANNING)],
    })
    expect(result.ok).toBe(true)
    expect(result.lines).toContain('passed   CodeQL (app 57789): success (PR #67 head bbbbbbb)')
    expect(result.lines).toContain('passed   lint (app 15368): success (commit)')
  })

  it('AC-AWS-01: refuses when one required check failed', async () => {
    const result = await verify({
      commitRuns: [run('lint', 'success'), run('e2e', 'failure')],
      pulls: [mergedPr],
      prRuns: [run('CodeQL', 'success', CODE_SCANNING)],
    })
    expect(result.ok).toBe(false)
    expect(result.lines).toContain('FAILED   e2e (app 15368): failure (commit)')
  })

  it('AC-AWS-01: refuses while a required check is still running', async () => {
    const result = await verify({
      commitRuns: [run('lint', 'success'), run('e2e', null, ACTIONS, 'in_progress')],
      pulls: [mergedPr],
      prRuns: [run('CodeQL', 'success', CODE_SCANNING)],
    })
    expect(result.ok).toBe(false)
  })

  it('AC-AWS-01: refuses skipped, neutral or cancelled: only success counts', async () => {
    for (const conclusion of ['skipped', 'neutral', 'cancelled', 'timed_out', 'action_required']) {
      const result = await verify({
        commitRuns: [run('lint', conclusion), run('e2e', 'success')],
        pulls: [mergedPr],
        prRuns: [run('CodeQL', 'success', CODE_SCANNING)],
      })
      expect(result.ok, conclusion).toBe(false)
    }
  })

  it('AC-AWS-01: a run with the right name from another app does not count', async () => {
    const result = await verify({ commitRuns: [...green, run('CodeQL', 'success', ACTIONS)], pulls: [] })
    expect(result.ok).toBe(false)
    expect(result.lines.some((line) => line.startsWith('missing  CodeQL'))).toBe(true)
  })

  it('AC-AWS-01: every run of a duplicated name must pass (CI build and Pages build)', async () => {
    const result = await verify({
      commitRuns: [...green, run('lint', 'failure')],
      pulls: [mergedPr],
      prRuns: [run('CodeQL', 'success', CODE_SCANNING)],
    })
    expect(result.ok).toBe(false)
  })

  it('AC-AWS-01: refuses a commit that is not the head of migration', async () => {
    const result = await verify({ head: 'c'.repeat(40), commitRuns: green })
    expect(result.ok).toBe(false)
    expect(result.lines.at(-1)).toMatch(/is not the head of migration/)
  })

  it('AC-AWS-01: refuses when the branch has no required checks (fails closed)', async () => {
    for (const protection of [{ enabled: false }, { enabled: true, required_status_checks: { checks: [] } }]) {
      const result = await verify({ protection, commitRuns: green })
      expect(result.ok).toBe(false)
    }
  })

  it('AC-AWS-01: the PR fallback only accepts the PR merged into migration as this very commit', async () => {
    const elsewhere = [
      { ...mergedPr, merge_commit_sha: 'd'.repeat(40) },
      { ...mergedPr, base: { ref: 'master' } },
      { ...mergedPr, merged_at: null },
    ]
    for (const pr of elsewhere) {
      const result = await verify({ commitRuns: green, pulls: [pr], prRuns: [run('CodeQL', 'success', CODE_SCANNING)] })
      expect(result.ok).toBe(false)
    }
  })

  it('AC-AWS-01: a check on the commit is never replaced by the PR head (a red commit stays red)', async () => {
    const result = await verify({
      commitRuns: [run('lint', 'failure'), run('e2e', 'success')],
      pulls: [mergedPr],
      prRuns: [run('lint', 'success'), run('CodeQL', 'success', CODE_SCANNING)],
    })
    expect(result.ok).toBe(false)
  })

  it('AC-AWS-01 / DEV-p5-infra-02: no run on the commit at all, all green on the PR head: refused', async () => {
    // The reviewer's probe: only CodeQL may come from the merged pull request's head.
    const result = await verify({
      commitRuns: [],
      pulls: [mergedPr],
      prRuns: [...green, run('CodeQL', 'success', CODE_SCANNING)],
    })
    expect(result.ok).toBe(false)
    expect(result.lines).toContain(
      'missing  lint (app 15368): no run on the commit (only CodeQL may come from the merged pull request)',
    )
    expect(result.lines).toContain(
      'missing  e2e (app 15368): no run on the commit (only CodeQL may come from the merged pull request)',
    )
    expect(result.lines).toContain('passed   CodeQL (app 57789): success (PR #67 head bbbbbbb)')
  })

  it('AC-AWS-01 / DEV-p5-infra-02: a [skip ci] squash commit (no push runs, one unrelated check) is refused', async () => {
    const result = await verify({
      commitRuns: [run('build', 'success')],
      pulls: [{ ...mergedPr, title: 'docs: typo [skip ci]' }],
      prRuns: [...green, run('CodeQL', 'success', CODE_SCANNING)],
    })
    expect(result.ok).toBe(false)
    expect(result.lines.at(-1)).toBe('REFUSED: not every required check passed.')
  })

  it('AC-AWS-01 / DEV-p5-infra-02: one push check missing on the commit is not borrowed from the PR head', async () => {
    const result = await verify({
      commitRuns: [run('lint', 'success')],
      pulls: [mergedPr],
      prRuns: [...green, run('CodeQL', 'success', CODE_SCANNING)],
    })
    expect(result.ok).toBe(false)
  })

  it('AC-AWS-01 / DEV-p5-infra-02: a check named CodeQL from another app gets no PR fallback', async () => {
    const result = await verify({
      protection: {
        enabled: true,
        required_status_checks: { checks: [...required.slice(0, 2), { context: 'CodeQL', app_id: ACTIONS }] },
      },
      commitRuns: green,
      pulls: [mergedPr],
      prRuns: [run('CodeQL', 'success', ACTIONS)],
    })
    expect(result.ok).toBe(false)
  })

  it('AC-AWS-01: a required legacy commit status (no app) is read from the status API', async () => {
    const result = await verify({
      protection: { enabled: true, required_status_checks: { checks: [{ context: 'ci/legacy', app_id: null }] } },
      commitStatuses: [{ context: 'ci/legacy', state: 'success' }],
    })
    expect(result.ok).toBe(true)
  })
})
