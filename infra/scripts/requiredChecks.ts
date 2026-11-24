// AC-AWS-01: a deploy starts only from the head of `migration`, and only when every check the branch
// protection requires has passed on that commit. Run by the first job of deploy-demo.yml:
//
//   GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo GITHUB_SHA=… node infra/scripts/requiredChecks.ts migration
//
// The list of required checks is read from the branch protection itself (not copied here), so adding a
// required check there also gates the deploy. It fails closed: no protection, no required checks, a
// check missing, pending, or anything but `success`, or a commit that is not the branch head, all refuse.
//
// One required check only runs on pull requests: `CodeQL` (app 57789, code scanning's PR check). A
// squash merge's commit on `migration` never gets it. For that check alone (PR_ONLY_CHECKS), when it is
// missing on the commit, the head commit of the pull request that was merged *as this commit*
// (merge_commit_sha) is consulted instead; branch protection required exactly that check there before it
// allowed the merge (Q-p5-infra-5). Every other required check must have run on the commit itself: a
// missing CI, deps, codeql or secrets run (a dispatch before the push runs exist, a `[skip ci]` squash
// message) refuses, never borrows the PR head's result (DEV-p5-infra-02).

/** Required checks that GitHub never runs on a push, only on pull requests: name and app id. */
export const PR_ONLY_CHECKS: readonly { context: string; app_id: number }[] = [{ context: 'CodeQL', app_id: 57789 }]

const prOnly = (check: RequiredCheck) =>
  PR_ONLY_CHECKS.some((only) => only.context === check.context && only.app_id === check.app_id)

export type GitHubGet = (path: string) => Promise<unknown>

type RequiredCheck = { context: string; app_id: number | null }
type CheckRun = { name: string; status: string; conclusion: string | null; app?: { id: number } | null }
type Status = { context: string; state: string }

export type CheckResult = { ok: boolean; lines: string[] }

function field<T>(value: unknown, key: string): T | undefined {
  return value !== null && typeof value === 'object' ? ((value as Record<string, unknown>)[key] as T) : undefined
}

async function checkRuns(github: GitHubGet, repo: string, sha: string): Promise<CheckRun[]> {
  const runs: CheckRun[] = []
  for (let page = 1; page <= 10; page++) {
    const body = await github(`/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`)
    const batch = field<CheckRun[]>(body, 'check_runs') ?? []
    runs.push(...batch)
    if (batch.length < 100) break
  }
  return runs
}

async function statuses(github: GitHubGet, repo: string, sha: string): Promise<Status[]> {
  return field<Status[]>(await github(`/repos/${repo}/commits/${sha}/status?per_page=100`), 'statuses') ?? []
}

type Found = { where: string; verdicts: string[] }

function find(check: RequiredCheck, runs: CheckRun[], states: Status[]): string[] {
  const fromRuns = runs
    .filter((run) => run.name === check.context && (check.app_id === null || run.app?.id === check.app_id))
    .map((run) => (run.status === 'completed' ? (run.conclusion ?? 'none') : run.status))
  const fromStatuses =
    check.app_id === null ? states.filter((s) => s.context === check.context).map((s) => s.state) : []
  return [...fromRuns, ...fromStatuses]
}

export async function verifyRequiredChecks(options: {
  github: GitHubGet
  repo: string
  branch: string
  sha: string
}): Promise<CheckResult> {
  const { github, repo, branch, sha } = options
  const lines: string[] = []
  const refuse = (line: string): CheckResult => ({ ok: false, lines: [...lines, `REFUSED: ${line}`] })

  const branchInfo = await github(`/repos/${repo}/branches/${branch}`)
  const head = field<string>(field(branchInfo, 'commit'), 'sha')
  if (head !== sha) return refuse(`${sha} is not the head of ${branch} (${head ?? 'unknown'}); dispatch on ${branch}.`)
  const protection = field(branchInfo, 'protection')
  const required = field<RequiredCheck[]>(field(protection, 'required_status_checks'), 'checks') ?? []
  if (field<boolean>(protection, 'enabled') !== true || required.length === 0) {
    return refuse(`${branch} has no required status checks, so there is nothing to prove; not deploying.`)
  }
  lines.push(`${branch} @ ${sha}: ${required.length} required checks`)

  const runs = await checkRuns(github, repo, sha)
  const states = await statuses(github, repo, sha)
  let prHead: { sha: string; number: number; runs: CheckRun[]; states: Status[] } | null | undefined

  let ok = true
  for (const check of required) {
    let found: Found = { where: 'commit', verdicts: find(check, runs, states) }
    if (found.verdicts.length === 0 && prOnly(check)) {
      if (prHead === undefined) {
        const pulls = (await github(`/repos/${repo}/commits/${sha}/pulls`)) as unknown[]
        const merged = (Array.isArray(pulls) ? pulls : []).find(
          (pr) =>
            field<string>(pr, 'merge_commit_sha') === sha &&
            field<string | null>(pr, 'merged_at') &&
            field<string>(field(pr, 'base'), 'ref') === branch,
        )
        const headSha = field<string>(field(merged, 'head'), 'sha')
        prHead = headSha
          ? {
              sha: headSha,
              number: field<number>(merged, 'number') ?? 0,
              runs: await checkRuns(github, repo, headSha),
              states: await statuses(github, repo, headSha),
            }
          : null
      }
      if (prHead) {
        found = {
          where: `PR #${prHead.number} head ${prHead.sha.slice(0, 7)}`,
          verdicts: find(check, prHead.runs, prHead.states),
        }
      }
    }
    const name = `${check.context}${check.app_id === null ? '' : ` (app ${check.app_id})`}`
    if (found.verdicts.length === 0) {
      ok = false
      lines.push(
        prOnly(check)
          ? `missing  ${name}: no run on the commit or on the merged pull request's head`
          : `missing  ${name}: no run on the commit (only ${PR_ONLY_CHECKS.map((c) => c.context).join(', ')} may come from the merged pull request)`,
      )
    } else if (found.verdicts.every((verdict) => verdict === 'success')) {
      lines.push(`passed   ${name}: ${found.verdicts.join(', ')} (${found.where})`)
    } else {
      ok = false
      lines.push(`FAILED   ${name}: ${found.verdicts.join(', ')} (${found.where})`)
    }
  }
  return ok ? { ok, lines: [...lines, 'All required checks passed.'] } : refuse('not every required check passed.')
}

export function githubFetch(token: string): GitHubGet {
  return async (path) => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`)
    return response.json()
  }
}

if (import.meta.main) {
  const branch = process.argv[2]
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA } = process.env
  if (!branch || !GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_SHA) {
    console.error('usage: GITHUB_TOKEN=… GITHUB_REPOSITORY=… GITHUB_SHA=… node requiredChecks.ts <branch>')
    process.exit(2)
  }
  const result = await verifyRequiredChecks({
    github: githubFetch(GITHUB_TOKEN),
    repo: GITHUB_REPOSITORY,
    branch,
    sha: GITHUB_SHA,
  })
  for (const line of result.lines) console.log(line)
  process.exit(result.ok ? 0 : 1)
}
