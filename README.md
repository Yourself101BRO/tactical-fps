# Tactical FPS

A browser multiplayer tactical first-person shooter with Call of Duty (Modern Warfare 2019 / MWII) style movement: sprint, tactical sprint, slide and slide-cancel, mantle, mount, crouch, prone, ADS, recoil patterns, hitscan with server-side lag compensation. Desktop and phone (touch controls, landscape, installable). Free-for-All, Team Deathmatch and Search & Destroy, five weapons, frag and flash, perks, bots.

Two ways to play with friends:

- **Dedicated server** (recommended): a Node.js server you run and share through a free tunnel, or deploy to a free host. Authoritative simulation, client prediction, 20 Hz snapshots, lag-compensated hits.
- **Peer-to-peer**: if no server is reachable, one browser hosts the same simulation and friends join with a 4-letter room code over WebRTC.

## Quick start

Requires Node 22.12+ (built on Node 26). On this Mac Node is installed under `/opt/homebrew/bin`.

```bash
npm install
npm run assets      # downloads ~60 MB of free, license-clean models/textures/sounds (see CREDITS.md)
npm run build       # bundles the client into dist/
npm start           # serves the game on http://localhost:8090
```

Open http://localhost:8090, pick a name, and press **Practice** to play against bots, or **Host** to create a room your friends can join.

## Play with friends over the internet

```bash
npm run share
```

This builds, starts the server on port 8090 and opens a free Cloudflare quick tunnel; it prints a public `https://….trycloudflare.com` link. Send that link (or the room's **Copy Link**, which includes the code) to friends. The tunnel lives as long as the terminal is open.

Deploying instead (Railway, Render, Fly, or any Node host): build command `npm ci && npm run assets && npm run build`, start command `npm start`, and set `PORT` if the host assigns one.

## Development

```bash
npm run dev         # Vite dev server on :5173 with HMR + the game server on :8090
npm run check       # TypeScript, all three project configs
npm test            # unit tests (node:test)
```

The server runs TypeScript directly on Node's type stripping, so there is no server build step.

## Controls

| Action | Desktop | Phone |
|---|---|---|
| Move / sprint / tactical sprint | WASD / Shift / double-tap Shift | Left stick, push fully; double flick up |
| Look / aim | Mouse / right mouse (ADS) | Drag right side / ADS button |
| Fire | Left mouse | Fire buttons (either side) |
| Jump / mantle | Space | Jump |
| Crouch, slide (while sprinting), prone | C / C / Z | Crouch button (tap), hold for prone |
| Reload / swap | R / 1, 2, wheel | Reload / Swap |
| Frag / flash / melee | G / T / V | Buttons |
| Plant / defuse (S&D) | F | Interact prompt |
| Scoreboard / menu | Tab / Esc | Buttons |

Sensitivity, ADS multiplier, FOV, audio and touch layout are in Settings. iPhone: add the page to the Home Screen for full-screen play, and flip the side switch off silent to hear the game.

## Project layout

- `shared/` — the isomorphic simulation: constants and weapon tables, movement and weapon state machines, world, lag compensation, grenades, modes, bots, the binary protocol and the transport-agnostic `Room`. No DOM, no three.js, no clocks.
- `server/` — Node HTTP + WebSocket server: static files, room registry, 60 Hz loop per room.
- `client/` — three.js rendering (map, lighting, first-person weapon, animated characters, effects), input (keyboard/mouse, touch, gyro), audio (synthesized gunshots, sampled impacts/footsteps), networking (prediction, interpolation, WebSocket/PeerJS/local transports) and the DOM UI.
- `scripts/` — asset fetcher (pinned URLs, SHA-256 lock, generates `CREDITS.md`), dev runner, tunnel, share.
- `docs/DESIGN.md`, `docs/NETCODE.md`, `docs/CUSTOM_ASSETS.md`.

## Assets and credits

Every downloaded asset is listed in [CREDITS.md](CREDITS.md) with author, license and source. Most are CC0; the footstep pack is CC-BY 3.0 and is credited in-game as well. The map, effects, first-person weapon motion and gunshots are procedural.

Want photoreal soldiers or your own weapons? Drop them into `public/assets/custom/` — see `docs/CUSTOM_ASSETS.md`.

## License

MIT for the code (see `LICENSE`). Asset licenses are per `CREDITS.md`.
