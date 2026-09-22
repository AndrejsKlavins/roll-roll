import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abilityRankRange, loadRules } from './rules'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function rulesWith(fields: string) {
  const dir = mkdtempSync(join(tmpdir(), 'roll-rules-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'icons'))
  writeFileSync(
    join(dir, 'icons', 'eye.svg'),
    '<?xml version="1.0"?>\n<!-- exported -->\n<svg viewBox="0 0 24 24"><circle r="3"/></svg>',
  )
  writeFileSync(join(dir, 'icons', 'eye.png'), '')
  const path = join(dir, 'rules.yaml')
  writeFileSync(path, `name: Test\nsections:\n  - label: A\n    fields:\n${fields}\nderived: []\nrolls: []\n`)
  return loadRules(path)
}

describe('field look', () => {
  test('parses colours and icons', async () => {
    const rules = await rulesWith(
      [
        '      - { id: a, type: number, color: "#99342C", icon: eye.svg }',
        '      - { id: b, type: number, color: 899937, icon: eye.png }',
        '      - { id: c, type: number, color: "f2d08d", icon: "⚔" }',
        '      - { id: d, type: number }',
      ].join('\n'),
    )
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => rules.fields.get(id)!)
    expect(a!.color).toBe('#99342c')
    expect(a!.icon).toEqual({ kind: 'svg', markup: '<svg viewBox="0 0 24 24"><circle r="3"/></svg>' })
    expect(a!.ink).toBe('#ffffff') // dark colour → white icon
    expect(b!.color).toBe('#899937') // unquoted YAML number
    expect(b!.icon).toEqual({ kind: 'img', src: '/system/icons/eye.png' })
    expect(c!.icon).toEqual({ kind: 'text', text: '⚔' })
    expect(c!.ink).toBe('#1b1a1f') // light colour → dark icon
    expect(d!.color).toBeUndefined()
    expect(d!.icon).toBeUndefined()
  })

  test('reports bad colours and missing icon files at startup', async () => {
    const load = rulesWith(
      ['      - { id: a, type: number, color: "red" }', '      - { id: b, type: number, icon: missing.svg }'].join('\n'),
    )
    await expect(load).rejects.toThrow(/color must be a hex colour[\s\S]*icon file not found: system\/icons\/missing\.svg/)
  })
})

describe('scales', () => {
  test('section scale applies to its number fields; fields can override', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roll-rules-'))
    dirs.push(dir)
    const path = join(dir, 'rules.yaml')
    writeFileSync(
      path,
      [
        'name: Test',
        'scales:',
        '  rating: { 1: horrible, 2: low, 3: average }',
        '  other: { 1: one }',
        'sections:',
        '  - label: A',
        '    scale: rating',
        '    fields:',
        '      - { id: a, type: number }',
        '      - { id: b, type: number, scale: other }',
        '      - { id: c, type: text }',
        '  - label: B',
        '    fields:',
        '      - { id: d, type: number }',
        'derived: []',
        'rolls: []',
      ].join('\n'),
    )
    const rules = await loadRules(path)
    const get = (id: string) => rules.fields.get(id) as { scale?: Record<number, string> }
    expect(get('a').scale).toEqual({ 1: 'horrible', 2: 'low', 3: 'average' })
    expect(get('b').scale).toEqual({ 1: 'one' })
    expect(get('c').scale).toBeUndefined()
    expect(get('d').scale).toBeUndefined()
  })

  test('unknown scale fails startup', async () => {
    await expect(rulesWith('      - { id: a, type: number, scale: nope }')).rejects.toThrow('unknown scale "nope"')
  })
})

describe('derived values in sections', () => {
  test('are placed in their section, evaluated in order, and kept out of editable fields', async () => {
    const rules = await rulesWith(
      [
        '      - { id: str, type: number, default: 4 }',
        '      - { id: health, label: Health, type: derived, formula: "str * 2", icon: eye.svg, color: "#ffffff" }',
        '      - { id: guard, type: derived, formula: "health + 1" }',
      ].join('\n'),
    )
    expect(rules.sections[0]!.fields.map((f) => `${f.id}:${f.type}`)).toEqual(['str:number', 'health:derived', 'guard:derived'])
    expect(rules.derived.map((d) => [d.id, d.inSection])).toEqual([['health', true], ['guard', true]])
    expect(rules.derived[0]!.ink).toBe('#1b1a1f') // white chip → dark icon
    expect(rules.fields.has('health')).toBe(false)
  })

  test('bad formulas fail startup', async () => {
    await expect(rulesWith('      - { id: x, type: derived, formula: "nope + 1" }')).rejects.toThrow('derived "x": Unknown name "nope"')
  })
})

describe('solo roll rank ladder', () => {
  /** A whole rules file, so sections can be marked base and carry a word scale. */
  const rulesFile = (lines: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'roll-rules-'))
    dirs.push(dir)
    const path = join(dir, 'rules.yaml')
    writeFileSync(path, lines.join('\n'))
    return loadRules(path)
  }

  test("comes from the abilities' word scale", async () => {
    const rules = await rulesFile([
      'name: Test',
      'scales:',
      '  rating:',
      '    0: awful',
      '    1: poor',
      '    2: fine',
      '    3: great',
      'sections:',
      '  - label: Abilities',
      '    base: true',
      '    fields:',
      '      - { id: might, type: number, default: 2, scale: rating }',
      'derived: []',
      'rolls: []',
    ])
    expect(abilityRankRange(rules)).toEqual({
      min: 0,
      max: 3,
      def: 2,
      scale: { 0: 'awful', 1: 'poor', 2: 'fine', 3: 'great' },
    })
  })

  test('falls back to 1..5 when the abilities carry no scale', async () => {
    // Abilities have no fixed bounds in play, so min/max are usually infinite and unusable here.
    const rules = await rulesFile([
      'name: Test',
      'sections:',
      '  - label: Abilities',
      '    base: true',
      '    fields:',
      '      - { id: might, type: number, default: 4 }',
      'derived: []',
      'rolls: []',
    ])
    expect(abilityRankRange(rules)).toEqual({ min: 1, max: 5, def: 4, scale: undefined })
  })

  test('trained skills are not part of the ladder', async () => {
    const rules = await rulesFile([
      'name: Test',
      'scales:',
      '  rating:',
      '    2: fine',
      '    3: great',
      '  skill:',
      '    0: untrained',
      '    9: master',
      'training:',
      '  points_stat: pts',
      '  rank_costs: [4]',
      'sections:',
      '  - label: Abilities',
      '    base: true',
      '    fields:',
      '      - { id: might, type: number, default: 3, scale: rating }',
      '      - { id: sneak, type: number, trained: true, scale: skill }',
      '      - { id: pts, type: derived, formula: "3" }',
      'derived: []',
      'rolls: []',
    ])
    // The skill scale reaches 9; the ladder still stops at the abilities' 3.
    expect(abilityRankRange(rules)).toMatchObject({ min: 2, max: 3, def: 3 })
  })
})
