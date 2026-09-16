import { join } from 'node:path'
import { websocket } from 'hono/bun'
import QRCode from 'qrcode'
import { createApp } from './app'
import { lanAddresses } from './network'
import { loadRules } from './rules'
import { Session } from './session'

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
