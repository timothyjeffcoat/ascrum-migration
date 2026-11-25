// Test helper: resolves a template value as CloudFormation would, with the longest values an account could
// give it, and measures a policy document as IAM does (policyLimits.test.ts; scratch scripts may import it).
import type { Resource } from './testApp.ts'

// The longest values each pseudo parameter can take: a 12-digit account id; the longest partition
// (`aws-us-gov`, 10, against `aws` in a commercial account); the longest region names (14, e.g.
// `ap-southeast-7`, `ap-northeast-3`); the longest URL suffix (`sc2s.sgov.gov`).
export const WORST = {
  'AWS::AccountId': '123456789012',
  'AWS::Partition': 'aws-us-gov',
  'AWS::Region': 'ap-southeast-7',
  'AWS::URLSuffix': 'sc2s.sgov.gov',
  'AWS::StackName': 'AscrumDemoRegistry',
} as const
// Any other Ref or GetAtt (a generated resource id or ARN): longer than any ARN these templates name.
export const UNKNOWN = 'x'.repeat(256)
// The longest `owner/repo` GitHub allows (39 and 100 characters); the trust policy names it.
export const LONGEST_REPOSITORY = `${'o'.repeat(39)}/${'r'.repeat(100)}`

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** Resolves a template value as CloudFormation would, with the worst-case values above. */
export function resolver(all: Record<string, Resource>): (value: Json) => Json {
  const partition = WORST['AWS::Partition']
  const account = WORST['AWS::AccountId']
  const ref = (name: string): string => {
    if (name in WORST) return WORST[name as keyof typeof WORST]
    const target = all[name]
    if (target?.Type === 'AWS::IAM::ManagedPolicy') {
      return `arn:${partition}:iam::${account}:policy/${String(target.Properties?.ManagedPolicyName)}`
    }
    if (target?.Type === 'AWS::IAM::Role' && typeof target.Properties?.RoleName === 'string') {
      return target.Properties.RoleName
    }
    return UNKNOWN
  }
  const getAtt = ([name, attribute]: string[]): string => {
    const target = all[name ?? '']
    if (target?.Type === 'AWS::IAM::Role' && attribute === 'Arn' && typeof target.Properties?.RoleName === 'string') {
      return `arn:${partition}:iam::${account}:role/${target.Properties.RoleName}`
    }
    return UNKNOWN
  }
  const resolve = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(resolve)
    if (value === null || typeof value !== 'object') return value
    const keys = Object.keys(value)
    const intrinsic = keys.length === 1 ? keys[0] : undefined
    if (intrinsic === 'Ref') return ref(value.Ref as string)
    if (intrinsic === 'Fn::GetAtt') return getAtt(value['Fn::GetAtt'] as string[])
    if (intrinsic === 'Fn::Join') {
      const [separator, parts] = value['Fn::Join'] as [string, Json[]]
      return parts.map((part) => String(resolve(part))).join(separator)
    }
    if (intrinsic === 'Fn::Sub' && typeof value['Fn::Sub'] === 'string') {
      return value['Fn::Sub'].replace(/\$\{([^}!]+)\}/g, (_, name: string) =>
        name.includes('.') ? getAtt(name.split('.')) : ref(name),
      )
    }
    if (intrinsic?.startsWith('Fn::')) throw new Error(`unresolved intrinsic ${intrinsic}`)
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolve(inner)]))
  }
  return resolve
}

/** IAM's measure: the resolved document as JSON, without whitespace. */
export const size = (document: Json) => JSON.stringify(document).length
