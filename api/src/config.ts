// The API's configuration, read from the environment only (S-p5-4: nothing secret lives in the repo or
// the image; wave C passes DATABASE_URL in from the cloud secret store). A bad value stops the API at
// start-up instead of running with a guess.
//
// | Variable                        | Default     | Meaning                                                  |
// |---------------------------------|-------------|----------------------------------------------------------|
// | DATABASE_URL                    | (required)  | PostgreSQL connection string, password included          |
// | PORT                            | 3000        | HTTP port                                                |
// | APP_ENV                         | production  | `production` or `development` (below)                    |
// | ALLOW_RESET                     | off         | `1`: POST /__stub/reset exists. Refused in production    |
// | TRUST_PROXY_HOPS                | 0           | proxies in front that append to X-Forwarded-For          |
// | SESSION_IDLE_SECONDS            | 28800 (8 h) | a session unused this long is gone (DEV-p5-store-03)     |
// | SESSION_SWEEP_SECONDS           | 600         | how often expired sessions and throttle rows are deleted |
// | LOGIN_MAX_FAILURES_PER_ACCOUNT  | 5           | failed sign-ins per e-mail per window, then 429          |
// | LOGIN_MAX_FAILURES_PER_IP       | 20          | failed sign-ins per client address per window, then 429  |
// | LOGIN_THROTTLE_WINDOW_SECONDS   | 900 (15 m)  | the throttling window                                    |
//
// Production mode (S-p5-2, AC-SEC-02) is APP_ENV=production, and also APP_ENV unset: a deployment that
// forgets the variable gets the safe settings, not the convenient ones. In production mode:
//   - both cookies get `Secure` (sid: HttpOnly; Secure; SameSite=Lax, XSRF-TOKEN: Secure; SameSite=Lax);
//   - ALLOW_RESET=1 is refused, so a production API cannot have the reset route (AC-SEC-03).
// APP_ENV=development is for plain http://localhost (compose, CI): no `Secure` flag, and ALLOW_RESET
// may be set. Session expiry and login throttling are on in both modes.
import { DEFAULT_SESSION_IDLE_SECONDS } from '../../web/stub/session.ts'
import { DEFAULT_THROTTLE, type ThrottleLimits } from '../../web/stub/throttle.ts'

export type ApiSettings = {
  production: boolean
  allowReset: boolean
  trustProxyHops: number
  sessionIdleSeconds: number
  sweepIntervalSeconds: number
  throttle: ThrottleLimits
}

export type ApiConfig = { databaseUrl: string; port: number; settings: ApiSettings }

export const DEFAULT_SWEEP_SECONDS = 600

type Env = Record<string, string | undefined>

function integer(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name]
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    throw new Error(`${name} must be a whole number of at least ${min}, got "${raw}"`)
  }
  return Number(raw)
}

export function loadConfig(env: Env): ApiConfig {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  const appEnv = env.APP_ENV ?? 'production'
  if (appEnv !== 'production' && appEnv !== 'development') {
    throw new Error(`APP_ENV must be "production" or "development", got "${appEnv}"`)
  }
  const production = appEnv === 'production'
  const allowReset = env.ALLOW_RESET === '1'
  if (production && allowReset) {
    throw new Error('ALLOW_RESET=1 is not allowed in production mode (set APP_ENV=development for local runs)')
  }

  return {
    databaseUrl,
    port: integer(env, 'PORT', 3000, 0),
    settings: {
      production,
      allowReset,
      trustProxyHops: integer(env, 'TRUST_PROXY_HOPS', 0, 0),
      sessionIdleSeconds: integer(env, 'SESSION_IDLE_SECONDS', DEFAULT_SESSION_IDLE_SECONDS, 1),
      sweepIntervalSeconds: integer(env, 'SESSION_SWEEP_SECONDS', DEFAULT_SWEEP_SECONDS, 1),
      throttle: {
        maxFailuresPerAccount: integer(
          env,
          'LOGIN_MAX_FAILURES_PER_ACCOUNT',
          DEFAULT_THROTTLE.maxFailuresPerAccount,
          1,
        ),
        maxFailuresPerIp: integer(env, 'LOGIN_MAX_FAILURES_PER_IP', DEFAULT_THROTTLE.maxFailuresPerIp, 1),
        windowSeconds: integer(env, 'LOGIN_THROTTLE_WINDOW_SECONDS', DEFAULT_THROTTLE.windowSeconds, 1),
      },
    },
  }
}
