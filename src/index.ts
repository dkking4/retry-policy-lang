export { ParseError, parseRetryPolicy } from './parser'
export type { BackoffPolicy, Duration, Jitter, RetryPolicy } from './parser'
export { printRetryPolicy } from './printer'

import { parseRetryPolicy } from './parser'
import { printRetryPolicy } from './printer'

// Parses then immediately re-prints a policy, which normalizes formatting,
// field order and duration units without changing what the policy means.
export function canonicalize(source: string): string {
  return printRetryPolicy(parseRetryPolicy(source))
}
