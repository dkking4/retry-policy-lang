// Renders a validated RetryPolicy back to the canonical text form: fixed
// field order, fixed spacing, durations reduced to the largest whole unit.

import { BackoffPolicy, Duration, RetryPolicy } from './parser'

function trimNumber(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

function formatDuration(d: Duration): string {
  if (d.ms !== 0 && d.ms % 3600000 === 0) return `${d.ms / 3600000}h`
  if (d.ms !== 0 && d.ms % 60000 === 0) return `${d.ms / 60000}m`
  if (d.ms !== 0 && d.ms % 1000 === 0) return `${d.ms / 1000}s`
  return `${trimNumber(d.ms)}ms`
}

function formatBackoff(b: BackoffPolicy): string {
  switch (b.kind) {
    case 'fixed':
      return `fixed(delay=${formatDuration(b.delay)})`
    case 'exponential':
      return `exponential(base=${formatDuration(b.base)}, factor=${trimNumber(b.factor)}, max=${formatDuration(b.max)})`
    case 'linear':
      return `linear(base=${formatDuration(b.base)}, increment=${formatDuration(b.increment)}, max=${formatDuration(b.max)})`
  }
}

export function printRetryPolicy(policy: RetryPolicy): string {
  const lines = [
    `max_attempts: ${policy.maxAttempts}`,
    `backoff: ${formatBackoff(policy.backoff)}`,
    `jitter: ${policy.jitter}`,
    `retry_on: [${policy.retryOn.join(', ')}]`,
  ]
  if (policy.giveUpAfter) lines.push(`give_up_after: ${formatDuration(policy.giveUpAfter)}`)
  return lines.join('\n') + '\n'
}
