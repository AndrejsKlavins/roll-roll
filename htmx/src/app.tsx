import { Hono, type Context } from 'hono'
import { serveStatic, upgradeWebSocket } from 'hono/bun'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Child } from 'hono/jsx'
import { ExprError } from './engine/expr'
import { characterToCsv, csvToSnapshot } from './backup'
import { bestiaryRoutes, pushEncounter } from './bestiary-routes'
import { hub } from './hub'
import type { Character, ChallengeStakes, RollEvent, Session, Visibility } from './session'
import { ChallengeBoard, ChallengePlayerPicker, GroupTaskBoard, OppositionBoard, SoloRollBoard } from './views/challenge'
import { ConsequenceResult } from './views/consequence'
import { ChangeLog, RollEntry, SessionMarker } from './views/feed'
import { CharacterRemoved, GmPage, JoinPage, PlayerPage, SessionLabel, TablePage, WhoLink } from './views/pages'
import {
  compactSummaries,
  DerivedUpdates,
  EquipmentList,
  FieldView,
  LevelRow,
  ManagePoints,
  Sheet,
  SheetHead,
  TrainBar,
  TraitsSection,
} from './views/sheet'

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
      // Compact sections' summary rows are on the player's own sheet only, so only they get them.
      client.role === 'gm' ? parts + html(<ChangeLog session={session} oob />) : parts + compactSummaries(session, char),
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

  bestiaryRoutes(app, session, actorName, { challenge: () => pushChallenge(), stat: (char) => pushStatChange(char) })

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
      // Compact sections' summary rows are on the player's own sheet only, so only they get them.
      client.role === 'gm' ? parts + html(<ChangeLog session={session} oob />) : parts + compactSummaries(session, char),
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
        : parts + compactSummaries(session, char), // the level shows in a compact summary
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
      // Compact sections' summary rows are on the player's own sheet only, so only they get them.
      client.role === 'gm' ? parts + html(<ChangeLog session={session} oob />) : parts + compactSummaries(session, char),
    )
  }

  /**
   * After an item is added, discarded or switched: the list itself, the rows its modifiers touch
   * (their values and "gear" notes), every calculated stat (abilities feed formulas), and the
   * challenge board — a skill bonus there counts equipment.
   */
  const pushItems = (char: Character, targets: string[]) => {
    const equip = rules.equipment
    const fields = [...new Set(targets)].flatMap((id) => {
      const f = rules.fields.get(id)
      return f ? [html(<FieldView session={session} char={char} field={f} oob />)] : []
    })
    const parts =
      (equip ? html(<EquipmentList session={session} char={char} item={equip.item} oob />) : '') +
      fields.join('') +
      html(<DerivedUpdates session={session} char={char} />)
    hub.send(toOwnerAndGm(char.id), (client) =>
      client.role === 'gm' ? parts + html(<ChangeLog session={session} oob />) : parts + compactSummaries(session, char),
    )
    pushChallenge()
  }

  const itemTargetsOf = (char: Character, itemId: string) =>
    char.items.find((it) => it.id === itemId)?.modifiers.map((m) => m.target) ?? []

  // Equipment: the player's own, or the GM's gift from the GM's copy of the sheet — the same
  // routes either way (the actor header names who did it).
  app.post('/c/:id/items/add', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const body = await form(c)
    let modifiers: unknown
    try {
      modifiers = JSON.parse(body.modifiers ?? '[]')
    } catch {
      return c.text('Bad modifiers', 400)
    }
    const itemId = session.addItem(char.id, body.name ?? '', modifiers as never, actorName(c))
    if (!itemId) return c.text('An item needs a name and at least one modifier', 400)
    pushItems(char, itemTargetsOf(char, itemId))
    return noContent(c)
  })

  app.post('/c/:id/items/:itemId/discard', (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const targets = itemTargetsOf(char, c.req.param('itemId')) // read before it is gone
    if (session.removeItem(char.id, c.req.param('itemId'), actorName(c))) pushItems(char, targets)
    return noContent(c)
  })

  app.post('/c/:id/items/:itemId/enabled', (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (!char) return c.notFound()
    const itemId = c.req.param('itemId')
    if (session.setItemEnabled(char.id, itemId, c.req.query('to') === '1', actorName(c))) {
      pushItems(char, itemTargetsOf(char, itemId))
    }
    return noContent(c)
  })

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
  const pushChallenge = () => {
    hub.send(
      () => true,
      (client) =>
        html(<ChallengeBoard session={session} role={client.role} viewerCharId={client.charId ?? undefined} oob />),
    )
    // While the current challenge is an attack, rolling it spends the enemy's Evasion and
    // finishing it wounds the enemy — the encounter screens follow.
    if (session.currentChallenge()?.attack) pushEncounter(session)
  }

  // The solo board is its own swap target, so a solo roll never disturbs the challenge board.
  // Players and the table are sent it too — SoloRollBoard renders an empty section for them while
  // the roll is private, which also clears a roll that has just been hidden again.
  const pushSolo = () =>
    hub.send(
      () => true,
      (client) => html(<SoloRollBoard session={session} role={client.role} oob />),
    )

  // Opposition rolls get their own swap target, like the solo board. Everyone is sent it: what
  // is hidden is only each side's commitment, and OppositionBoard decides that per viewer.
  const pushOpposition = () =>
    hub.send(
      () => true,
      (client) =>
        html(<OppositionBoard session={session} role={client.role} viewerCharId={client.charId ?? undefined} oob />),
    )

  app.post('/gm/opposition/start', async (c) => {
    const body = await form(c)
    const side = (p: 'a' | 'b') =>
      body[`${p}_kind`] === 'npc'
        ? {
            charId: null,
            name: body[`${p}_name`] ?? '',
            framingRank: Number(body[`${p}_framing_rank`]),
            resolutionRank: Number(body[`${p}_resolution_rank`]),
          }
        : {
            charId: body[`${p}_char`] ?? '',
            framingAbility: body[`${p}_framing`] ?? '',
            resolutionAbility: body[`${p}_resolution`] ?? '',
          }
    if (session.startOpposition({ description: body.description ?? '', a: side('a'), b: side('b') }, actorName(c))) {
      pushOpposition()
      pushChallenge() // the contest it replaces moves into the table's history log
    }
    return noContent(c)
  })

  const oppSide = (c: Context) => (c.req.query('side') === 'b' ? 'b' : 'a')

  // Ready and Roll are posted per side; the GM may act for either (an NPC has nobody else, and
  // the app has no permission system), so these are not tied to the acting character.
  app.post('/gm/opposition/done', (c) => {
    const opp = session.currentOpposition()
    if (!opp) return c.notFound()
    if (session.closeOpposition(opp.id, actorName(c))) pushOpposition()
    return noContent(c)
  })

  app.post('/gm/opposition/ready', (c) => {
    const opp = session.currentOpposition()
    if (!opp) return c.notFound()
    if (session.setOppositionReady(opp.id, oppSide(c), c.req.query('to') === '1', actorName(c))) pushOpposition()
    return noContent(c)
  })

  app.post('/gm/opposition/roll', (c) => {
    const opp = session.currentOpposition()
    if (!opp) return c.notFound()
    if (session.rollOpposition(opp.id, oppSide(c), actorName(c))) pushOpposition()
    return noContent(c)
  })

  // Commitment is the acting character's own, so these go through /c/:id like a sheet change.
  // Burning a pool point moves the sheet too, so push both.
  app.post('/c/:id/opposition/exert', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    const opp = session.currentOpposition()
    if (!char || !opp) return c.notFound()
    const check = c.req.query('check') === 'framing' ? 'framing' : 'resolution'
    if (session.commitOppositionExertion(opp.id, char.id, check, (await form(c)).stat ?? '', actorName(c))) {
      pushOpposition()
      pushStatChange(char)
    }
    return noContent(c)
  })

  app.post('/c/:id/opposition/skill', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    const opp = session.currentOpposition()
    if (!char || !opp) return c.notFound()
    if (session.setOppositionSkill(opp.id, char.id, (await form(c)).skill || null, actorName(c))) pushOpposition()
    return noContent(c)
  })

  app.post('/gm/solo/roll', async (c) => {
    const body = await form(c)
    const rolled = session.rollSolo(
      {
        description: body.description ?? '',
        difficulty: Number(body.difficulty),
        tier: body.tier || null,
        rank: Number(body.rank),
        visibility: body.visibility === 'public' ? 'public' : 'gm',
      },
      actorName(c),
    )
    // A public solo roll is also a line in the history log, which lives on the challenge board.
    if (rolled) {
      pushSolo()
      pushChallenge()
    }
    return noContent(c)
  })

  app.post('/gm/solo/visibility', (c) => {
    const to = c.req.query('to') === 'public' ? 'public' : 'gm'
    if (session.setSoloVisibility(c.req.query('id') ?? '', to, actorName(c))) {
      pushSolo()
      pushChallenge() // showing it adds its line to the history log; hiding it takes it out
    }
    return noContent(c)
  })

  app.post('/gm/challenge/start', async (c) => {
    const body = await form(c)
    const stakes: ChallengeStakes = body.stakes === 'low' || body.stakes === 'high' ? body.stakes : 'normal'
    const started = session.startChallenge(
      {
        description: body.description ?? '',
        framingAbility: body.framing_ability ?? '',
        resolutionAbility: body.resolution_ability ?? '',
        difficulty: Number(body.difficulty),
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

  // One press lands both checks at once (user decision), so there is one roll route.
  app.post('/c/:id/challenge/roll', (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch || ch.charId !== char.id) return c.notFound()
    if (session.rollChallenge(ch.id, actorName(c))) pushChallenge()
    return noContent(c)
  })

  // An attack's second step: the player is done with the hit and rolls the damage.
  app.post('/c/:id/challenge/roll-damage', (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch || ch.charId !== char.id) return c.notFound()
    if (session.rollDamage(ch.id, char.id, actorName(c))) pushChallenge()
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

  // Both checks are on the table at once, so exertion names the roll it goes on. A point put on
  // the framing re-reads the ladder and moves the resolution's target with it.
  app.post('/c/:id/challenge/spend-exertion', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch) return c.notFound()
    const roll = (await form(c)).roll === 'framing' ? 'framing' : 'resolution'
    if (session.spendExertion(ch.id, char.id, roll, actorName(c))) pushChallenge()
    return noContent(c)
  })

  // The player's choice for a point of exertion: "Reroll a die" (armed=1) or back out (armed=0).
  app.post('/c/:id/challenge/reroll-mode', (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch) return c.notFound()
    const armed = c.req.query('armed') === '1'
    if (session.setExertionReroll(ch.id, char.id, armed, actorName(c))) pushChallenge()
    return noContent(c)
  })

  app.post('/c/:id/challenge/reroll', (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch) return c.notFound()
    const roll = c.req.query('roll') === 'framing' ? 'framing' : 'resolution'
    if (session.rerollDie(ch.id, char.id, roll, Number(c.req.query('index')), actorName(c))) pushChallenge()
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

  // One route for every pick an activated effect asks for. `effect` names what it does: a tapped
  // die (discard / reroll / face / copy, on `roll`) or, for extra dice, the `roll` they join.
  // Match highest needs no pick and applies on Activate instead.
  app.post('/c/:id/challenge/approach-pick', (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch) return c.notFound()
    const index = Number(c.req.query('index'))
    // The tapped die may sit on either roll; anything but 'framing' is the resolution.
    const roll = c.req.query('roll') === 'framing' ? 'framing' : 'resolution'
    const by = actorName(c)
    const effect = c.req.query('effect')
    const done =
      effect === 'discard'
        ? session.discardDie(ch.id, char.id, index, by, roll)
        : effect === 'reroll'
          ? session.approachReroll(ch.id, char.id, index, by, roll)
          : effect === 'face'
            ? session.changeDieFace(ch.id, char.id, index, by, roll)
            : effect === 'copy'
              ? session.duplicateDie(ch.id, char.id, index, by, roll)
              : effect === 'dice' && session.addApproachDice(ch.id, char.id, roll, by)
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

  // GM circumstance modifier on the challenge's one difficulty: a plus raises it, a minus eases
  // it. Settable from the moment the challenge is started until it is closed.
  app.post('/gm/challenge/circumstance', (c) => {
    const ch = session.currentChallenge()
    if (!ch) return c.notFound()
    if (session.adjustCircumstance(ch.id, Number(c.req.query('delta')), actorName(c))) pushChallenge()
    return noContent(c)
  })

  // ---- group task -----------------------------------------------------------
  // Its own board (#group-board) on every screen; starting and closing one also redraws the
  // challenge board, whose history log lists finished group tasks.
  const pushGroup = (withLog = false) => {
    hub.send(
      () => true,
      (client) =>
        html(<GroupTaskBoard session={session} role={client.role} viewerCharId={client.charId ?? undefined} oob />),
    )
    if (withLog) pushChallenge()
  }

  app.post('/gm/group/start', async (c) => {
    const body = await form(c)
    const stakes: ChallengeStakes = body.stakes === 'low' || body.stakes === 'high' ? body.stakes : 'normal'
    const started = session.startGroupTask(
      {
        description: body.description ?? '',
        framingAbility: body.framing_ability || null,
        resolutionAbility: body.resolution_ability ?? '',
        difficulty: Number(body.difficulty),
        stakes,
        charIds: (body.char_ids ?? '').split(',').filter(Boolean),
      },
      actorName(c),
    )
    if (started) pushGroup(true)
    return started ? noContent(c) : c.text('Pick a difficulty, a resolution ability and at least one player', 400)
  })

  app.post('/gm/group/done', (c) => {
    const g = session.currentGroupTask()
    if (!g) return c.notFound()
    if (session.closeGroupTask(g.id, actorName(c))) pushGroup(true)
    return noContent(c)
  })

  /** The acting player's part of the current group task, or a 404. */
  const groupPart = (c: Context) => {
    const char = session.characters.get(c.req.param('id') ?? '')
    const ch = char ? session.groupMemberOf(char.id) : null
    return char && ch ? { char, ch } : null
  }

  app.post('/c/:id/group/setup', async (c) => {
    const part = groupPart(c)
    if (!part) return c.notFound()
    const skill = (await form(c)).skill || null
    if (session.setChallengePlayer(part.ch.id, part.char.id, null, skill, actorName(c))) pushGroup()
    return noContent(c)
  })

  app.post('/c/:id/group/roll', (c) => {
    const part = groupPart(c)
    if (!part) return c.notFound()
    if (session.rollChallenge(part.ch.id, actorName(c))) pushGroup()
    return noContent(c)
  })

  app.post('/c/:id/group/exert', async (c) => {
    const part = groupPart(c)
    if (!part) return c.notFound()
    if (session.exert(part.ch.id, part.char.id, (await form(c)).stat ?? '', actorName(c))) {
      pushGroup()
      pushStatChange(part.char)
    }
    return noContent(c)
  })

  app.post('/c/:id/group/spend-exertion', async (c) => {
    const part = groupPart(c)
    if (!part) return c.notFound()
    const roll = (await form(c)).roll === 'framing' ? 'framing' : 'resolution'
    if (session.spendExertion(part.ch.id, part.char.id, roll, actorName(c))) pushGroup()
    return noContent(c)
  })

  app.post('/c/:id/group/reroll-mode', (c) => {
    const part = groupPart(c)
    if (!part) return c.notFound()
    if (session.setExertionReroll(part.ch.id, part.char.id, c.req.query('armed') === '1', actorName(c))) pushGroup()
    return noContent(c)
  })

  app.post('/c/:id/group/reroll', (c) => {
    const part = groupPart(c)
    if (!part) return c.notFound()
    const roll = c.req.query('roll') === 'framing' ? 'framing' : 'resolution'
    if (session.rerollDie(part.ch.id, part.char.id, roll, Number(c.req.query('index')), actorName(c))) pushGroup()
    return noContent(c)
  })

  // Support: the GM lines up helping players; each helper rolls their one die from their screen.
  app.post('/gm/challenge/supporter/add', async (c) => {
    const ch = session.currentChallenge()
    if (!ch) return c.notFound()
    if (session.addSupporter(ch.id, (await form(c)).charId ?? '', actorName(c))) pushChallenge()
    return noContent(c)
  })

  app.post('/gm/challenge/supporter/remove', (c) => {
    const ch = session.currentChallenge()
    if (!ch) return c.notFound()
    if (session.removeSupporter(ch.id, c.req.query('char') ?? '', actorName(c))) pushChallenge()
    return noContent(c)
  })

  app.post('/c/:id/challenge/support', async (c) => {
    const char = session.characters.get(c.req.param('id'))
    const ch = session.currentChallenge()
    if (!char || !ch) return c.notFound()
    const body = await form(c)
    const roll = body.roll === 'framing' ? 'framing' : 'resolution'
    if (session.rollSupport(ch.id, char.id, roll, body.ability ?? '', actorName(c))) pushChallenge()
    return noContent(c)
  })

  // Hand edits on one roll of the current challenge, shared by the GM and the rolling player:
  // the "custom" ±1 and "Set die value". `charId` null is the GM; the session checks who may.
  const rollOf = (c: Context) => (c.req.query('roll') === 'framing' ? 'framing' : 'resolution')
  const customRoute = (c: Context, charId: string | null) => {
    const ch = session.currentChallenge()
    if (!ch) return c.notFound()
    if (session.adjustCustom(ch.id, charId, rollOf(c), Number(c.req.query('delta')), actorName(c))) pushChallenge()
    return noContent(c)
  }
  const setDieRoute = (c: Context, charId: string | null) => {
    const ch = session.currentChallenge()
    if (!ch) return c.notFound()
    const [index, face] = [Number(c.req.query('index')), Number(c.req.query('face'))]
    if (session.setDieFace(ch.id, charId, rollOf(c), index, face, actorName(c))) pushChallenge()
    return noContent(c)
  }
  app.post('/gm/challenge/custom', (c) => customRoute(c, null))
  app.post('/gm/challenge/set-die', (c) => setDieRoute(c, null))
  app.post('/c/:id/challenge/custom', (c) =>
    session.characters.has(c.req.param('id')) ? customRoute(c, c.req.param('id')) : c.notFound(),
  )
  app.post('/c/:id/challenge/set-die', (c) =>
    session.characters.has(c.req.param('id')) ? setDieRoute(c, c.req.param('id')) : c.notFound(),
  )

  app.post('/gm/challenge/done', (c) => {
    const ch = session.currentChallenge()
    if (!ch) return c.notFound()
    if (session.closeChallenge(ch.id, actorName(c))) pushChallenge()
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

  // Boons and complications: the GM's private roll on a table, answered into the dialog.
  app.post('/gm/consequence/roll', async (c) => {
    const body = await form(c)
    const kind = body.kind === 'complication' ? 'complication' : 'boon'
    const result = session.rollConsequence(kind, Number(body.rank))
    if (!result) return c.text('No such rank', 400)
    return c.html(<ConsequenceResult {...result} />)
  })

  // ---- backups ------------------------------------------------------------
  /** A file name made from a character or date: letters, digits and dashes only. */
  const fileName = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'backup'
  const download = (c: Context, name: string, type: string, body: string) =>
    c.body(body, 200, {
      'Content-Type': `${type}; charset=utf-8`,
      'Content-Disposition': `attachment; filename="${name}"`,
    })
  const uploadedText = async (c: Context) => {
    const file = (await c.req.parseBody())['file']
    return file instanceof File ? await file.text() : null
  }
  /** What an import reports under its form: plain text, escaped. */
  const status = (c: Context, text: string, ok: boolean) =>
    c.html(<span class={ok ? 'ok' : 'error'}>{text}</span>)

  app.get('/gm/character/:id/export', (c) => {
    const char = session.characters.get(c.req.param('id'))
    if (char?.status !== 'active') return c.notFound()
    // A BOM so Excel reads the file as UTF-8 (names and notes may not be plain ASCII).
    return download(c, `${fileName(char.name)}.csv`, 'text/csv', '\uFEFF' + characterToCsv(session, char))
  })

  app.post('/gm/character/import', async (c) => {
    const text = await uploadedText(c)
    if (text === null) return status(c, 'Pick a CSV file first.', false)
    const parsed = csvToSnapshot(session, text)
    if ('error' in parsed) return status(c, parsed.error, false)
    const char = session.importCharacter(parsed.snapshot, actorName(c))
    if (!char) return status(c, 'The backup has no usable name.', false)
    hub.send(
      (client) => client.role === 'gm',
      () =>
        `<div hx-swap-oob="beforeend:#sheets">${html(<Sheet session={session} char={char} gm />)}</div>` +
        html(<ChangeLog session={session} oob />),
    )
    pushChallengePlayers()
    const skipped = parsed.warnings.length
      ? ` ${parsed.warnings.length} line(s) left out: ${parsed.warnings.slice(0, 5).join('; ')}${parsed.warnings.length > 5 ? '; …' : ''}`
      : ''
    return status(c, `Imported ${char.name} as a new character.${skipped}`, true)
  })

  app.get('/gm/log/export', (c) => {
    const date = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
    return download(c, `${fileName(rules.name)}-log-${date}.jsonl`, 'application/x-ndjson', session.exportLog())
  })

  app.post('/gm/log/import', async (c) => {
    const text = await uploadedText(c)
    if (text === null) return status(c, 'Pick a log file first.', false)
    const result = session.importLog(text)
    if (!result.ok) return status(c, result.error, false)
    // Every screen reconnects and reloads onto the restored game — after this answer is out.
    setTimeout(() => hub.closeAll(), 300)
    return status(c, `Restored ${result.events} events. Screens are reloading…`, true)
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
      const bestiary = c.req.query('bestiary')
      const role = c.req.query('gm') === '1' ? 'gm' : c.req.query('table') === '1' ? 'table' : 'player'
      const charId = c.req.query('char') ?? null
      return {
        onOpen: (_event, ws) => (bestiary ? hub.addBestiary({ ws, clientId: bestiary }) : hub.add({ ws, role, charId })),
        onClose: (_event, ws) => hub.remove(ws),
      }
    }),
  )

  return app
}
