# Questions raised while building Phase 2 (orchestrator)

Each was implemented as recommended so the harness could be finished and proven, and each is
cheap to reverse. **Owner: confirm, or veto by id.**

**Q-harness-1. react-router 8 is the latest major; spec §2 pins v7.**
Context: "latest stable at Phase 2" and "react-router v7 (data mode)" conflict. The §4.1 composition and the §11-4 risk were written and reviewed against v7's data-mode API; v8's changes have not been reviewed by anyone on this project.
Options: (a) pin `^7` (7.18.6); (b) take v8 and re-review §4.1 first.
*Recommended and implemented: (a).* Upgrading to v8 is a sensible post-migration task, done separately from the conversion.
**Answer:**

**Q-harness-2. TypeScript 7 is the latest major, but typescript-eslint supports `<6.1`.**
Options: (a) TypeScript 6.0.3 with type-aware tooling intact; (b) TypeScript 7 with typescript-eslint's peer range unmet.
*Recommended and implemented: (a).*
**Answer:**

**Q-harness-3. Bootstrap 2.1.1's LESS needed more than `math: 'always'` (spec §11-1 predicted only that).**
It was written for LESS 1.3, so on LESS 4.9 it needed three small, commented patches in the vendored copy (`web/src/styles/bootstrap2/`; `legacy/` is untouched):
- the old `(~".span@{index}")` selector interpolation, five places in `mixins.less`;
- the `.box-shadow` mixin used inline JavaScript to join 1–3 shadows, replaced by arity overloads that produce the same CSS;
- `navbar.less` looked up a mixin inside the parametric `#grid > .core`, so the same width formula is inlined.

Separately, Vite 8's LightningCSS minifier rejects Bootstrap's IE6/7 star hacks (`*zoom: 1`), so `errorRecovery` drops them. Every modern browser ignores them anyway.
Options: (a) the patches above; (b) add an old `less@1.x` just for this stylesheet.
*Recommended and implemented: (a).* Spot checks against Bootstrap 2.1.1 values pass: `.span12` = 940px, `.offset1` = 100px, multi-shadows keep their commas. Playwright asserts the computed styles.
**Answer:**

**Q-harness-4. `POST /__stub/reset` skips sessions and the XSRF check.**
Spec §7.2 orders XSRF before everything, but the reset route is outside the legacy contract (dev/test only, absent from the Pages build). Requiring a token would make every e2e file do a GET first just to reset.
*Recommended and implemented: exempt it.*
**Answer:**
