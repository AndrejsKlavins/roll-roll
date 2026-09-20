import type { Child } from 'hono/jsx'

export function Layout(props: {
  title: string
  system: string
  who?: Child
  wsUrl?: string
  gm?: boolean
  children: Child
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        {/* Cache-busted: static/no-cache-header assets otherwise stick in the browser cache
            across edits, so a CSS fix can look like it "didn't take" without a hard refresh. */}
        <link rel="stylesheet" href={`/public/style.css?v=${Date.now()}`} />
        <script src="/vendor/htmx.min.js"></script>
        <script src="/vendor/ws.min.js"></script>
        <script src="/public/app.js" defer></script>
        <script src="/vendor/alpine.min.js" defer></script>
      </head>
      <body
        class={props.gm ? 'gm' : 'player'}
        hx-ext={props.wsUrl ? 'ws' : undefined}
        ws-connect={props.wsUrl}
        hx-headers={props.gm ? JSON.stringify({ 'X-Actor': 'gm' }) : undefined}
      >
        <header class="topbar">
          <strong>{props.system}</strong>
          <span class="who">{props.who}</span>
          <span id="conn" class="conn" title="Connection"></span>
          <button
            type="button"
            class="icon"
            x-data
            x-on:click="$store.sound.toggle()"
            x-text="$store.sound.muted ? '🔇' : '🔊'"
            title="Sound on/off"
          >
            🔊
          </button>
        </header>
        {props.children}
      </body>
    </html>
  )
}
