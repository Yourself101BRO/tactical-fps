# Tactical FPS

Browser multiplayer tactical first-person shooter with Call of Duty (MW2019 / MWII) style movement,
for desktop and mobile. Dedicated authoritative Node server over WebSockets, with a peer-to-peer
fallback so friends can join with a room code.

Work in progress. Full run, share and deploy instructions land with the first playable build.

Requires Node 22.12+ (developed on Node 26). On this Mac Node lives in `/opt/homebrew/bin`.

```bash
npm install
npm run assets      # downloads the free, license-clean models/textures/sounds listed in scripts/asset-manifest.json
npm run dev         # Vite on http://localhost:5173 + game server on :8080
```
