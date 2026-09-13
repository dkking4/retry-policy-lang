// Runs against the compiled output, so `npm run build` first.
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseRetryPolicy, printRetryPolicy, canonicalize, ParseError } = require('../dist/index')

function assertParseError(source, message, pos) {
  assert.throws(
    () => parseRetryPolicy(source),
    (err) => {
      assert.ok(err instanceof ParseError, `expected a ParseError, got ${err}`)
      assert.equal(err.message, message)
      if (pos !== undefined) assert.equal(err.pos, pos)
      return true
    }
  )
}

const VALID = `
max_attempts: 5
backoff: exponential(base=200ms, factor=2, max=30s)
jitter: full
retry_on: [timeout, 5xx, connection_error]
give_up_after: 2m
`

test('parses a full valid policy', () => {
  const policy = parseRetryPolicy(VALID)
  assert.equal(policy.maxAttempts, 5)
  assert.deepEqual(policy.backoff, { kind: 'exponential', base: { ms: 200 }, factor: 2, max: { ms: 30000 } })
  assert.equal(policy.jitter, 'full')
  assert.deepEqual(policy.retryOn, ['timeout', '5xx', 'connection_error'])
  assert.deepEqual(policy.giveUpAfter, { ms: 120000 })
})

test('jitter defaults to none and give_up_after to null when omitted', () => {
  const policy = parseRetryPolicy('max_attempts: 1\nbackoff: fixed(delay=1s)\nretry_on: [timeout]')
  assert.equal(policy.jitter, 'none')
  assert.equal(policy.giveUpAfter, null)
})

test('parses fixed and linear backoff', () => {
  const fixed = parseRetryPolicy('max_attempts: 1\nbackoff: fixed(delay=250ms)\nretry_on: [timeout]')
  assert.deepEqual(fixed.backoff, { kind: 'fixed', delay: { ms: 250 } })

  const linear = parseRetryPolicy(
    'max_attempts: 1\nbackoff: linear(base=1s, increment=500ms, max=10s)\nretry_on: [timeout]'
  )
  assert.deepEqual(linear.backoff, {
    kind: 'linear',
    base: { ms: 1000 },
    increment: { ms: 500 },
    max: { ms: 10000 },
  })
})

test('ignores comment lines', () => {
  const policy = parseRetryPolicy(
    '# a policy for the payments client\nmax_attempts: 1\nbackoff: fixed(delay=1s)\nretry_on: [timeout] # inline too'
  )
  assert.equal(policy.maxAttempts, 1)
})

test('rejects missing max_attempts', () => {
  assertParseError('backoff: fixed(delay=1s)\nretry_on: [timeout]', 'missing required field "max_attempts"', 0)
})

test('rejects max_attempts of zero', () => {
  assertParseError(
    'max_attempts: 0\nbackoff: fixed(delay=1s)\nretry_on: [timeout]',
    'max_attempts must be a whole number of at least 1'
  )
})

test('rejects a fractional max_attempts', () => {
  assertParseError(
    'max_attempts: 2.5\nbackoff: fixed(delay=1s)\nretry_on: [timeout]',
    'max_attempts must be a whole number of at least 1'
  )
})

test('rejects a non-numeric max_attempts', () => {
  assertParseError(
    'max_attempts: five\nbackoff: fixed(delay=1s)\nretry_on: [timeout]',
    'max_attempts must be a number'
  )
})

test('rejects an unknown backoff strategy', () => {
  assertParseError(
    'max_attempts: 1\nbackoff: quadratic(base=1s)\nretry_on: [timeout]',
    'unknown backoff strategy "quadratic", expected fixed, exponential or linear'
  )
})

test('rejects an exponential factor that is not greater than 1', () => {
  assertParseError(
    'max_attempts: 1\nbackoff: exponential(base=1s, factor=1, max=10s)\nretry_on: [timeout]',
    'exponential factor must be greater than 1'
  )
})

test('rejects a missing backoff argument', () => {
  assertParseError(
    'max_attempts: 1\nbackoff: fixed()\nretry_on: [timeout]',
    'delay must be a duration like "200ms" or "2s"'
  )
})

test('rejects an invalid jitter value', () => {
  assertParseError(
    'max_attempts: 1\nbackoff: fixed(delay=1s)\njitter: heavy\nretry_on: [timeout]',
    'jitter must be one of: none, full, equal'
  )
})

test('rejects an empty retry_on list', () => {
  assertParseError(
    'max_attempts: 1\nbackoff: fixed(delay=1s)\nretry_on: []',
    'retry_on must be a non-empty list, e.g. [timeout, 5xx]'
  )
})

test('rejects a missing retry_on field', () => {
  assertParseError('max_attempts: 1\nbackoff: fixed(delay=1s)', 'retry_on must be a non-empty list, e.g. [timeout, 5xx]')
})

test('rejects a duplicate field', () => {
  assertParseError(
    'max_attempts: 1\nmax_attempts: 2\nbackoff: fixed(delay=1s)\nretry_on: [timeout]',
    "duplicate field 'max_attempts'"
  )
})

test('rejects an unexpected character', () => {
  assertParseError('max_attempts: 1\nbackoff: fixed(delay=1s)\nretry_on: [timeout]\n%', "unexpected character '%'", 61)
})

test('rejects a duration-shaped value with an unrecognized unit', () => {
  // "1step" tokenizes as a symbol (digits followed by letters), same class as "5xx",
  // so it fails at the value grammar rather than the duration-specific check.
  assertParseError(
    'max_attempts: 1\nbackoff: fixed(delay=1step)\nretry_on: [timeout]',
    "unexpected token '1step'"
  )
})

test('canonicalize reformats units, field order and spacing', () => {
  const out = canonicalize('retry_on:[timeout],max_attempts:3,backoff:fixed(delay=1000ms)'.replace(/,/g, '\n'))
  assert.equal(out, 'max_attempts: 3\nbackoff: fixed(delay=1s)\njitter: none\nretry_on: [timeout]\n')
})

test('printRetryPolicy omits give_up_after when absent and includes it when present', () => {
  const withoutBudget = parseRetryPolicy('max_attempts: 1\nbackoff: fixed(delay=1s)\nretry_on: [timeout]')
  assert.ok(!printRetryPolicy(withoutBudget).includes('give_up_after'))

  const withBudget = parseRetryPolicy('max_attempts: 1\nbackoff: fixed(delay=1s)\nretry_on: [timeout]\ngive_up_after: 2m')
  assert.match(printRetryPolicy(withBudget), /give_up_after: 2m/)
})

test('printRetryPolicy reduces durations to the largest evenly-dividing unit', () => {
  const policy = parseRetryPolicy(
    'max_attempts: 1\nbackoff: exponential(base=3600000ms, factor=2, max=90000ms)\nretry_on: [timeout]'
  )
  assert.match(printRetryPolicy(policy), /base=1h/)
  // 90000ms doesn't divide evenly into minutes, so it stays in seconds.
  assert.match(printRetryPolicy(policy), /max=90s/)
})
