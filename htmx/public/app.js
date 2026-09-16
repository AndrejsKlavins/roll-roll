// Client-side extras: sound effects, connection indicator, reconnect refresh.
// Loaded before Alpine, so the store is registered on alpine:init.

const storage = {
  get(key) {
    try { return localStorage.getItem(key) } catch { return null }
  },
  set(key, value) {
    try { localStorage.setItem(key, value) } catch {}
  },
}

// ---- Sound -----------------------------------------------------------------
// Synthesised with Web Audio, so there are no sound files to manage yet.
// Browsers only allow audio after a user gesture; the first tap unlocks it.
let audio = null
function audioContext() {
  if (!audio) audio = new AudioContext()
  if (audio.state === 'suspended') audio.resume()
  return audio
}
document.addEventListener('pointerdown', audioContext, { once: true })

function click(ctx, at, freq, volume) {
  const len = 0.03
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * len), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = freq
  const gain = ctx.createGain()
  gain.gain.value = volume
  src.connect(filter).connect(gain).connect(ctx.destination)
  src.start(at)
}

const sounds = {
  roll(ctx) {
    // A handful of decaying clicks ≈ dice tumbling on a table.
    let t = ctx.currentTime
    for (let i = 0; i < 7; i++) {
      click(ctx, t, 1800 + Math.random() * 2500, 0.9 - i * 0.1)
      t += 0.04 + Math.random() * 0.07 + i * 0.012
    }
  },
  secret(ctx) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.setValueAtTime(220, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.4)
    gain.gain.setValueAtTime(0.15, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.5)
  },
}

function playSound(name) {
  if (storage.get('muted') === '1' || !audio) return
  sounds[name]?.(audioContext())
}

document.addEventListener('alpine:init', () => {
  Alpine.store('sound', {
    muted: storage.get('muted') === '1',
    toggle() {
      this.muted = !this.muted
      storage.set('muted', this.muted ? '1' : '0')
      if (!this.muted) playSound('roll')
    },
  })
})

// Play a sound for feed entries that arrive after page load; keep the feed short.
document.addEventListener('DOMContentLoaded', () => {
  const feed = document.getElementById('feed')
  if (!feed) return
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLElement && node.dataset.sound) playSound(node.dataset.sound)
      }
    }
    while (feed.children.length > 60) feed.lastElementChild.remove()
  }).observe(feed, { childList: true })
})

// ---- Connection ------------------------------------------------------------
// Reloading while the laptop is unreachable would leave the browser's own
// "can't connect" page, where no script runs to recover. So wait for the
// server to answer first, showing a banner (body.offline) meanwhile.
let reloadPending = false
async function reloadWhenServerUp() {
  if (reloadPending) return
  reloadPending = true
  document.body.classList.add('offline')
  for (;;) {
    try {
      const res = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
      if (res.ok) return location.reload()
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

// If the socket dropped (phone slept, server restarted), reload on reconnect
// so the page catches up on anything missed while offline.
let wasDisconnected = false
document.addEventListener('htmx:wsOpen', () => {
  if (wasDisconnected) return reloadWhenServerUp()
  lastMessageAt = Date.now()
  document.getElementById('conn')?.classList.add('online')
})
document.addEventListener('htmx:wsClose', () => {
  wasDisconnected = true
  document.body.classList.add('offline')
  document.getElementById('conn')?.classList.remove('online')
})

// Phones (iOS Safari especially) can kill the socket while locked without
// firing a close event, leaving a page that looks connected but gets no updates.
// The server sends a heartbeat every 15s; if none arrived recently, the socket
// is presumed dead and the page reloads.
const STALE_AFTER_MS = 40_000
let lastMessageAt = Date.now()
document.addEventListener('htmx:wsAfterMessage', () => {
  lastMessageAt = Date.now()
})

function isTyping() {
  const el = document.activeElement
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.value !== '')
}

function checkConnection({ force = false } = {}) {
  if (!document.body.hasAttribute('ws-connect') || document.visibilityState !== 'visible') return
  if (Date.now() - lastMessageAt < STALE_AFTER_MS) return
  if (!force && isTyping()) return // don't throw away half-typed text; retry on next check
  reloadWhenServerUp()
}

// Unlock / tab switch back. Nothing is typed while the phone was locked, so force.
document.addEventListener('visibilitychange', () => checkConnection({ force: true }))
// Page restored from the back/forward cache: its socket is certainly gone.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) reloadWhenServerUp()
})
setInterval(checkConnection, 10_000)

// Exposed for debugging in the browser console.
window.rollTable = {
  checkConnection,
  get lastMessageAt() { return lastMessageAt },
  set lastMessageAt(v) { lastMessageAt = v },
}
