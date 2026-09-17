import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRules } from './rules'

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
        '      - { id: c, type: number, color: "8ab8ac", icon: "⚔" }',
        '      - { id: d, type: number }',
      ].join('\n'),
    )
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => rules.fields.get(id)!)
    expect(a!.color).toBe('#99342c')
    expect(a!.icon).toEqual({ kind: 'svg', markup: '<svg viewBox="0 0 24 24"><circle r="3"/></svg>' })
    expect(b!.color).toBe('#899937') // unquoted YAML number
    expect(b!.icon).toEqual({ kind: 'img', src: '/system/icons/eye.png' })
    expect(c!.icon).toEqual({ kind: 'text', text: '⚔' })
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
