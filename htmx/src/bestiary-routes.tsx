// Routes for the GM's Bestiary screen (/gm/bestiary). Every action answers with the whole screen
// for the tab that made it, and pushes the same to any other open Bestiary tab — each tab has its
// own client id (sent as X-Client and on its socket) so the sender isn't swapped twice, which
// would also steal the focus from the box the GM is typing in.
import type { Context, Hono } from 'hono'
import { hub } from './hub'
import type { Character, Session } from './session'
import { BestiaryMain, BestiaryPage } from './views/bestiary'
import { EncounterBoard } from './views/combat'

/**
 * The encounter changed: the table's encounter board (names and conditions), and every Bestiary
 * tab but the one that made the change (`sender`, which gets it as its response).
 */
export function pushEncounter(session: Session, sender?: string) {
  hub.send(
    (client) => client.role === 'table',
    () => String(<EncounterBoard session={session} oob />),
  )
  hub.sendBestiary(
    (client) => client.clientId !== sender,
    () => String(<BestiaryMain session={session} oob />),
  )
}

export function bestiaryRoutes(
  app: Hono,
  session: Session,
  actorName: (c: Context) => string,
  /** The app's own pushes: the challenge board (attacks and the history log) and a sheet's pools. */
  push: { challenge: () => void; stat: (char: Character) => void },
) {
  const form = async (c: Context) => (await c.req.parseBody()) as Record<string, string>

  /** The fresh screen for the sender; the same, out of band, for the table and other Bestiary tabs. */
  const screen = (c: Context) => {
    pushEncounter(session, c.req.header('X-Client'))
    return c.html(<BestiaryMain session={session} />)
  }

  app.get('/gm/bestiary', (c) =>
    c.html(<BestiaryPage session={session} clientId={crypto.randomUUID().slice(0, 8)} />),
  )

  // Templates: save (new, or an edit when the form carries an id), delete, reset to the rules file.
  app.post('/gm/bestiary/template', async (c) => {
    const body = await form(c)
    const { id, name, description, ...stats } = body
    session.saveEnemyTemplate({ id: id || undefined, name: name ?? '', description, stats }, actorName(c))
    return screen(c)
  })

  app.post('/gm/bestiary/template/:id/delete', (c) => {
    session.deleteEnemyTemplate(c.req.param('id'), actorName(c))
    return screen(c)
  })

  app.post('/gm/bestiary/template/:id/reset', (c) => {
    session.resetEnemyTemplate(c.req.param('id'), actorName(c))
    return screen(c)
  })

  app.post('/gm/bestiary/template/:id/spawn', async (c) => {
    const body = await form(c)
    session.spawnEnemies(c.req.param('id'), Number(body.count ?? 1), actorName(c))
    return screen(c)
  })

  // Encounter: remove one enemy (its id), the defeated ones, or all.
  app.post('/gm/bestiary/remove', async (c) => {
    const which = (await form(c)).which ?? ''
    session.removeEnemies(which === 'all' || which === 'defeated' ? which : [which], actorName(c))
    return screen(c)
  })

  // One field of one enemy, as its box posts it: { <field>: <value> }.
  app.post('/gm/enemy/:id/set', async (c) => {
    const body = await form(c)
    const [field, value] = Object.entries(body)[0] ?? []
    if (field !== undefined) session.updateEnemy(c.req.param('id'), field, String(value ?? ''), actorName(c))
    return screen(c)
  })

  app.post('/gm/bestiary/round', (c) => {
    session.nextCombatRound(actorName(c))
    return screen(c)
  })

  // An enemy attacks a player: settled at once, so the player's sheet and the table's log change too.
  app.post('/gm/enemy/:id/attack', async (c) => {
    const body = await form(c)
    const done = session.enemyAttack(c.req.param('id'), body.charId ?? '', body, actorName(c))
    if (done) {
      const char = session.characters.get(body.charId ?? '')
      if (char) push.stat(char)
      push.challenge()
    }
    return screen(c)
  })

  // A player attacks an enemy: the GM sets it up, and it becomes the current challenge.
  app.post('/gm/enemy/:id/attacked', async (c) => {
    const body = await form(c)
    const done = session.startAttack(
      {
        enemyId: c.req.param('id'),
        charId: body.charId ?? '',
        hitAbility: body.hitAbility ?? '',
        damageAbility: body.damageAbility ?? '',
        hitVs: body.hitVs,
        damageVs: body.damageVs,
        pool: body.pool,
        evasionSpent: body.spent === '1',
        description: body.description,
      },
      actorName(c),
    )
    if (done) push.challenge()
    return screen(c)
  })

  app.post('/gm/enemy/:id/pool', async (c) => {
    const body = await form(c)
    const pool = body.pool === 'mind' ? 'mind' : 'health'
    session.adjustEnemyPool(c.req.param('id'), pool, Number(body.delta), actorName(c))
    return screen(c)
  })
}
