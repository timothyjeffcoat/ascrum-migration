# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub, not in a public issue or pull request:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the issue, how to reproduce it, and what it affects.

The report is visible only to the maintainer until an advisory is published. GitHub's guide:
[Privately reporting a security vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).

## Scope

- The React app and its API (`web/`, and the API package once it lands), and the CI workflows in
  `.github/`.
- `legacy/` is a frozen snapshot of the original AngularJS app, kept only as a reference. It is not
  maintained or deployed, so issues in it will not be fixed there.

## What runs on every change

CodeQL (static analysis), `pnpm audit` (dependencies, high and critical fail), Gitleaks (secrets in
new commits and in the tree) and Dependabot. GitHub secret scanning with push protection is also on.
