// Runs against the compiled output, so `npm run build` first.
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseRetryPolicy, computeDelay, executeRetryPolicy, NotRetryableError, RetryExhaustedError } = require('../dist/index')

// A fake clock: `sleep` advances `now` by exactly the requested amount, so
// tests don't depend on real timers and stay deterministic.
function fakeClock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms) => { time += ms },
  }
}

function fixedRandom(value) {
  return () => value
}

test('returns the result on the first successful attempt without sleeping', async () => {
  const policy = parseRetryPolicy('max_attempts: 5\nbackoff: fixed(delay=100ms)\nretry_on: [timeout]')
  let calls = 0
  const sleeps = []
  const result = await executeRetryPolicy(policy, async () => { calls++; return 'ok' }, {
    classify: () => null,
    sleep: async (ms) => sleeps.push(ms),
  })
  assert.equal(result, 'ok')
  assert.equal(calls, 1)
  assert.deepEqual(sleeps, [])
})

test('retries a retryable error and succeeds', async () => {
  const policy = parseRetryPolicy('max_attempts: 5\nbackoff: fixed(delay=100ms)\nretry_on: [timeout]')
  let calls = 0
  const sleeps = []
  const result = await executeRetryPolicy(
    policy,
    async () => {
      calls++
      if (calls < 3) throw new Error('boom')
      return 'ok'
    },
    { classify: () => 'timeout', sleep: async (ms) => sleeps.push(ms) }
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [100, 100])
})

test('throws NotRetryableError immediately for an unclassified error', async () => {
  const policy = parseRetryPolicy('max_attempts: 5\nbackoff: fixed(delay=100ms)\nretry_on: [timeout]')
  let calls = 0
  await assert.rejects(
    executeRetryPolicy(policy, async () => { calls++; throw new Error('boom') }, { classify: () => null }),
    (err) => {
      assert.ok(err instanceof NotRetryableError)
      assert.equal(err.cause.message, 'boom')
      return true
    }
  )
  assert.equal(calls, 1)
})

test('throws NotRetryableError when the classified condition is not in retry_on', async () => {
  const policy = parseRetryPolicy('max_attempts: 5\nbackoff: fixed(delay=100ms)\nretry_on: [timeout]')
  await assert.rejects(
    executeRetryPolicy(policy, async () => { throw new Error('boom') }, { classify: () => '5xx' }),
    NotRetryableError
  )
})

test('exhausts after max_attempts and reports the last error', async () => {
  const policy = parseRetryPolicy('max_attempts: 3\nbackoff: fixed(delay=10ms)\nretry_on: [timeout]')
  let calls = 0
  await assert.rejects(
    executeRetryPolicy(policy, async () => { calls++; throw new Error(`fail ${calls}`) }, {
      classify: () => 'timeout',
      sleep: async () => {},
    }),
    (err) => {
      assert.ok(err instanceof RetryExhaustedError)
      assert.equal(err.attempts, 3)
      assert.equal(err.cause.message, 'fail 3')
      assert.match(err.message, /max_attempts reached/)
      return true
    }
  )
  assert.equal(calls, 3)
})

test('exhausts once the time budget is exceeded, before max_attempts', async () => {
  const policy = parseRetryPolicy(
    'max_attempts: 10\nbackoff: fixed(delay=80ms)\nretry_on: [timeout]\ngive_up_after: 100ms'
  )
  const clock = fakeClock()
  let calls = 0
  await assert.rejects(
    executeRetryPolicy(policy, async () => { calls++; throw new Error('boom') }, {
      classify: () => 'timeout',
      sleep: clock.sleep,
      now: clock.now,
    }),
    (err) => {
      assert.ok(err instanceof RetryExhaustedError)
      assert.equal(err.attempts, 2)
      assert.match(err.message, /time budget exceeded/)
      return true
    }
  )
  assert.equal(calls, 2)
})

test('onRetry is called with the attempt, error and computed delay', async () => {
  const policy = parseRetryPolicy('max_attempts: 3\nbackoff: fixed(delay=50ms)\nretry_on: [timeout]')
  const seen = []
  let calls = 0
  await executeRetryPolicy(
    policy,
    async () => { calls++; if (calls < 2) throw new Error('boom'); return 'ok' },
    {
      classify: () => 'timeout',
      sleep: async () => {},
      onRetry: (ctx) => seen.push(ctx),
    }
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0].attempt, 1)
  assert.equal(seen[0].delayMs, 50)
  assert.equal(seen[0].error.message, 'boom')
})

test('computeDelay for fixed backoff ignores attempt number', () => {
  const policy = parseRetryPolicy('max_attempts: 5\nbackoff: fixed(delay=250ms)\nretry_on: [timeout]')
  assert.equal(computeDelay(policy, 1), 250)
  assert.equal(computeDelay(policy, 4), 250)
})

test('computeDelay for exponential backoff grows and caps at max', () => {
  const policy = parseRetryPolicy(
    'max_attempts: 6\nbackoff: exponential(base=100ms, factor=2, max=500ms)\nretry_on: [timeout]'
  )
  assert.equal(computeDelay(policy, 1), 100)
  assert.equal(computeDelay(policy, 2), 200)
  assert.equal(computeDelay(policy, 3), 400)
  assert.equal(computeDelay(policy, 4), 500) // 800 capped at max
})

test('computeDelay for linear backoff grows by increment and caps at max', () => {
  const policy = parseRetryPolicy(
    'max_attempts: 6\nbackoff: linear(base=100ms, increment=50ms, max=220ms)\nretry_on: [timeout]'
  )
  assert.equal(computeDelay(policy, 1), 100)
  assert.equal(computeDelay(policy, 2), 150)
  assert.equal(computeDelay(policy, 3), 200)
  assert.equal(computeDelay(policy, 4), 220) // 250 capped at max
})

test('computeDelay applies full jitter between 0 and the base delay', () => {
  const policy = parseRetryPolicy('max_attempts: 5\nbackoff: fixed(delay=200ms)\njitter: full\nretry_on: [timeout]')
  assert.equal(computeDelay(policy, 1, fixedRandom(0.5)), 100)
  assert.equal(computeDelay(policy, 1, fixedRandom(0)), 0)
})

test('computeDelay applies equal jitter between half and the full base delay', () => {
  const policy = parseRetryPolicy('max_attempts: 5\nbackoff: fixed(delay=200ms)\njitter: equal\nretry_on: [timeout]')
  assert.equal(computeDelay(policy, 1, fixedRandom(0)), 100)
  assert.equal(computeDelay(policy, 1, fixedRandom(1)), 200)
})
