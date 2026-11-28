# Reviewer role

Moved out of CLAUDE.md on 2026-11-25 to keep it under ~100 lines; the text is unchanged. Read this whole file when you are a reviewer.

- You are not the worker. Review against the spec, not the worker's explanation.
- Follow spec §8.2 exactly:
  - set the row to `converted`;
  - for each AC, check the code **and** that a named test asserts it, and post a pass/fail PR checklist;
  - diff against §5/§6;
  - check the owned paths;
  - check that no gate was weakened, including the forms lint can't catch, with this one command from the repo root (review R2-15; extended to `docker/` and `infra/` and to node:test's forms for DEV-p5-image-host-18 and -27, and widened for -29 and -30):

    ```
    rg -nU "\.(skip|only|todo|fixme|fails)\b|\['(skip|only)'\]|\.extend\(| as [a-z]+ \}|\b(skip|todo)\s*:|\{\s*(skip|todo)\s*[,}]|(=>|&&|\|\||\?)\s*(it|test|describe)\(|=\s*(it|test|describe)\s*$|\bif \(.*\)\s*\{?\s*(it|test|describe)\(|^\s*/\*([^*]|\*[^/])*?\n\s*it\(|import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*['\"]node:test|import\s+(\*\s+as\s+)?\w+[^\n]*from\s*['\"]node:test|(require|import)\(['\"]node:test|\.(skipIf|runIf)\b|\b(it|test|describe|suite)\s*\[|['\"\`](skip|todo)['\"\`]\s*:|\bif \(.*\)\s*\{?\s*(//[^\n]*\n\s*)+(it|test|describe)\(|\b(for|while)\s*\(.*\)\s*(//[^\n]*\n\s*)*(it|test|describe)\(|\bfor\s*\(.*\bof\s+\[\s*\]\s*\)|\bwhile\s*\(\s*(false|0|null|undefined|''|\"\")\s*\)|[=(,]\s*\`[^\`]*\n\s*(it|test|describe)\(|\.test\(\s*['\"\`]|import\s*\{[^}]*\b(it|test)\s+as\s+\w+[^}]*\}\s*from\s*['\"]node:test" web/src web/e2e docker infra
    ```

    It finds:
    - `.skip`/`.only`/`.todo`/`.fixme`/`.fails`, `.skipIf`/`.runIf`, run-time `t.skip()`/`t.todo()`, and any computed member on `it`/`test`/`describe`/`suite` (`it['todo']`, ``it[`skip`]``, `it["skip"]`);
    - node:test's options form, keys quoted or not (`{ skip: true }`, `{ 'skip': true }`, `{ todo: … }`, `{ skip }`), on a test or a suite;
    - a test made in a callback or behind `&&`, `||`, `?` or an `if` (also with comment lines between the `if (…) {` and the `it(`);
    - a test in an unbraced `for`/`while` body (`for (const n of [1]) it(…)`), and a loop that can never run (`for (… of [])`, `while (false)`, `while (0)`);
    - an `it(`/`test(` line inside a template literal opened after `=`, `(` or `,`, or inside a block comment;
    - `it`/`test` aliased (`= it` at a line end, or `it as check` in a `node:test` import on any line);
    - `test` imported from `node:test` by name, by default or namespace import, or dynamically;
    - a `t.test('…')` subtest.

    CI's image-fs step counts `it(` lines only, so a `test(` call or a subtest balances that count.

    Five hits are expected today and benign: four `import { routes as … }` lines in `web/src/app/router.tsx` (the ` as [a-z]+ \}` form) and the `allowOnly: false` comment in `infra/vitest.config.ts`. Anything else is a finding to read.

    **What it does not catch** (DEV-p5-image-host-30; the first three were planted and missed, the last two are known by reading):
    - an `it(` inside a function that is never called (the `t.test(` that balances it is caught, but a never-called function alone is not);
    - a braced loop whose body can never run but does not look empty (`for (… of [].slice()) {`, `while (0 > 1) {`);
    - a template literal opened after anything other than `=`, `(` or `,` (``String.raw` …``);
    - further indirection (`[it][0](…)`, `Reflect.apply(it, …)`);
    - a block comment opened after code on the same line.

    Braced `for` loops around `it(` are not flagged, because web and infra use them on purpose (about a dozen today). In `docker/` such a loop makes the counts differ, so the step goes red. No pattern can stop a deliberate balancing. The command supports reading the diff of every test file and does not replace it (DEV-p5-image-host-27, -30). eslint and vitest still pass computed-member skips and `skipIf` (-29): that gap is an owner decision outside this check;
  - check the §9 table against the pre-assigned statuses.
- Log findings in `spec/deviations.md` on the PR branch. Blocking = an AC failing, a contract change, a weakened gate, an edit outside the owned paths, or a §9 status contradicting a pre-assignment.
- **Blocking findings:** stop and report them to the orchestrator; don't fix the worker's code yourself.
- **No blocking findings:** commit row = `verified` plus a journal entry on the PR branch. When CI is green, run `gh pr merge --squash`. Then open the `chore/status-<cluster>` PR (row = `merged`) and merge it once green.
- **Security second review:** PRs touching `infra/`, `docker/`, `.github/`, `api/src/`, `web/src/auth/` or `web/stub/` also get the `security-reviewer` agent (`.claude/agents/security-reviewer.md`). It reports and never edits; the regular reviewer logs its findings.
