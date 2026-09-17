// Executes a validated RetryPolicy against an async function.
//
// The policy only knows about abstract condition names (`timeout`, `5xx`,
// `429`, ...), not about what kind of errors a particular client throws, so
// the caller supplies a `classify` function that maps a thrown error to one
// of those names (or null, meaning "don't retry this").

import { BackoffPolicy, RetryPolicy } from './parser'

export type RetryContext = {
  attempt: number
  error: unknown
  delayMs: number
}

export type RunOptions = {
  classify: (error: unknown) => string | null
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
  onRetry?: (ctx: RetryContext) => void
}

export class RetryExhaustedError extends Error {
  constructor(message: string, readonly attempts: number, readonly cause: unknown) {
    super(message)
    this.name = 'RetryExhaustedError'
  }
}

export class NotRetryableError extends Error {
  constructor(readonly cause: unknown) {
    super('the operation failed with an error this policy does not retry on')
    this.name = 'NotRetryableError'
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function computeBaseDelay(backoff: BackoffPolicy, attempt: number): number {
  switch (backoff.kind) {
    case 'fixed':
      return backoff.delay.ms
    case 'exponential':
      return Math.min(backoff.base.ms * Math.pow(backoff.factor, attempt - 1), backoff.max.ms)
    case 'linear':
      return Math.min(backoff.base.ms + backoff.increment.ms * (attempt - 1), backoff.max.ms)
  }
}

// attempt is 1-based and refers to the attempt the delay is being waited for,
// e.g. computeDelay(policy, 2, ...) is the wait before the second try.
export function computeDelay(policy: RetryPolicy, attempt: number, random: () => number = Math.random): number {
  const base = computeBaseDelay(policy.backoff, attempt)
  switch (policy.jitter) {
    case 'none':
      return base
    case 'full':
      return random() * base
    case 'equal':
      return base / 2 + random() * (base / 2)
  }
}

export async function executeRetryPolicy<T>(policy: RetryPolicy, fn: () => Promise<T>, options: RunOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const start = now()

  let lastError: unknown
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (policy.giveUpAfter && now() - start >= policy.giveUpAfter.ms) {
      throw new RetryExhaustedError(
        `retry policy gave up after ${attempt - 1} attempt(s): time budget exceeded`,
        attempt - 1,
        lastError
      )
    }

    try {
      return await fn()
    } catch (err) {
      lastError = err
      const condition = options.classify(err)
      if (condition === null || !policy.retryOn.includes(condition)) {
        throw new NotRetryableError(err)
      }
      if (attempt === policy.maxAttempts) {
        throw new RetryExhaustedError(`retry policy gave up after ${attempt} attempt(s): max_attempts reached`, attempt, err)
      }
      const delayMs = computeDelay(policy, attempt + 1, random)
      options.onRetry?.({ attempt, error: err, delayMs })
      await sleep(delayMs)
    }
  }

  // maxAttempts is validated to be at least 1, so the loop above always
  // returns or throws. This satisfies the compiler, not a reachable path.
  throw new RetryExhaustedError('retry policy gave up: max_attempts reached', policy.maxAttempts, lastError)
}
