# The Letter Round

A [Scattergories](https://en.wikipedia.org/wiki/Scattergories)-style party game that runs entirely in the
browser. Players in different locations join one room, play the same 12 categories on a synced 3-minute
clock, and see everyone's answers when time's up. The game is a single static `index.html` with no build
step; a tiny Cloudflare Worker relays messages between the players in each room.

## How the multiplayer works

Each player keeps **one WebSocket** to their room on the relay server (`worker/`). The server knows exactly
who's connected and passes messages between them; it doesn't store or interpret game state. All of that stays
in the page, as before.

- The URL carries a 5-letter **room code**: `#room=<code>`. Everyone opening the same link joins the same room.
- Categories and the letter are derived **deterministically** from a per-round seed (seeded PRNG) that the
  host broadcasts, so every device builds the identical board.
- The countdown runs off an absolute start timestamp broadcast by the host, with a short lead-in so the
  letter is revealed to everyone at the same instant (relies on devices' clocks being roughly in sync, which
  they normally are via NTP).
- Every (re)connect triggers a full catch-up from whoever's in the room — round, scores, answers — so a
  refresh, screen lock or dropped connection heals itself.

Answers are kept in `localStorage` per device during the round and shared with the room only at time-up.

### Host

The player who created the room is the host (with automatic hand-off if they leave). Only the host starts
rounds; everyone else joins the synced board automatically.

## Playing

1. Open the site and press **Start a new game** — you're in the room lobby.
2. Set your name and send the **room link** to your friends. They land in the same lobby.
3. When everyone's in, the host presses **Start round**: the letter drops for all at once and the 3-minute
   clock begins.
4. At time-up, everyone's answers appear side by side with duplicates flagged. Tick the ones only you got
   (1 point each). The host can press **New round** to play again — the room link never changes.

## Connection status

The dot in the room pill is green when connected, amber while connecting or reconnecting, and red when it
has given up or been refused. Click the pill for who's here and a plain-language status line. Specifically:

- **Reconnecting** — the connection dropped; it retries with backoff and catches up automatically.
  A keepalive ping every 25s detects dead connections within ~10s, and coming back to the tab checks
  immediately.
- **Offline** — the server couldn't be reached at all; you can play solo while it keeps retrying.
- **Open in another tab** — the same player joined from another tab; **Use this tab** takes it back.
- **Room full** — rooms hold up to 16 players.

## The relay server (`worker/`)

A Cloudflare Worker with one Durable Object per room, using the WebSocket Hibernation API so an idle room
costs nothing. It's built to run on the **Workers Free** plan, which has hard daily limits rather than
overage billing — the worst case of heavy use is the game being unavailable until the daily reset, not a bill.

Abuse protection:

1. **Origin allowlist** — only pages served from `ALLOWED_ORIGINS` (in `wrangler.toml`) can connect.
2. **Turnstile** — the page gets a [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) token
   (usually invisible; if Cloudflare wants a click, a dialog asks for it) and exchanges it at `POST /session`
   for a signed ticket valid for 7 days. Every WebSocket connection must carry a valid ticket. Rotating
   `SESSION_SECRET` invalidates all tickets.
3. **Strict room codes and player ids** — anything else is rejected before a Durable Object is created.
4. **Rate limits** (in `wrangler.toml`) — 10 Turnstile checks a minute per IP; 30 room connections a minute
   per ticket and 100 per IP. Requests blocked here still count toward the free plan's daily request limit;
   only a WAF rule on a custom domain would stop them before the Worker runs.
5. **Per-room limits** — 16 players, 64 KB messages, and a per-connection message rate limit.

### Deploying

One-time setup, from `worker/`:

```sh
npm install
npx wrangler login                       # opens a browser
npx wrangler deploy                      # prints your https://letter-round.<subdomain>.workers.dev URL
```

Create a Turnstile widget in the Cloudflare dashboard (**Turnstile → Add widget**), with hostname
`azach.github.io` and widget mode **Managed**. Then store the secrets:

```sh
npx wrangler secret put TURNSTILE_SECRET   # the widget's secret key
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
```

Finally, in `index.html`, set `SERVER_URL` to the deployed Worker URL and `TURNSTILE_SITE_KEY` to the widget's
site key. Both are public values. Until they're set, the page shows "game server not configured".

### Local development

```sh
cd worker && cp .dev.vars.example .dev.vars && npm install && npm run dev   # Worker on :8787
python3 -m http.server 8000                                                 # from the repo root
```

Open `http://localhost:8000/`. On `localhost` the page automatically uses the local Worker and Cloudflare's
always-pass Turnstile test key. Use separate browser profiles (or a private window) to be more than one
player — tabs in the same profile share a player id, so a second tab replaces the first.

## Hosting on GitHub Pages

`index.html` is the entire app. With Pages enabled on the `main` branch (root), the game is live at:

```
https://azach.github.io/scattegories/
```

Hash-based routing and relative links mean it works correctly from that subpath with no config.
