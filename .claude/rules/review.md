# Reviewer role

Moved out of CLAUDE.md on 2026-11-25 to keep it under ~100 lines; the text is unchanged. Read this whole file when you are a reviewer.

- You are not the worker. Review against the spec, not the worker's explanation.
- Follow spec §8.2 exactly:
  - set the row to `converted`;
  - for each AC, check the code **and** that a named test asserts it, and post a pass/fail PR checklist;
  - diff against §5/§6;
  - check the owned paths;
  - check that no gate was weakened, including the forms lint can't catch, with this one command from the repo root (review R2-15; extended to `docker/` and `infra/` and to node:test's forms for DEV-p5-image-host-18 and -27):

    ```
    rg -nU "\.(skip|only|todo|fixme|fails)\b|\['(skip|only)'\]|\.extend\(| as [a-z]+ \}|\b(skip|todo)\s*:|\{\s*(skip|todo)\s*[,}]|(=>|&&|\|\||\?)\s*(it|test|describe)\(|=\s*(it|test|describe)\s*$|\bif \(.*\)\s*\{?\s*(it|test|describe)\(|^\s*/\*([^*]|\*[^/])*?\n\s*it\(|import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*['\"]node:test|import\s+(\*\s+as\s+)?\w+[^\n]*from\s*['\"]node:test|(require|import)\(['\"]node:test" web/src web/e2e docker infra
    ```

    It finds `.skip`/`.only`/`.todo` and run-time `t.skip()`/`t.todo()`; node:test's options form (`{ skip: true }`, `{ todo: … }`, `{ skip }`, on a test or a suite); a test made in a callback or behind `&&`, `||`, `?` or an `if`; `it`/`test` aliased to another name; a block comment holding an `it(` line; and `test` imported from `node:test` by name, by default or namespace import, or dynamically (CI's image-fs step counts `it(` lines only, so a `test(` balances that count). Five hits are expected today and benign: four `import { routes as … }` lines in `web/src/app/router.tsx` (the ` as [a-z]+ \}` form) and the `allowOnly: false` comment in `infra/vitest.config.ts`. Anything else is a finding to read. It cannot catch every indirection (for example `[it][0](…)`), so it supports reading the diff of every test file; it does not replace it (DEV-p5-image-host-27);
  - check the §9 table against the pre-assigned statuses.
- Log findings in `spec/deviations.md` on the PR branch. Blocking = an AC failing, a contract change, a weakened gate, an edit outside the owned paths, or a §9 status contradicting a pre-assignment.
- **Blocking findings:** stop and report them to the orchestrator; don't fix the worker's code yourself.
- **No blocking findings:** commit row = `verified` plus a journal entry on the PR branch. When CI is green, run `gh pr merge --squash`. Then open the `chore/status-<cluster>` PR (row = `merged`) and merge it once green.
- **Security second review:** PRs touching `infra/`, `docker/`, `.github/`, `api/src/`, `web/src/auth/` or `web/stub/` also get the `security-reviewer` agent (`.claude/agents/security-reviewer.md`). It reports and never edits; the regular reviewer logs its findings.
