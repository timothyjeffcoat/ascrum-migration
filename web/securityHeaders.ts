// S-p5-5 / AC-SEC-05: the response headers the production web build is served with. One map, used by
// `vite preview` (vite.config.ts, which Playwright runs against) and by the web image (p5-containers
// serves exactly this map), so the tested headers are the shipped ones. Keep the name and the shape.
//
// The GitHub Pages demo cannot send headers (Pages has no header configuration), so it runs without
// these; see spec/worklogs/p5-security.md.
//
// Content-Security-Policy: the app's own origin only. The build is plain module scripts and CSS files
// from /assets (no inline script, no eval, no inline <style>; React sets style properties through the
// CSSOM, which CSP does not govern). The API is the same origin (spec §3.6), so connect-src 'self'.
//   - img-src adds https://www.gravatar.com, the one outside host the app uses: the user list and the
//     user form show Gravatar images (AC-GRAV-01, legacy behaviour). Images only, and only that host.
//     Q-p5-security-1, answered (a) by the owner (spec/questions/p5-security.md).
//   - worker-src 'self': the MSW service worker (dev:msw and Pages only) is a same-origin script.
//   - object-src 'none', base-uri 'self', form-action 'self', frame-ancestors 'none': no plugins, no
//     <base> hijacking, forms post nowhere else, and no other site may frame the app (clickjacking).
// No upgrade-insecure-requests and no Strict-Transport-Security here: both concern HTTPS, which is
// terminated in front of the web build (CloudFront in wave C, which sets HSTS), and on the plain
// http://localhost of preview and compose they would break or be ignored.
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https://www.gravatar.com",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export const securityHeaders: Record<string, string> = {
  'Content-Security-Policy': csp,
  // Browsers must not guess a type: a JSON body (the API's `)]}',` prefixed replies) never runs as script.
  'X-Content-Type-Options': 'nosniff',
  // The app's URLs carry project, sprint and task ids; no other site needs them, Gravatar included.
  'Referrer-Policy': 'no-referrer',
  // frame-ancestors for browsers that predate it.
  'X-Frame-Options': 'DENY',
  // The app opens no other windows; a page it links to cannot reach back into it.
  'Cross-Origin-Opener-Policy': 'same-origin',
  // The app uses none of these; an injected script could not either.
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
}
