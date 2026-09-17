# retry-policy-lang

Every service ends up with retry logic somewhere, and it's almost always
written as ad hoc code: a `for` loop with a magic sleep, a config value nobody
remembers the units of, a comment saying "don't touch this, it's tuned." When
you want to check what a retry policy actually does, or compare two of them,
you have to read code.

This is a small text format for describing retry policies as data instead,
plus a parser that validates the result and a printer that renders it back in
a single canonical form. The idea is that a retry policy should be reviewable
the same way a config file is: read the five lines, know exactly what happens.

## The format

```
max_attempts: 5
backoff: exponential(base=200ms, factor=2, max=30s)
jitter: full
retry_on: [timeout, 5xx, connection_error]
give_up_after: 2m
```

- `max_attempts` — whole number, at least 1.
- `backoff` — one of:
  - `fixed(delay=<duration>)`
  - `exponential(base=<duration>, factor=<number>, max=<duration>)` (factor must be > 1)
  - `linear(base=<duration>, increment=<duration>, max=<duration>)`
- `jitter` — `none`, `full`, or `equal`. Defaults to `none` if left out.
- `retry_on` — a non-empty list of conditions, e.g. `timeout`, `5xx`, `429`, `connection_error`.
- `give_up_after` — optional, a total time budget across all attempts.

Durations are a number followed by a unit: `ms`, `s`, `m`, or `h`. Lines
starting with `#` are comments.

## Usage

```ts
import { parseRetryPolicy, printRetryPolicy, canonicalize } from './src/index'

const policy = parseRetryPolicy(`
  max_attempts: 5
  backoff: exponential(base=200ms, factor=2, max=30s)
  retry_on: [timeout, 5xx]
  give_up_after: 90s
`)

policy.maxAttempts     // 5
policy.backoff.kind    // 'exponential'
policy.giveUpAfter.ms  // 90000

console.log(printRetryPolicy(policy))
// max_attempts: 5
// backoff: exponential(base=200ms, factor=2, max=30s)
// jitter: none
// retry_on: [timeout, 5xx]
// give_up_after: 90s

canonicalize('max_attempts: 3\nbackoff: fixed(delay=1000ms)\nretry_on: [timeout]')
// -> same policy, reformatted with delay shown as "1s" and jitter filled in
```

Invalid input raises a `ParseError` with a message describing what was wrong
and the character position it was found at, rather than a stack trace deep in
someone's retry loop:

```ts
parseRetryPolicy('max_attempts: 0\nbackoff: fixed(delay=1s)\nretry_on: [timeout]')
// ParseError: max_attempts must be a whole number of at least 1
```

## Running a policy

`executeRetryPolicy` turns a parsed policy into actual retry behavior against
an async function. The policy only knows about condition names like
`timeout` or `5xx`, not about what a particular client throws, so you supply
a `classify` function that maps a caught error to one of those names (or
`null` to mean "don't retry this"):

```ts
import { parseRetryPolicy, executeRetryPolicy } from './src/index'

const policy = parseRetryPolicy(`
  max_attempts: 4
  backoff: exponential(base=200ms, factor=2, max=5s)
  jitter: full
  retry_on: [timeout, 5xx]
  give_up_after: 10s
`)

const result = await executeRetryPolicy(policy, () => fetchThing(), {
  classify: (err) => (err instanceof TimeoutError ? 'timeout' : err instanceof HttpError && err.status >= 500 ? '5xx' : null),
})
```

`executeRetryPolicy` resolves with the function's result on success. On
failure it throws `NotRetryableError` (the error's `classify` result wasn't
in `retry_on`) or `RetryExhaustedError` (max attempts reached, or
`give_up_after` elapsed before the next attempt) — either way the original
error is available on `.cause`.

`sleep`, `now`, and `random` are all overridable in the options object,
which is what the tests use to run policies against a fake clock instead of
waiting on real timers.

## Building

```
npx tsc
```

compiles `src/` to `dist/` per `tsconfig.json`. There are no third-party
dependencies.

## Testing

```
npm test
```

builds the project, then runs `test/` with Node's built-in test runner
(`node --test`) against the compiled output in `dist/`. No test framework is
installed; `node:test` and `node:assert` are part of the standard library.

## Status

Early. The format, parser, printer, and scheduler above are what's
implemented today. Next up: a CLI that reads a policy file and prints it
back canonicalized.
