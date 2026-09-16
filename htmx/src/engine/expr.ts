// Tiny expression language for formulas and dice.
//   2d6 + 1        d20        (body + athletics)d6        floor(wounds / 2)
// Evaluated in a single pass while parsing; dice are rolled as they are met.

export type Scope = Record<string, number>
export type Rng = (sides: number) => number // returns 1..sides

export type DiceGroup = { count: number; sides: number; values: number[] }

export type EvalResult = {
  total: number
  breakdown: string // e.g. "4d6[6,3,5,1] + 2"
  dice: DiceGroup[]
}

export class ExprError extends Error {}

const MAX_DICE = 100
const MAX_SIDES = 1000

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
}

export const cryptoRng: Rng = (sides) => {
  // Rejection sampling avoids modulo bias.
  const limit = Math.floor(0x1_0000_0000 / sides) * sides
  const buf = new Uint32Array(1)
  do crypto.getRandomValues(buf)
  while (buf[0]! >= limit)
  return (buf[0]! % sides) + 1
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; name: string }
  | { kind: 'dice'; sides: number }
  | { kind: 'op'; op: string }

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (/\s/.test(ch)) {
      i++
    } else if (/[0-9.]/.test(ch)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))
      if (!m) throw new ExprError(`Bad number at "${src.slice(i)}"`)
      tokens.push({ kind: 'num', value: Number(m[0]) })
      i += m[0].length
    } else if (/[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))![0]
      const dice = /^d(\d+)$/.exec(word)
      tokens.push(dice ? { kind: 'dice', sides: Number(dice[1]) } : { kind: 'ident', name: word })
      i += word.length
    } else if ('+-*/(),'.includes(ch)) {
      tokens.push({ kind: 'op', op: ch })
      i++
    } else {
      throw new ExprError(`Unexpected character "${ch}"`)
    }
  }
  return tokens
}

type Value = { v: number; t: string }

export function evaluate(
  src: string,
  scope: Scope,
  opts: { rng?: Rng; allowDice?: boolean } = {},
): EvalResult {
  const rng = opts.rng ?? cryptoRng
  const allowDice = opts.allowDice ?? true
  const tokens = tokenize(src)
  const dice: DiceGroup[] = []
  let pos = 0

  const peek = () => tokens[pos]
  const isOp = (op: string) => {
    const t = tokens[pos]
    return t?.kind === 'op' && t.op === op
  }
  const expectOp = (op: string) => {
    if (!isOp(op)) throw new ExprError(`Expected "${op}"`)
    pos++
  }

  function roll(count: number, sides: number): Value {
    if (!allowDice) throw new ExprError('Dice are not allowed here')
    count = Math.max(0, Math.floor(count))
    if (count > MAX_DICE) throw new ExprError(`Too many dice (${count})`)
    if (sides < 1 || sides > MAX_SIDES) throw new ExprError(`Bad die size d${sides}`)
    const values = Array.from({ length: count }, () => rng(sides))
    dice.push({ count, sides, values })
    return { v: values.reduce((a, b) => a + b, 0), t: `${count}d${sides}[${values.join(',')}]` }
  }

  function expr(): Value {
    let left = term()
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { op: string }).op
      const right = term()
      left = { v: op === '+' ? left.v + right.v : left.v - right.v, t: `${left.t} ${op} ${right.t}` }
    }
    return left
  }

  function term(): Value {
    let left = unary()
    while (isOp('*') || isOp('/')) {
      const op = (tokens[pos++] as { op: string }).op
      const right = unary()
      if (op === '/' && right.v === 0) throw new ExprError('Division by zero')
      left = { v: op === '*' ? left.v * right.v : left.v / right.v, t: `${left.t} ${op} ${right.t}` }
    }
    return left
  }

  function unary(): Value {
    if (isOp('-')) {
      pos++
      const inner = unary()
      return { v: -inner.v, t: `-${inner.t}` }
    }
    return diceTerm()
  }

  // [primary] dN
  function diceTerm(): Value {
    const t = peek()
    if (t?.kind === 'dice') {
      pos++
      return roll(1, t.sides)
    }
    const count = primary()
    const next = peek()
    if (next?.kind === 'dice') {
      pos++
      return roll(count.v, next.sides)
    }
    return count
  }

  function primary(): Value {
    const t = tokens[pos++]
    if (!t) throw new ExprError('Unexpected end of expression')
    if (t.kind === 'num') return { v: t.value, t: String(t.value) }
    if (t.kind === 'op' && t.op === '(') {
      const inner = expr()
      expectOp(')')
      return { v: inner.v, t: `(${inner.t})` }
    }
    if (t.kind === 'ident') {
      if (isOp('(')) {
        const fn = FUNCTIONS[t.name]
        if (!fn) throw new ExprError(`Unknown function "${t.name}"`)
        pos++
        const args: Value[] = []
        if (!isOp(')')) {
          args.push(expr())
          while (isOp(',')) {
            pos++
            args.push(expr())
          }
        }
        expectOp(')')
        return { v: fn(...args.map((a) => a.v)), t: `${t.name}(${args.map((a) => a.t).join(', ')})` }
      }
      const value = scope[t.name]
      if (value === undefined) throw new ExprError(`Unknown name "${t.name}"`)
      return { v: value, t: `${t.name}:${value}` }
    }
    throw new ExprError(`Unexpected "${t.kind === 'op' ? t.op : t.kind}"`)
  }

  if (tokens.length === 0) throw new ExprError('Empty expression')
  const result = expr()
  if (pos < tokens.length) throw new ExprError('Unexpected extra input')
  return { total: result.v, breakdown: result.t, dice }
}
