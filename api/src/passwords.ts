// S-p5-1 / AC-SEC-01: password hashing with node:crypto scrypt and a random salt per user (no new
// dependency). A stored hash records its own parameters, so raising the cost later needs no migration:
// old hashes keep verifying with the parameters they were made with.
//
//   scrypt$<log2 N>$<r>$<p>$<salt, base64url>$<derived key, base64url>
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

export type ScryptParams = { log2N: number; r: number; p: number }

/**
 * N = 2^17, r = 8, p = 1: the OWASP Password Storage Cheat Sheet's minimum for scrypt (128 MiB of
 * memory per hash, about 0.25 s on the development machine). Login throttling (S-p5-3) caps how often
 * anyone can make the server pay that.
 */
export const PRODUCTION_SCRYPT: ScryptParams = { log2N: 17, r: 8, p: 1 }

const SALT_BYTES = 16
const KEY_BYTES = 32
const FORMAT = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/
// Refuse parameters a corrupt row could carry that would tie up a worker thread or a gigabyte of memory.
const MAX_LOG2N = 20

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.log2N
  // scrypt needs 128·N·r bytes; the default 32 MiB limit is too small for N = 2^17.
  const maxmem = 256 * N * params.r
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N, r: params.r, p: params.p, maxmem }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string, params: ScryptParams = PRODUCTION_SCRYPT): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt, params)
  return ['scrypt', params.log2N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$')
}

/** True when `password` produces `stored`. A malformed `stored` never matches. Constant-time compare. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = FORMAT.exec(stored)
  if (!match) return false
  const [, log2N, r, p, salt = '', key = ''] = match
  const params = { log2N: Number(log2N), r: Number(r), p: Number(p) }
  if (params.log2N < 1 || params.log2N > MAX_LOG2N || params.r < 1 || params.p < 1) return false
  const expected = Buffer.from(key, 'base64url')
  const actual = await derive(password, Buffer.from(salt, 'base64url'), params)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
