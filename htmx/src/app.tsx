import { Hono, type Context } from 'hono'
import { serveStatic, upgradeWebSocket } from 'hono/bun'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Child } from 'hono/jsx'
import { ExprError } from './engine/expr'
import { hub } from './hub'
import type { Character, FieldSetEvent, RollEvent, Session, Visibility } from './session'
import { ChangeLog, RollEntry } from './views/feed'
import { GmPage, JoinPage, PlayerPage } from './views/pages'
import { DerivedView, FieldView, Sheet } from './views/sheet'

const CHAR_COOKIE = 'char'
const html = (node: Child) => String(node ?? '')

export function createApp(session: Session, opts: { playerUrls: string[]; qrSvg: string }) {
  const app = new Hono()
  const rules = session.rules

  // ---- static files -------------------------------------------------------
  const vendor: Record<string, string> = {
    'htmx.min.js': './node_modules/htmx.org/dist/htmx.min.js',
    'ws.min.js': './node_modules/htmx-ext-ws/dist/ws.min.js',
    'alpine.min.js': './node_modules/alpinejs/dist/cdn.min.js',
  }
  for (const [file, path] of Object.entries(vendor)) app.get(`/vendor/${file}`, serveStatic({ path }))
  app.use('/public/*', serveStatic({ root: './' }))

  // ---- push helpers -------------------------------------------------------
  const pushRoll = (roll: RollEvent) =>
    hub.send(
      () => true,
      (client) => {
        const entry = RollEntry({ roll, viewer: client.role })
        return entry ? `<div hx-swap-oob="afterbegin:#feed">${html(entry)}</div>` : ''
      },
    )

  const toOwnerAndGm = (charId: string) => (client: { role: string; charId: string | null }) =>
    client.role === 'gm' || client.charId === charId

  const pushFieldChange = (char: Character, e: FieldSetEvent) => {
    const field = rules.fields.get(e.field)!
    const parts =
      html(<FieldView char={char} field={field} oob />) +
      html(<DerivedView rules={rules} char={char} scope={session.scope(char.id)} oob />)
    hub.send(toOwnerAndGm(char.id), (client) =>
      client.role === 'gm' ? parts + html(<ChangeLog session={session} oob />) : parts,
    )
  }

  const pushWholeSheet = (char: Character) => {
    const sheet = html(<Sheet rules={rules} char={char} scope={session.scope(char.id)} oob />)
    hub.send(toOwnerAndGm(char.id), (client) =>
      client.role === 'gm' ? sheet + html(<ChangeLog session={session} oob />) : sheet,
    )
  }

  // ---- helpers ------------------------------------------------------------
  const actorName = (c: Context) =>
    c.req.header('X-Actor') === 'gm'
      ? 'GM'
      : (session.characters.get(getCookie(c, CHAR_COOKIE) ?? '')?.name ?? 'Someone')

  const form = async (c: Context) => (await c.req.parseBody()) as Record<string, string>

  const noContent = (c: Context) => c.body(null, 204)

  // ---- pages --------------------------------------------------------------
  app.get('/', (c) => c.redirect('/play'))

  app.get('/play', (c) => {
    const charId = getCookie(c, CHAR_COOKIE)
    if (charId && session.characters.has(charId)) return c.html(<PlayerPage session={session} charId={charId} />)
    return c.html(<JoinPage session={session} />)
  })

  app.post('/join', async (c) => {
    const body = await form(c)
    let charId = body.charId
    if (!charId || !session.characters.has(charId)) {
      const char = session.createCharacter(body.name ?? '')
      charId = char.id
      hub.send(
        (client) => client.role === 'gm',
        () =>
          `<div hx-swap-oob="beforeend:#sheets">${html(
            <Sheet rules={rules} char={char} scope={session.scope(char.id)} />,
          )}</div>`,
      )
    }
    setCookie(c, CHAR_COOKIE, charId, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'Lax' })
    return c.redirect('/play', 303)
  })

  app.get('/leave', (c) => {
    deleteCookie(c, CHAR_COOKIE, { path: '/' })
    return c.redirect('/play')
  })

  app.get('/gm', (c) => c.html(<GmPage session={session} playerUrls={opts.playerUrls} qrSvg={opts.qrSvg} />))

  // ---- character actions --------------------------------------------------
  app.post('/c/:id/set', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const body = await form(c)
    const e = session.setField(char.id, body.field ?? '', body.value ?? '', actorName(c))
    if (e) pushFieldChange(char, e)
    return noContent(c)
  })

  app.post('/c/:id/adjust', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const body = await form(c)
    const e = session.adjustField(char.id, body.field ?? '', Number(body.delta), actorName(c))
    if (e) pushFieldChange(char, e)
    return noContent(c)
  })

  app.post('/c/:id/undo', (c) => {
    const charId = c.req.param('id')
    if (!session.characters.has(charId)) return c.notFound()
    // Undo rebuilds state, so fetch the character again afterwards.
    if (session.undoLast(charId, actorName(c))) pushWholeSheet(session.characters.get(charId)!)
    return noContent(c)
  })

  app.post('/c/:id/roll', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    const body = await form(c)
    const rollDef = rules.rolls.find((r) => r.id === body.roll)
    if (!char || !rollDef) return c.notFound()
    pushRoll(session.roll({ charId: char.id, label: rollDef.label, expr: rollDef.dice, visibility: 'public' }))
    return noContent(c)
  })

  app.post('/c/:id/roll-free', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const expr = (await form(c)).expr ?? ''
    try {
      pushRoll(session.roll({ charId: char.id, label: 'Free roll', expr, visibility: 'public' }))
      return c.text('')
    } catch (err) {
      if (err instanceof ExprError) return c.text(err.message)
      throw err
    }
  })

  app.post('/gm/roll', async (c) => {
    const body = await form(c)
    const visibility: Visibility = body.visibility === 'gm' || body.visibility === 'hidden' ? body.visibility : 'public'
    try {
      pushRoll(
        session.roll({ charId: null, label: body.label?.trim() || 'Roll', expr: body.expr ?? '', visibility }),
      )
      return c.text('')
    } catch (err) {
      if (err instanceof ExprError) return c.text(err.message)
      throw err
    }
  })

  // ---- live updates -------------------------------------------------------
  app.get(
    '/ws',
    upgradeWebSocket((c) => {
      const role = c.req.query('gm') === '1' ? 'gm' : 'player'
      const charId = c.req.query('char') ?? null
      return {
        onOpen: (_event, ws) => hub.add({ ws, role, charId }),
        onClose: (_event, ws) => hub.remove(ws),
      }
    }),
  )

  return app
}
