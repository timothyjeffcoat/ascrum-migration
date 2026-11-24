// S-p5-5 / AC-SEC-05 on CloudFront: the response headers policy is generated from web/securityHeaders.ts,
// the same map `vite preview` and the web image serve (p5-containers' note for wave C: generated, not
// copied). CloudFront takes the security headers as typed settings, not as free-form headers (it refuses
// them as custom headers), so each known header is translated, and a header or value this file does not
// know stops the synth instead of being dropped.
//
// Added here, as web/securityHeaders.ts says: Strict-Transport-Security, because CloudFront is where TLS
// ends (DEV-p5-security-07).
import { Duration } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'

export const HSTS_MAX_AGE = Duration.days(365)

const REFERRER: Record<string, cloudfront.HeadersReferrerPolicy> = {
  'no-referrer': cloudfront.HeadersReferrerPolicy.NO_REFERRER,
  'same-origin': cloudfront.HeadersReferrerPolicy.SAME_ORIGIN,
  'strict-origin': cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN,
  'strict-origin-when-cross-origin': cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
}

const FRAME: Record<string, cloudfront.HeadersFrameOption> = {
  DENY: cloudfront.HeadersFrameOption.DENY,
  SAMEORIGIN: cloudfront.HeadersFrameOption.SAMEORIGIN,
}

/** Headers CloudFront accepts as custom headers (not on its list of security headers). */
const CUSTOM = new Set(['Cross-Origin-Opener-Policy', 'Permissions-Policy'])

function lookup<T>(table: Record<string, T>, header: string, value: string): T {
  const found = table[value]
  if (found === undefined) throw new Error(`${header}: no CloudFront setting for "${value}"`)
  return found
}

export function responseHeadersFromMap(
  headers: Record<string, string>,
): Pick<cloudfront.ResponseHeadersPolicyProps, 'securityHeadersBehavior' | 'customHeadersBehavior'> {
  const security: cloudfront.ResponseSecurityHeadersBehavior = {
    strictTransportSecurity: { accessControlMaxAge: HSTS_MAX_AGE, includeSubdomains: false, override: true },
  }
  const custom: cloudfront.ResponseCustomHeader[] = []
  let result = security
  for (const [header, value] of Object.entries(headers)) {
    switch (header) {
      case 'Content-Security-Policy':
        result = { ...result, contentSecurityPolicy: { contentSecurityPolicy: value, override: true } }
        break
      case 'X-Content-Type-Options':
        if (value !== 'nosniff') throw new Error(`${header}: CloudFront can only send "nosniff", got "${value}"`)
        result = { ...result, contentTypeOptions: { override: true } }
        break
      case 'Referrer-Policy':
        result = { ...result, referrerPolicy: { referrerPolicy: lookup(REFERRER, header, value), override: true } }
        break
      case 'X-Frame-Options':
        result = { ...result, frameOptions: { frameOption: lookup(FRAME, header, value), override: true } }
        break
      default:
        if (!CUSTOM.has(header)) throw new Error(`${header}: not translated to CloudFront (securityHeadersPolicy.ts)`)
        custom.push({ header, value, override: true })
    }
  }
  return { securityHeadersBehavior: result, customHeadersBehavior: { customHeaders: custom } }
}
