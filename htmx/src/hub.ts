// Connected devices and helpers to push HTML fragments to them over WebSocket.
import type { WSContext } from 'hono/ws'

export type Client = { ws: WSContext; role: 'player' | 'gm' | 'table'; charId: string | null }

// Kept on globalThis so `bun --hot` reloads don't forget connected devices
// or start a second heartbeat.
const g = globalThis as typeof globalThis & { __clients?: Set<Client>; __heartbeat?: Timer }
const clients = (g.__clients ??= new Set<Client>())

/** Clients reload when no message arrives for a while (see public/app.js), so ping regularly. */
export const HEARTBEAT_MS = 15_000

export const hub = {
  add(client: Client) {
    clients.add(client)
  },
  remove(ws: WSContext) {
    // Hono creates a fresh WSContext per event; the underlying Bun socket is stable.
    for (const c of clients) if (c.ws.raw === ws.raw) clients.delete(c)
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
    for (const c of clients) {
      try {
        // 1012 "service restart": the htmx ws extension only reconnects after an abnormal code
        // (1006/1012/1013) — a plain close would leave the page waiting.
        c.ws.close(1012, 'Game restored from a backup')
      } catch {
        // already gone
      }
    }
    clients.clear()
  },
}

// Whitespace-only message: htmx swaps nothing, but the client notes it arrived.
clearInterval(g.__heartbeat)
g.__heartbeat = setInterval(() => hub.send(() => true, () => ' '), HEARTBEAT_MS)
