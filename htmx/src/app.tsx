import { Hono, type Context } from 'hono'
import { serveStatic, upgradeWebSocket } from 'hono/bun'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Child } from 'hono/jsx'
import { ExprError } from './engine/expr'
import { hub } from './hub'
import type { Character, ChallengeStakes, RollEvent, Session, Visibility } from './session'
import { ChallengeBoard, ChallengePlayerPicker } from './views/challenge'
import { ChangeLog, RollEntry, SessionMarker } from './views/feed'
import { CharacterRemoved, GmPage, JoinPage, PlayerPage, SessionLabel, TablePage, WhoLink } from './views/pages'
import { DerivedUpdates, FieldView, LevelRow, ManagePoints, Sheet, SheetHead, TrainBar, TraitsSection } from './views/sheet'

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
  app.use('/system/icons/*', serveStatic({ root: './' })) // PNG/WebP icons (SVGs are inlined)

  // ---- push helpers -------------------------------------------------------
  // The table screen has no #feed (its own challenge log covers it) — skip it here.
  const pushRoll = (roll: RollEvent) =>
    hub.send(
      (client) => client.role !== 'table',
      (client) => {
        const entry = RollEntry({ roll, viewer: client.role as 'player' | 'gm' })
        return entry ? `<div hx-swap-oob="afterbegin:#feed">${html(entry)}</div>` : ''
      },
    )

  const toOwnerAndGm = (charId: string) => (client: { role: string; charId: string | null }) =>
    client.role === 'gm' || client.charId === charId

  const pushFieldChange = (char: Character, fieldId: string) => {
    const field = rules.fields.get(fieldId)!
    const parts =
      html(<FieldView session={session} char={char} field={field} oob />) +
      html(<DerivedUpdates session={session} char={char} />)
    hub.send(toOwnerAndGm(char.id), (client) =>
      client.role === 'gm' ? parts + html(<ChangeLog session={session} oob />) : parts,
    )
  }

  const pushWholeSheet = (char: Character) =>
    hub.send(toOwnerAndGm(char.id), (client) =>
      client.role === 'gm'
        ? html(<Sheet session={session} char={char} gm oob />) + html(<ChangeLog session={session} oob />)
        : html(<Sheet session={session} char={char} oob />),
    )

  /** Keeps the (long-lived) challenge setup dialog's player list in step with the cast. */
  const pushChallengePlayers = () =>
    hub.send(
      (client) => client.role === 'gm',
      () => html(<ChallengePlayerPicker session={session} oob />),
    )

  const pushChangeLogToGm = () =>
    hub.send((client) => client.role === 'gm', () => html(<ChangeLog session={session} oob />))

  // ---- helpers ------------------------------------------------------------
  const actorName = (c: Context) =>
    c.req.header('X-Actor') === 'gm'
      ? 'GM'
      : (session.characters.get(getCookie(c, CHAR_COOKIE) ?? '')?.name ?? 'Someone')

  const form = async (c: Context) => (await c.req.parseBody()) as Record<string, string>

  const noContent = (c: Context) => c.body(null, 204)

  // ---- pages --------------------------------------------------------------
  app.get('/', (c) => c.redirect('/play'))

  // Clients check this before reloading so they never reload into a "can't connect" page.
  app.get('/health', (c) => c.body(null, 204))

  app.get('/play', (c) => {
    const charId = getCookie(c, CHAR_COOKIE)
    if (charId && session.characters.has(charId)) return c.html(<PlayerPage session={session} charId={charId} />)
    return c.html(<JoinPage session={session} />)
  })

  app.post('/join', async (c) => {
    const body = await form(c)
    let charId = body.charId
    // Stale join page listing a character that has since been deleted.
    if (charId && !session.characters.has(charId)) return c.redirect('/play', 303)
    if (!charId) {
      const char = session.createCharacter(body.name ?? '')
      charId = char.id
      hub.send(
        (client) => client.role === 'gm',
        () =>
          `<div hx-swap-oob="beforeend:#sheets">${html(
            <Sheet session={session} char={char} gm />,
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

  app.get('/table', (c) => c.html(<TablePage session={session} />))

  // ---- character actions --------------------------------------------------
  app.post('/c/:id/set', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const body = await form(c)
    const field = body.field ?? ''
    if (session.setField(char.id, field, body.value ?? '', actorName(c))) pushFieldChange(char, field)
    return noContent(c)
  })

  app.post('/c/:id/adjust', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const body = await form(c)
    const field = body.field ?? ''
    if (session.adjustField(char.id, field, Number(body.delta), actorName(c))) pushFieldChange(char, field)
    return noContent(c)
  })

  app.post('/c/:id/adjust-base', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const body = await form(c)
    const field = body.field ?? ''
    if (session.adjustBase(char.id, field, Number(body.delta), actorName(c))) pushFieldChange(char, field)
    return noContent(c)
  })

  const pushStatChange = (char: Character) => {
    const parts = html(<DerivedUpdates session={session} char={char} />)
    hub.send(toOwnerAndGm(char.id), (client) =>
      client.role === 'gm' ? parts + html(<ChangeLog session={session} oob />) : parts,
    )
  }

  app.post('/c/:id/adjust-stat', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const body = await form(c)
    if (session.adjustStat(char.id, body.stat ?? '', Number(body.delta), actorName(c))) pushStatChange(char)
    return noContent(c)
  })

  app.post('/c/:id/set-stat', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const body = await form(c)
    if (session.setStat(char.id, body.stat ?? '', Number(body.value), actorName(c))) pushStatChange(char)
    return noContent(c)
  })

  /**
   * After training, a level up or a grant: every trained row (their + buttons depend on points
   * available), the points bar, the level row, stats (skills may feed formulas) and GM info.
   */
  const pushTraining = (char: Character) => {
    const trained = [...rules.fields.values()].filter((f) => f.type === 'number' && f.trained)
    const parts =
      trained.map((f) => html(<FieldView session={session} char={char} field={f} oob />)).join('') +
      html(<TrainBar session={session} char={char} oob />) +
      (rules.level ? html(<LevelRow session={session} char={char} item={rules.level} oob />) : '') +
      html(<DerivedUpdates session={session} char={char} />)
    hub.send(toOwnerAndGm(char.id), (client) =>
      client.role === 'gm'
        ? parts + html(<ManagePoints session={session} char={char} oob />) + html(<ChangeLog session={session} oob />)
        : parts,
    )
  }

  app.post('/c/:id/train', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const body = await form(c)
    const skill = body.skill ?? ''
    if (session.train(char.id, skill, Number(body.delta), actorName(c))) pushTraining(char)
    return noContent(c)
  })

  app.post('/c/:id/level-up', (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    if (session.levelUp(char.id, actorName(c))) pushTraining(char)
    return noContent(c)
  })

  app.post('/c/:id/grant-points', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    if (session.grantPoints(char.id, Number((await form(c)).amount), actorName(c))) pushTraining(char)
    return noContent(c)
  })

  /** fieldIds: the trait's modifier targets, so their steppers refresh along with derived stats. */
  const pushTraits = (char: Character, fieldIds: string[]) => {
    const parts =
      fieldIds.map((id) => html(<FieldView session={session} char={char} field={rules.fields.get(id)!} oob />)).join('') +
      html(<TraitsSection session={session} char={char} oob />) +
      html(<DerivedUpdates session={session} char={char} />)
    hub.send(toOwnerAndGm(char.id), (client) =>
      client.role === 'gm' ? parts + html(<ChangeLog session={session} oob />) : parts,
    )
  }

  // Fields (not derived stats — those refresh via the unconditional DerivedUpdates in pushTraits).
  const traitFieldIds = (t: (typeof rules.traits)[number]) =>
    t.modifiers.flatMap((m) => (m.kind === 'stat_bonus' ? [] : [m.field]))

  app.post('/c/:id/trait/add', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const body = await form(c)
    const trait = rules.traits.find((t) => t.id === body.trait)
    if (trait && session.addTrait(char.id, trait.id, actorName(c))) pushTraits(char, traitFieldIds(trait))
    return noContent(c)
  })

  app.post('/c/:id/trait/remove', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const body = await form(c)
    const trait = rules.traits.find((t) => t.id === body.trait)
    if (trait && session.removeTrait(char.id, trait.id, actorName(c))) pushTraits(char, traitFieldIds(trait))
    return noContent(c)
  })

  app.post('/gm/power-level', async (c) => {
    const body = await form(c)
    if (session.setPowerLevel(Number(body.value), actorName(c))) {
      hub.send(
        (client) => client.role === 'gm',
        () => `<b id="power-level-value" hx-swap-oob="true">${session.powerLevel}</b>`,
      )
      for (const char of session.characters.values()) pushTraits(char, [])
    }
    return noContent(c)
  })

  // ---- challenges (public table screen) ------------------------------------
  // Every action re-renders the whole board, per role, to gm + player + table clients.
  const pushChallenge = () =>
    hub.send(
      () => true,
      (client) =>
        html(<ChallengeBoard session={session} role={client.role} viewerCharId={client.charId ?? undefined} oob />),
    )

  app.post('/gm/challenge/start', async (c) => {
    const body = await form(c)
    const stakes: ChallengeStakes = body.stakes === 'low' || body.stakes === 'high' ? body.stakes : 'normal'
    const started = session.startChallenge(
      {
        description: body.description ?? '',
        mainAbility: body.main_ability ?? '',
        supportAbility: body.support_ability ?? '',
        mainDifficulty: Number(body.main_difficulty),
        supportDifficulty: Number(body.support_difficulty),
        stakes,
      },
      actorName(c),
    )
    if (!started) return noContent(c)
    // The GM picks who rolls as part of setup; players no longer join a challenge themselves.
    const ch = session.currentChallenge()
    if (ch && body.char_id) session.setChallengePlayer(ch.id, body.char_id, null, null, actorName(c))
    pushChallenge()
    return noContent(c)
  })

  app.post('/c/:id/challenge/setup', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch || ch.charId !== char.id) return c.notFound()
    const body = await form(c)
    const approach = body.approach || ch.approach
    const skill = 'skill' in body ? body.skill || null : ch.skill
    if (session.setChallengePlayer(ch.id, char.id, approach, skill, actorName(c))) pushChallenge()
    return noContent(c)
  })

  app.post('/c/:id/challenge/roll', (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch || ch.charId !== char.id) return c.notFound()
    if (session.rollChallenge(ch.id, actorName(c))) pushChallenge()
    return noContent(c)
  })

  // Exertion: burning a pool point changes the sheet too, so push both.
  app.post('/c/:id/challenge/exert', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch) return c.notFound()
    if (session.exert(ch.id, char.id, (await form(c)).stat ?? '', actorName(c))) {
      pushChallenge()
      pushStatChange(char)
    }
    return noContent(c)
  })

  app.post('/c/:id/challenge/spend-exertion', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch) return c.notFound()
    const side = (await form(c)).side === 'support' ? 'support' : 'main'
    if (session.spendExertion(ch.id, char.id, side, actorName(c))) pushChallenge()
    return noContent(c)
  })

  app.post('/c/:id/challenge/reroll', (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch) return c.notFound()
    const side = c.req.query('side') === 'support' ? 'support' : 'main'
    if (session.rerollDie(ch.id, char.id, side, Number(c.req.query('index')), actorName(c))) pushChallenge()
    return noContent(c)
  })

  // Approach die: Activate applies the face's effect. Ones that need a target (discard a die,
  // reroll it, add dice to an ability) leave the challenge pending until the player picks below.
  app.post('/c/:id/challenge/activate-approach', (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch) return c.notFound()
    if (session.activateApproach(ch.id, char.id, actorName(c))) pushChallenge()
    return noContent(c)
  })

  // One route for every pick an activated effect asks for. `effect` names what the tap does:
  // a die (discard / reroll / face / copy) or an ability (match, or none at all = extra dice).
  app.post('/c/:id/challenge/approach-pick', (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch) return c.notFound()
    const side = c.req.query('side') === 'support' ? 'support' : 'main'
    const index = Number(c.req.query('index'))
    const by = actorName(c)
    const effect = c.req.query('effect')
    const done =
      effect === 'discard'
        ? session.discardDie(ch.id, char.id, side, index, by)
        : effect === 'reroll'
          ? session.approachReroll(ch.id, char.id, side, index, by)
          : effect === 'face'
            ? session.changeDieFace(ch.id, char.id, side, index, by)
            : effect === 'copy'
              ? session.duplicateDie(ch.id, char.id, side, index, by)
              : effect === 'match'
                ? session.matchHighestDie(ch.id, char.id, side, by)
                : session.addApproachDice(ch.id, char.id, side, by)
    if (done) pushChallenge()
    return noContent(c)
  })

  // GM debug tool: force the approach die onto a face so its effect can be tried on demand.
  app.post('/gm/challenge/approach-die', (c) => {
    const ch = session.currentChallenge()
    if (!ch) return c.notFound()
    if (session.setApproachDie(ch.id, Number(c.req.query('face')), actorName(c))) pushChallenge()
    return noContent(c)
  })

  app.post('/gm/challenge/done', (c) => {
    const ch = session.currentChallenge()
    if (!ch) return c.notFound()
    if (session.closeChallenge(ch.id, actorName(c))) pushChallenge()
    return noContent(c)
  })

  app.post('/c/:id/challenge/skill-points', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch || ch.charId !== char.id) return c.notFound()
    const body = await form(c)
    if (session.setChallengeSkillPoints(ch.id, Number(body.main), Number(body.support), actorName(c))) pushChallenge()
    return noContent(c)
  })

  app.post('/c/:id/finalize', (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    if (session.finalizeCharacter(char.id, actorName(c))) {
      pushWholeSheet(char)
      pushChallengePlayers() // a finished character can now be put on a challenge
    }
    return noContent(c)
  })

  app.post('/c/:id/rename', async (c) => {
    const charId = c.req.param('id')
    const e = session.renameCharacter(charId, (await form(c)).name ?? '', actorName(c))
    const char = session.characters.get(charId)
    if (!e || !char) return noContent(c)
    hub.send(toOwnerAndGm(charId), (client) =>
      client.role === 'gm'
        ? html(<SheetHead session={session} char={char} oob />) + html(<ChangeLog session={session} oob />)
        : html(<SheetHead session={session} char={char} oob />) + html(<WhoLink char={char} oob />),
    )
    return noContent(c)
  })

  app.post('/c/:id/delete', (c) => {
    const charId = c.req.param('id')
    if (!session.deleteCharacter(charId, actorName(c))) return noContent(c)
    hub.send(toOwnerAndGm(charId), (client) =>
      client.role === 'gm'
        ? `<section id="sheet-${charId}" hx-swap-oob="delete"></section>` + html(<ChangeLog session={session} oob />)
        : html(<CharacterRemoved />),
    )
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

  app.post('/gm/session', (c) => {
    session.startSession('GM')
    const marker = html(<SessionMarker session={session} />)
    hub.send(
      () => true,
      (client) =>
        `<div hx-swap-oob="innerHTML:#feed">${marker}</div>` +
        (client.role === 'gm' ? html(<SessionLabel session={session} oob />) : ''),
    )
    pushChangeLogToGm()
    return noContent(c)
  })

  // ---- live updates -------------------------------------------------------
  app.get(
    '/ws',
    upgradeWebSocket((c) => {
      const role = c.req.query('gm') === '1' ? 'gm' : c.req.query('table') === '1' ? 'table' : 'player'
      const charId = c.req.query('char') ?? null
      return {
        onOpen: (_event, ws) => hub.add({ ws, role, charId }),
        onClose: (_event, ws) => hub.remove(ws),
      }
    }),
  )

  return app
}
