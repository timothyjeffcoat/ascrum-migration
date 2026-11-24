# Questions raised by cluster p5-security (Phase 5, wave B)

Ids are `Q-p5-security-<n>` (spec §8, `conversion-spec.md` §8.5).

**Q-p5-security-1. The CSP and Gravatar images (not blocking; implemented as recommended, pending an answer).**
Context: spec §3.4 S-p5-5 says "the CSP must allow the app's own assets only". The app also shows
Gravatar images from `https://www.gravatar.com/avatar/<md5>` on the user list and the user form
(AC-GRAV-01, legacy behaviour, `web/src/components/Gravatar.tsx`). With `img-src 'self'` alone, every
user screen raises a CSP violation and shows broken images, so AC-SEC-05 ("no CSP violations on any
screen") cannot pass without changing `web/src`, which N1 and the owned paths rule out.
Options:
(a) allow that one host for images only: `img-src 'self' https://www.gravatar.com` (scripts, styles,
fonts, connections and frames stay `'self'` or `'none'`);
(b) `img-src 'self'` only, and accept broken avatars plus violations on the user screens, which fails
AC-SEC-05 as written;
(c) `img-src 'self'` and serve the avatars some other way (a proxy route on the API, or dropping them),
which is a product and front-end change for a later phase.
*Recommended and implemented: (a).* An image request can carry no script, Gravatar is the only outside
host the legacy app ever used, `Referrer-Policy: no-referrer` keeps the app's URLs (which hold ids) away
from it, and the e2e test checks both that the avatars load and that nothing else outside the origin is
allowed (a foreign image and an inline script are blocked). The wording of S-p5-5 would need "plus
Gravatar images (AC-GRAV-01)".

**Q-p5-security-2. Rotate the XSRF token at login, too? (not blocking; implemented (a), pending an answer).**
Context: to stop session fixation, login now moves the session to a new `sid` and the old `sid` stops
existing. My first version also issued a new XSRF token. That is visible to the front end:
`web/src/api/http.test.ts` "AC-API-07: a 401 enqueues unauthorized-server; the retry is re-sent with
fresh headers …" (cluster 0, outside my paths) asserts that the retried request carries the token the
client held *before* signing in, and went red. The app itself coped (the retry re-reads the cookie and
succeeded); only the test's expectation, and so the observable contract, changed. N1 says a change the
front end can see needs an answered question first.
Options:
(a) rotate only `sid` (HttpOnly, never seen by the front end); the XSRF token survives login;
(b) rotate both, and change the one expectation in `http.test.ts` (the token after login, instead of
the one before it);
(c) no rotation at all (legacy).
*Recommended and implemented: (a).* It closes the fixation hole: whoever planted or saw the pre-login
`sid` holds a cookie that no longer exists, and with it even the right XSRF token gets 403 (test
"login issues a new sid …" in `web/stub/securityTests.ts`). What (a) leaves is that an attacker who
fixed the session also knows its XSRF token. Using it needs the victim's browser to send the new `sid`
on a cross-site request, which `SameSite=Lax` (S-p5-2) prevents for POST, PUT and DELETE. (b) is the
textbook answer and costs one line in a cluster-0 test; I did not want to make that edit, or a visible
change, without an answer.
