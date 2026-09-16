import { describe, expect, test } from 'bun:test'
import { evaluate, ExprError } from './expr'

const fixed = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length]!
}

describe('evaluate', () => {
  test('arithmetic and precedence', () => {
    expect(evaluate('1 + 2 * 3', {}).total).toBe(7)
    expect(evaluate('(1 + 2) * 3', {}).total).toBe(9)
    expect(evaluate('-2 + 5', {}).total).toBe(3)
  })

  test('names and functions', () => {
    expect(evaluate('floor(wounds / 2)', { wounds: 3 }).total).toBe(1)
    expect(evaluate('max(body, 2) + min(1, 4)', { body: 4 }).total).toBe(5)
  })

  test('dice', () => {
    const r = evaluate('3d6 + 1', {}, { rng: fixed(6, 2, 4) })
    expect(r.total).toBe(13)
    expect(r.breakdown).toBe('3d6[6,2,4] + 1')
    expect(evaluate('d20', {}, { rng: fixed(17) }).total).toBe(17)
  })

  test('computed dice count', () => {
    const r = evaluate('(body + skill)d6', { body: 2, skill: 1 }, { rng: fixed(5) })
    expect(r.dice).toEqual([{ count: 3, sides: 6, values: [5, 5, 5] }])
    expect(evaluate('(1 - 3)d6', {}).total).toBe(0) // negative pools roll nothing
  })

  test('errors', () => {
    expect(() => evaluate('2d6', {}, { allowDice: false })).toThrow(ExprError)
    expect(() => evaluate('nope + 1', {})).toThrow('Unknown name')
    expect(() => evaluate('1 +', {})).toThrow(ExprError)
    expect(() => evaluate('500d6', {})).toThrow('Too many dice')
  })

  test('crypto rng stays in range', () => {
    const { dice } = evaluate('100d6', {})
    expect(dice[0]!.values.every((v) => v >= 1 && v <= 6)).toBe(true)
  })
})
