// Loads and validates system/rules.yaml once at startup.
import { join } from 'node:path'
import { evaluate, ExprError } from './engine/expr'

export type NumberField = { id: string; label: string; type: 'number'; min: number; max: number; default: number }
export type TrackField = { id: string; label: string; type: 'track'; max: number; default: number }
export type TextField = { id: string; label: string; type: 'text'; lines: number; default: string }
export type Field = NumberField | TrackField | TextField

export type Section = { label: string; fields: Field[] }
export type Derived = { id: string; label: string; formula: string }
export type RollDef = { id: string; label: string; dice: string }

export type Rules = {
  name: string
  sections: Section[]
  derived: Derived[]
  rolls: RollDef[]
  fields: Map<string, Field>
}

export const RULES_PATH = join(import.meta.dir, '..', 'system', 'rules.yaml')

export async function loadRules(path = RULES_PATH): Promise<Rules> {
  const raw = Bun.YAML.parse(await Bun.file(path).text()) as any
  const errors: string[] = []
  const fail = (msg: string) => errors.push(msg)
  const ids = new Set<string>()

  const checkId = (id: unknown, where: string): id is string => {
    if (typeof id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
      fail(`${where}: id must be letters/digits/underscore, got ${JSON.stringify(id)}`)
      return false
    }
    if (/^d\d+$/.test(id)) fail(`${where}: id "${id}" looks like a die`)
    if (ids.has(id)) fail(`${where}: duplicate id "${id}"`)
    ids.add(id)
    return true
  }

  const fields = new Map<string, Field>()
  const sections: Section[] = (raw?.sections ?? []).map((s: any, si: number) => ({
    label: String(s?.label ?? `Section ${si + 1}`),
    fields: (s?.fields ?? []).flatMap((f: any, fi: number): Field[] => {
      const where = `sections[${si}].fields[${fi}]`
      if (!checkId(f?.id, where)) return []
      const label = String(f.label ?? f.id)
      let field: Field
      switch (f.type) {
        case 'number': {
          const min = Number(f.min ?? 0)
          const max = Number(f.max ?? 10)
          field = { id: f.id, label, type: 'number', min, max, default: Number(f.default ?? min) }
          break
        }
        case 'track':
          field = { id: f.id, label, type: 'track', max: Number(f.max ?? 3), default: Number(f.default ?? 0) }
          break
        case 'text':
          field = { id: f.id, label, type: 'text', lines: Number(f.lines ?? 3), default: String(f.default ?? '') }
          break
        default:
          fail(`${where}: unknown type ${JSON.stringify(f.type)} (use number, track or text)`)
          return []
      }
      fields.set(field.id, field)
      return [field]
    }),
  }))

  // Dry-run formulas against default values so typos fail at startup, not at the table.
  const scope: Record<string, number> = {}
  for (const f of fields.values()) if (f.type !== 'text') scope[f.id] = f.default
  const dryRng = () => 1

  const derived: Derived[] = (raw?.derived ?? []).flatMap((d: any, i: number) => {
    const where = `derived[${i}]`
    if (!checkId(d?.id, where)) return []
    const formula = String(d.formula ?? '')
    try {
      scope[d.id] = evaluate(formula, scope, { allowDice: false }).total
    } catch (e) {
      fail(`${where} "${d.id}": ${(e as Error).message}`)
      scope[d.id] = 0
    }
    return [{ id: d.id, label: String(d.label ?? d.id), formula }]
  })

  const rolls: RollDef[] = (raw?.rolls ?? []).flatMap((r: any, i: number) => {
    const where = `rolls[${i}]`
    if (!checkId(r?.id, where)) return []
    const dice = String(r.dice ?? '')
    try {
      evaluate(dice, scope, { rng: dryRng })
    } catch (e) {
      if (e instanceof ExprError) fail(`${where} "${r.id}": ${e.message}`)
      else throw e
    }
    return [{ id: r.id, label: String(r.label ?? r.id), dice }]
  })

  if (errors.length) {
    throw new Error(`Problems in ${path}:\n  - ${errors.join('\n  - ')}`)
  }
  return { name: String(raw?.name ?? 'Untitled system'), sections, derived, rolls, fields }
}
