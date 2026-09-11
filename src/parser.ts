// A small text format for retry policies, plus a validating parser.
//
// Example input:
//
//   max_attempts: 5
//   backoff: exponential(base=200ms, factor=2, max=30s)
//   jitter: full
//   retry_on: [timeout, 5xx, connection_error]
//   give_up_after: 2m

export class ParseError extends Error {
  constructor(message: string, readonly pos: number) {
    super(message)
    this.name = 'ParseError'
  }
}

export type Duration = { ms: number }

export type BackoffPolicy =
  | { kind: 'fixed'; delay: Duration }
  | { kind: 'exponential'; base: Duration; factor: number; max: Duration }
  | { kind: 'linear'; base: Duration; increment: Duration; max: Duration }

export type Jitter = 'none' | 'full' | 'equal'

export type RetryPolicy = {
  maxAttempts: number
  backoff: BackoffPolicy
  jitter: Jitter
  retryOn: string[]
  giveUpAfter: Duration | null
}

// --- tokenizer -------------------------------------------------------------

type TokenType = 'ident' | 'symbol' | 'number' | 'duration' | 'punct' | 'eof'
type Token = { type: TokenType; text: string; pos: number }

const DURATION_RE = /^\d+(?:\.\d+)?(ms|s|m|h)\b/
// a "symbol" is a status-code-like word such as 5xx or 4xx: digits then letters.
const SYMBOL_RE = /^\d+[a-zA-Z][a-zA-Z0-9]*/
const NUMBER_RE = /^\d+(?:\.\d+)?/
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*/
const PUNCT = new Set(['[', ']', '(', ')', ',', ':', '='])

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (PUNCT.has(ch)) { tokens.push({ type: 'punct', text: ch, pos: i }); i++; continue }
    const rest = src.slice(i)
    const tries: [TokenType, RegExp][] = [
      ['duration', DURATION_RE],
      ['symbol', SYMBOL_RE],
      ['number', NUMBER_RE],
      ['ident', IDENT_RE],
    ]
    let matched = false
    for (const [type, re] of tries) {
      const m = re.exec(rest)
      if (m) {
        tokens.push({ type, text: m[0], pos: i })
        i += m[0].length
        matched = true
        break
      }
    }
    if (!matched) throw new ParseError(`unexpected character '${ch}'`, i)
  }
  tokens.push({ type: 'eof', text: '', pos: src.length })
  return tokens
}

// --- raw value tree (pre-validation) ----------------------------------------

type RawValue =
  | { kind: 'duration'; text: string; pos: number }
  | { kind: 'number'; text: string; pos: number }
  | { kind: 'ident'; text: string; pos: number }
  | { kind: 'list'; items: string[]; pos: number }
  | { kind: 'call'; name: string; args: Map<string, RawValue>; pos: number }

class TokenStream {
  private pos = 0
  constructor(private tokens: Token[]) {}

  peek(): Token { return this.tokens[this.pos] }
  next(): Token { return this.tokens[this.pos++] }

  expectPunct(text: string): Token {
    const t = this.next()
    if (t.type !== 'punct' || t.text !== text) {
      throw new ParseError(`expected '${text}', found '${t.text || 'end of input'}'`, t.pos)
    }
    return t
  }

  expectIdent(): Token {
    const t = this.next()
    if (t.type !== 'ident') {
      throw new ParseError(`expected a name, found '${t.text || 'end of input'}'`, t.pos)
    }
    return t
  }

  atPunct(text: string): boolean {
    const t = this.peek()
    return t.type === 'punct' && t.text === text
  }
}

function parseFields(stream: TokenStream): Map<string, RawValue> {
  const fields = new Map<string, RawValue>()
  while (stream.peek().type !== 'eof') {
    const key = stream.expectIdent()
    stream.expectPunct(':')
    const value = parseValue(stream)
    if (fields.has(key.text)) throw new ParseError(`duplicate field '${key.text}'`, key.pos)
    fields.set(key.text, value)
  }
  return fields
}

function parseValue(stream: TokenStream): RawValue {
  const t = stream.peek()
  if (t.type === 'duration') { stream.next(); return { kind: 'duration', text: t.text, pos: t.pos } }
  if (t.type === 'number') { stream.next(); return { kind: 'number', text: t.text, pos: t.pos } }
  if (t.type === 'punct' && t.text === '[') return parseList(stream)
  if (t.type === 'ident') {
    const name = stream.next()
    if (stream.atPunct('(')) return parseCall(stream, name.text, name.pos)
    return { kind: 'ident', text: name.text, pos: name.pos }
  }
  throw new ParseError(`unexpected token '${t.text || 'end of input'}'`, t.pos)
}

function parseList(stream: TokenStream): RawValue {
  const open = stream.expectPunct('[')
  const items: string[] = []
  if (!stream.atPunct(']')) {
    items.push(stream.next().text)
    while (stream.atPunct(',')) {
      stream.next()
      items.push(stream.next().text)
    }
  }
  stream.expectPunct(']')
  return { kind: 'list', items, pos: open.pos }
}

function parseCall(stream: TokenStream, name: string, pos: number): RawValue {
  stream.expectPunct('(')
  const args = new Map<string, RawValue>()
  if (!stream.atPunct(')')) {
    parseArg(stream, args)
    while (stream.atPunct(',')) {
      stream.next()
      parseArg(stream, args)
    }
  }
  stream.expectPunct(')')
  return { kind: 'call', name, args, pos }
}

function parseArg(stream: TokenStream, args: Map<string, RawValue>): void {
  const key = stream.expectIdent()
  stream.expectPunct('=')
  args.set(key.text, parseValue(stream))
}

// --- validation --------------------------------------------------------------

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 }

function toDuration(raw: RawValue | undefined, field: string): Duration {
  if (!raw || raw.kind !== 'duration') {
    throw new ParseError(`${field} must be a duration like "200ms" or "2s"`, raw?.pos ?? 0)
  }
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw.text)!
  return { ms: parseFloat(m[1]) * UNIT_MS[m[2]] }
}

function toNumber(raw: RawValue | undefined, field: string): number {
  if (!raw || raw.kind !== 'number') {
    throw new ParseError(`${field} must be a number`, raw?.pos ?? 0)
  }
  return parseFloat(raw.text)
}

function buildBackoff(raw: RawValue | undefined): BackoffPolicy {
  if (!raw || raw.kind !== 'call') {
    throw new ParseError('backoff must be a call like exponential(base=200ms, factor=2, max=30s)', raw?.pos ?? 0)
  }
  const arg = (name: string) => raw.args.get(name)
  if (raw.name === 'fixed') {
    return { kind: 'fixed', delay: toDuration(arg('delay'), 'delay') }
  }
  if (raw.name === 'exponential') {
    const factor = toNumber(arg('factor'), 'factor')
    if (factor <= 1) throw new ParseError('exponential factor must be greater than 1', raw.pos)
    return {
      kind: 'exponential',
      base: toDuration(arg('base'), 'base'),
      factor,
      max: toDuration(arg('max'), 'max'),
    }
  }
  if (raw.name === 'linear') {
    return {
      kind: 'linear',
      base: toDuration(arg('base'), 'base'),
      increment: toDuration(arg('increment'), 'increment'),
      max: toDuration(arg('max'), 'max'),
    }
  }
  throw new ParseError(`unknown backoff strategy "${raw.name}", expected fixed, exponential or linear`, raw.pos)
}

function buildJitter(raw: RawValue | undefined): Jitter {
  if (!raw) return 'none'
  if (raw.kind !== 'ident' || (raw.text !== 'none' && raw.text !== 'full' && raw.text !== 'equal')) {
    throw new ParseError('jitter must be one of: none, full, equal', raw.pos)
  }
  return raw.text
}

export function parseRetryPolicy(source: string): RetryPolicy {
  const stream = new TokenStream(tokenize(source))
  const fields = parseFields(stream)

  const maxAttemptsRaw = fields.get('max_attempts')
  if (!maxAttemptsRaw) throw new ParseError('missing required field "max_attempts"', 0)
  const maxAttempts = toNumber(maxAttemptsRaw, 'max_attempts')
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ParseError('max_attempts must be a whole number of at least 1', maxAttemptsRaw.pos)
  }

  const backoff = buildBackoff(fields.get('backoff'))
  const jitter = buildJitter(fields.get('jitter'))

  const retryOnRaw = fields.get('retry_on')
  if (!retryOnRaw || retryOnRaw.kind !== 'list' || retryOnRaw.items.length === 0) {
    throw new ParseError('retry_on must be a non-empty list, e.g. [timeout, 5xx]', retryOnRaw?.pos ?? 0)
  }

  const giveUpAfterRaw = fields.get('give_up_after')
  const giveUpAfter = giveUpAfterRaw ? toDuration(giveUpAfterRaw, 'give_up_after') : null

  return { maxAttempts, backoff, jitter, retryOn: retryOnRaw.items, giveUpAfter }
}
