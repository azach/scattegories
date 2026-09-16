# The Letter Round

A [Scattergories](https://en.wikipedia.org/wiki/Scattergories)-style party game that runs entirely in the
browser. Players in different locations join one room, play the same 12 categories on a synced 3-minute
clock, and see everyone's answers when time's up — all **peer-to-peer, with no server you run** and no
build step. It's a single static `index.html`.

## How the multiplayer works

Players connect **browser-to-browser over WebRTC** using [Trystero](https://github.com/dmotz/trystero).
Game data (round setup, answers) flows directly between peers; the only third-party involvement is
Trystero's use of public infrastructure for the initial signalling handshake. There is no backend and no
account/API key.

- The URL carries a stable **room id**: `#room=<id>`. Everyone opening the same link joins the same room.
- Categories and the letter are derived **deterministically** from a per-round seed (seeded PRNG) that the
  host broadcasts, so every device builds the identical board.
- The 3-minute countdown runs off an absolute start timestamp broadcast by the host, with a short lead-in
  so the letter is revealed to everyone at the same instant (relies on devices' clocks being roughly in
  sync, which they normally are via NTP).
- Traffic is end-to-end encrypted with the room id as the key, so only people with the link can read it.

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

## Reliability & fallback

WebRTC connects across most networks via public STUN, but a small share of very strict NATs may fail
without a TURN relay (which would cost money / a server, and is intentionally not used here). If the
signalling network can't be reached at all, the app falls back to **offline solo play** on your own board.

## Hosting on GitHub Pages

`index.html` is the entire app. With Pages enabled on the `main` branch (root), the game is live at:

```
https://azach.github.io/scattegories/
```

Hash-based routing and relative links mean it works correctly from that subpath with no config. Trystero
is loaded at runtime from a CDN (esm.sh), so the page needs internet access to enable multiplayer.
