# Reviewer role

Moved out of CLAUDE.md on 2026-11-25 to keep it under ~100 lines; the text is unchanged. Read this whole file when you are a reviewer.

- You are not the worker. Review against the spec, not the worker's explanation.
- Follow spec §8.2 exactly:
  - set the row to `converted`;
  - for each AC, check the code **and** that a named test asserts it, and post a pass/fail PR checklist;
  - diff against §5/§6;
  - check the owned paths;
  - check that no gate was weakened, including the forms lint can't catch: `rg -n "\.(skip|only|todo|fixme|fails)\b|\['(skip|only)'\]|\.extend\(| as [a-z]+ \}" web/src web/e2e` and any run-time `skip()` (review R2-15);
  - check the §9 table against the pre-assigned statuses.
- Log findings in `spec/deviations.md` on the PR branch. Blocking = an AC failing, a contract change, a weakened gate, an edit outside the owned paths, or a §9 status contradicting a pre-assignment.
- **Blocking findings:** stop and report them to the orchestrator; don't fix the worker's code yourself.
- **No blocking findings:** commit row = `verified` plus a journal entry on the PR branch. When CI is green, run `gh pr merge --squash`. Then open the `chore/status-<cluster>` PR (row = `merged`) and merge it once green.
- **Security second review:** PRs touching `infra/`, `docker/`, `.github/`, `api/src/`, `web/src/auth/` or `web/stub/` also get the `security-reviewer` agent (`.claude/agents/security-reviewer.md`). It reports and never edits; the regular reviewer logs its findings.
