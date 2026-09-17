// Loads and validates system/rules.yaml once at startup.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { evaluate, ExprError } from './engine/expr'

/**
 * Optional look of a field. icon is a file in system/icons/ (SVG is inlined so it can be
 * coloured by CSS; PNG/WebP/JPG are linked) or short text such as an emoji.
 */
export type Icon = { kind: 'svg'; markup: string } | { kind: 'img'; src: string } | { kind: 'text'; text: string }
/** ink: icon colour that stays readable on the colour chip (dark on light colours, white otherwise). */
type Look = { icon?: Icon; color?: string; ink?: string }

/** base: value is fixed when the character is finished; play changes are stored relative to it. */
export type NumberField = Look & {
  id: string
  label: string
  type: 'number'
  min: number
  max: number
  default: number
  base: boolean
  /** Words per value (e.g. 3 → "average"). When set, the sheet shows the word and dots instead of the number. */
  scale?: Record<number, string>
}
export type TrackField = Look & { id: string; label: string; type: 'track'; max: number; default: number }
export type TextField = Look & { id: string; label: string; type: 'text'; lines: number; default: string }
export type Field = NumberField | TrackField | TextField

/**
 * Calculated, read-only value. Can sit inside a section (type: derived) to be shown with the
 * section's other rows, or in the top-level "derived:" list (shown in a compact block).
 */
export type Derived = Look & {
  id: string
  label: string
  type: 'derived'
  formula: string
  inSection: boolean
  /** Resource pool (e.g. Health): the formula is the maximum, shown as filled/empty circles. */
  pool: boolean
}
export type SectionItem = Field | Derived
export type Section = { label: string; fields: SectionItem[] }
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

  // scales: { rating: { 1: horrible, 2: low, ... } }
  const scales = new Map<string, Record<number, string>>()
  for (const [name, words] of Object.entries(raw?.scales ?? {})) {
    const scale: Record<number, string> = {}
    for (const [value, word] of Object.entries((words ?? {}) as Record<string, unknown>)) {
      if (!/^-?\d+$/.test(value)) fail(`scales.${name}: keys must be whole numbers, got "${value}"`)
      else scale[Number(value)] = String(word)
    }
    scales.set(name, scale)
  }

  const parseLook = (f: any, where: string): Look => {
    const look: Look = {}
    if (f.color !== undefined) {
      // Unquoted 899937 is a YAML number; pad in case it had leading zeros.
      const hex = (typeof f.color === 'number' ? String(f.color).padStart(6, '0') : String(f.color)).replace(/^#/, '')
      if (/^[0-9a-f]{6}$/i.test(hex)) {
        look.color = `#${hex.toLowerCase()}`
        look.ink = luminance(hex) > 0.45 ? '#1b1a1f' : '#ffffff'
      }
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

  const parseDerived = (d: any, where: string, inSection: boolean): Derived => ({
    id: d.id,
    label: String(d.label ?? d.id),
    type: 'derived',
    formula: String(d.formula ?? ''),
    inSection,
    pool: Boolean(d.pool),
    ...parseLook(d, where),
  })

  const fields = new Map<string, Field>()
  const derived: Derived[] = []
  const sections: Section[] = (raw?.sections ?? []).map((s: any, si: number) => ({
    label: String(s?.label ?? `Section ${si + 1}`),
    fields: (s?.fields ?? []).flatMap((f: any, fi: number): SectionItem[] => {
      const where = `sections[${si}].fields[${fi}]`
      if (!checkId(f?.id, where)) return []
      if (f.type === 'derived') {
        const d = parseDerived(f, where, true)
        derived.push(d)
        return [d]
      }
      const label = String(f.label ?? f.id)
      let field: Field
      switch (f.type) {
        case 'number': {
          const min = Number(f.min ?? 0)
          const max = Number(f.max ?? 10)
          const base = Boolean(f.base ?? s?.base ?? false)
          field = { id: f.id, label, type: 'number', min, max, default: Number(f.default ?? min), base }
          const scaleName = f.scale ?? s?.scale
          if (scaleName !== undefined && scaleName !== null) {
            const scale = scales.get(String(scaleName))
            if (scale) field.scale = scale
            else fail(`${where}: unknown scale "${scaleName}" (define it under "scales:")`)
          }
          break
        }
        case 'track':
          field = { id: f.id, label, type: 'track', max: Number(f.max ?? 3), default: Number(f.default ?? 0) }
          break
        case 'text':
          field = { id: f.id, label, type: 'text', lines: Number(f.lines ?? 3), default: String(f.default ?? '') }
          break
        default:
          fail(`${where}: unknown type ${JSON.stringify(f.type)} (use number, track, text or derived)`)
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

  ;(raw?.derived ?? []).forEach((d: any, i: number) => {
    if (checkId(d?.id, `derived[${i}]`)) derived.push(parseDerived(d, `derived[${i}]`, false))
  })
  // Evaluated in order: section derived values top to bottom, then the top-level list.
  for (const d of derived) {
    try {
      scope[d.id] = evaluate(d.formula, scope, { allowDice: false }).total
    } catch (e) {
      fail(`derived "${d.id}": ${(e as Error).message}`)
      scope[d.id] = 0
    }
  }

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

/** WCAG relative luminance of a 6-digit hex colour (0 = black, 1 = white). */
function luminance(hex: string) {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** Strips XML prolog, doctype and comments so downloaded SVGs can be inlined. */
function cleanSvg(svg: string) {
  return svg
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
}
