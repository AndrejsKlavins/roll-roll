// Character values → derived values and roll scope.
import type { Rules } from '../rules'
import { evaluate } from './expr'

export type Values = Record<string, number | string>

export function defaultValues(rules: Rules): Values {
  const values: Values = {}
  for (const f of rules.fields.values()) values[f.id] = f.default
  return values
}

/** Numeric fields plus derived values, in rules order. Broken formulas yield NaN. */
export function computeScope(rules: Rules, values: Values): Record<string, number> {
  const scope: Record<string, number> = {}
  for (const f of rules.fields.values()) {
    if (f.type !== 'text') scope[f.id] = Number(values[f.id] ?? f.default)
  }
  for (const d of rules.derived) {
    try {
      scope[d.id] = evaluate(d.formula, scope, { allowDice: false }).total
    } catch {
      scope[d.id] = NaN
    }
  }
  return scope
}
