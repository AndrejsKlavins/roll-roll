// Connected devices and helpers to push HTML fragments to them over WebSocket.
import type { WSContext } from 'hono/ws'

export type Client = { ws: WSContext; role: 'player' | 'gm' | 'table'; charId: string | null }
/**
 * A GM's Bestiary tab. Kept apart from the board screens (`send` never reaches it) — it shows
 * none of their boards; `clientId` tells its tabs apart (see bestiary-routes).
 */
export type BestiaryClient = { ws: WSContext; clientId: string }

// Kept on globalThis so `bun --hot` reloads don't forget connected devices
// or start a second heartbeat.
const g = globalThis as typeof globalThis & { __clients?: Set<Client>; __heartbeat?: Timer }
const g2 = g as typeof g & { __bestiaryClients?: Set<BestiaryClient> }
const clients = (g.__clients ??= new Set<Client>())
const bestiaryClients = (g2.__bestiaryClients ??= new Set<BestiaryClient>())

function trySend(set: Set<{ ws: WSContext }>, c: { ws: WSContext }, html: string) {
  try {
    c.ws.send(html)
  } catch {
    set.delete(c)
  }
}

/** Clients reload when no message arrives for a while (see public/app.js), so ping regularly. */
export const HEARTBEAT_MS = 15_000

export const hub = {
  add(client: Client) {
    clients.add(client)
  },
  addBestiary(client: BestiaryClient) {
    bestiaryClients.add(client)
  },
  remove(ws: WSContext) {
    // Hono creates a fresh WSContext per event; the underlying Bun socket is stable.
    for (const c of clients) if (c.ws.raw === ws.raw) clients.delete(c)
    for (const c of bestiaryClients) if (c.ws.raw === ws.raw) bestiaryClients.delete(c)
  },
  /** To Bestiary tabs only (render once — they all see the same). */
  sendBestiary(filter: (c: BestiaryClient) => boolean, render: () => string) {
    let html: string | undefined
    for (const c of bestiaryClients) {
      if (!filter(c)) continue
      html ??= render()
      if (html) trySend(bestiaryClients, c, html)
    }
  },
  /** Render per client; empty strings are not sent. */
  send(filter: (c: Client) => boolean, render: (c: Client) => string) {
    for (const c of clients) {
      if (!filter(c)) continue
      const html = render(c)
      if (!html) continue
      try {
        c.ws.send(html)
      } catch {
        clients.delete(c)
      }
    }
  },
  count() {
    return clients.size
  },
  /**
   * Drops every connection. Each screen reconnects and reloads (public/app.js), which is how
   * everyone picks up a replaced event log without a special message.
   */
  closeAll() {
    for (const c of [...clients, ...bestiaryClients]) {
      try {
        // 1012 "service restart": the htmx ws extension only reconnects after an abnormal code
        // (1006/1012/1013) — a plain close would leave the page waiting.
        c.ws.close(1012, 'Game restored from a backup')
      } catch {
        // already gone
      }
    }
    clients.clear()
    bestiaryClients.clear()
  },
}

// Whitespace-only message: htmx swaps nothing, but the client notes it arrived.
clearInterval(g.__heartbeat)
g.__heartbeat = setInterval(() => {
  hub.send(() => true, () => ' ')
  hub.sendBestiary(() => true, () => ' ')
}, HEARTBEAT_MS)
