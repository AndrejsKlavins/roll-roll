import { join } from 'node:path'
import { websocket } from 'hono/bun'
import QRCode from 'qrcode'
import { createApp } from './app'
import { hub } from './hub'
import { lanAddresses } from './network'
import { loadRules } from './rules'
import { ALIVE_EVERY_MS, Session } from './session'

const PORT = Number(process.env.PORT ?? 3000)
const root = join(import.meta.dir, '..')
process.chdir(root) // static paths below are relative to the project folder

let rules
try {
  rules = await loadRules()
} catch (err) {
  console.error(`\n${(err as Error).message}\n`)
  process.exit(1)
}

const session = new Session(rules, process.env.DB ?? join(root, 'data', 'session.db'))
// In-game clock auto-pause. A timestamp every few seconds covers a closed window, a crash or a
// sleeping laptop (the next start pauses the clock there); Ctrl+C / kill pauses it exactly.
// Kept on globalThis so `bun --hot` reloads swap in the new session instead of stacking timers.
const g = globalThis as typeof globalThis & { __alive?: Timer; __session?: Session }
g.__session = session
session.markAlive()
clearInterval(g.__alive)
g.__alive = setInterval(() => {
  // Woke from sleep with the clock running: it's now paused, so have every screen reload onto it.
  if (g.__session!.markAlive()) hub.closeAll()
}, ALIVE_EVERY_MS)
if (process.listenerCount('SIGINT') === 0) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      g.__session!.pauseClockAt()
      g.__session!.close()
      process.exit(0)
    })
  }
}

const playerUrls = lanAddresses().map((ip) => `http://${ip}:${PORT}`)
const qrSvg = playerUrls[0] ? await QRCode.toString(playerUrls[0], { type: 'svg', margin: 1 }) : ''

const app = createApp(session, { playerUrls, qrSvg })

console.log(`\n  ${rules.name} — ${session.characters.size} character(s), ${session.events.length} event(s)\n`)
if (playerUrls[0]) {
  console.log(await QRCode.toString(playerUrls[0], { type: 'terminal', small: true }))
  console.log(`  Players:  ${playerUrls.join('   ')}`)
} else {
  console.log('  No network address found — are you connected to Wi-Fi?')
}
console.log(`  GM:       http://localhost:${PORT}/gm\n`)

export default {
  port: PORT,
  hostname: '0.0.0.0',
  fetch: app.fetch,
  websocket,
}
