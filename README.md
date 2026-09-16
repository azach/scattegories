# The Letter Round

A serverless [Scattergories](https://en.wikipedia.org/wiki/Scattergories)-style party game that runs
entirely in the browser. One shared link gives everyone the same 12 categories, the same letter, and a
synchronised 3-minute countdown — no backend, no build step, no dependencies.

## How the multiplayer works (with zero server)

The whole game state lives in the URL:

- `#g=<seed>` — the room seed. Categories and the letter are derived **deterministically** from this
  seed (seeded PRNG), so everyone opening the same link sees the identical board.
- `#g=<seed>&t=<goMs>` — added when someone presses **Start**. `t` is set to **30 seconds in the future**,
  giving a share window before the round begins. The letter stays hidden until `t`, so it's revealed to
  everyone at the same instant, and the 3-minute countdown is computed from this absolute timestamp — every
  open link shows the same time remaining (relies on devices' clocks being roughly in sync, which they
  normally are via NTP).

Answers are kept in `localStorage` on each player's own device. Scoring is done the classic way — read
answers aloud, tick the ones nobody else matched (1 point each).

## Playing

1. Open the site and press **Start a new game**.
2. Press **Start round** — this opens a 30-second window and copies the synced link.
3. Send the link to your friends. When the window ends, the letter drops for everyone at once and the
   3-minute clock starts.
4. When time's up, read answers aloud and tally your points.

## Hosting on GitHub Pages

`index.html` is the entire app. With Pages enabled on the `main` branch (root), the game is live at:

```
https://azach.github.io/scattegories/
```

Hash-based routing and relative share links mean it works correctly from that subpath with no config.
