// Loads and validates system/rules.yaml once at startup.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { evaluate, ExprError } from './engine/expr'

/**
 * Optional look of a field. icon is a file in system/icons/ (SVG is inlined so it can be
 * coloured by CSS; PNG/WebP/JPG are linked) or short text such as an emoji.
 */
export type Icon = { kind: 'svg'; markup: string } | { kind: 'img'; src: string } | { kind: 'text'; text: string }
type Look = { icon?: Icon; color?: string }

/** base: value is fixed when the character is finished; play changes are stored relative to it. */
export type NumberField = Look & {
  id: string
  label: string
  type: 'number'
  min: number
  max: number
  default: number
  base: boolean
}
export type TrackField = Look & { id: string; label: string; type: 'track'; max: number; default: number }
export type TextField = Look & { id: string; label: string; type: 'text'; lines: number; default: string }
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

  const iconsDir = join(dirname(path), 'icons')

  const parseLook = (f: any, where: string): Look => {
    const look: Look = {}
    if (f.color !== undefined) {
      // Unquoted 899937 is a YAML number; pad in case it had leading zeros.
      const hex = (typeof f.color === 'number' ? String(f.color).padStart(6, '0') : String(f.color)).replace(/^#/, '')
      if (/^[0-9a-f]{6}$/i.test(hex)) look.color = `#${hex.toLowerCase()}`
      else fail(`${where}: color must be a hex colour like "#99342c", got ${JSON.stringify(f.color)}`)
    }
    if (f.icon !== undefined) {
      const icon = String(f.icon)
      const ext = extname(icon).toLowerCase()
      if (['.svg', '.png', '.webp', '.jpg', '.jpeg'].includes(ext)) {
        const file = join(iconsDir, icon)
        if (!existsSync(file) || icon.includes('..')) fail(`${where}: icon file not found: system/icons/${icon}`)
        else if (ext === '.svg') look.icon = { kind: 'svg', markup: cleanSvg(readFileSync(file, 'utf8')) }
        else look.icon = { kind: 'img', src: `/system/icons/${encodeURIComponent(icon)}` }
      } else {
        look.icon = { kind: 'text', text: icon.slice(0, 4) }
      }
    }
    return look
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
          const base = Boolean(f.base ?? s?.base ?? false)
          field = { id: f.id, label, type: 'number', min, max, default: Number(f.default ?? min), base }
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
      Object.assign(field, parseLook(f, where))
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

/** Strips XML prolog, doctype and comments so downloaded SVGs can be inlined. */
function cleanSvg(svg: string) {
  return svg
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
}
