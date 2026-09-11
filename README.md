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
// give_up_after: 1.5m

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

## Building

```
npx tsc
```

compiles `src/` to `dist/` per `tsconfig.json`. There are no third-party
dependencies.

## Status

Early. The grammar and validation rules above are what's implemented today;
see the roadmap in project notes for what's planned next.
