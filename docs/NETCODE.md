# Netcode

How the authoritative simulation, prediction, interpolation, lag compensation and the two transports fit together. Message layouts are implemented in `shared/protocol.ts`; the client side lives in `client/net/`.

## 2. Architecture

```
browser client ──WebSocket──▶ Node server (Room per code) ──▶ shared/sim (World)
browser client ──WebRTC/PeerJS──▶ browser host: same Room class, main thread ──▶ shared/sim
solo client ───LocalTransport (in-process)──▶ Room with bots (practice)
every client runs shared movement + weapon stepping for its own player (prediction)
```

- `shared/` is pure TypeScript: no DOM, no three.js, no `Date.now()`. Math, movement, weapon state, world sim, map data, protocol, modes, bots, and `Room` (transport-agnostic match host).
- `server/` wraps `Room` with `ws`. `client/net/peer-host.ts` wraps the same `Room` with PeerJS. `client/net/local-host.ts` wraps it with an in-process transport.
- **No Web Worker in v1.** `RTCPeerConnection` is not exposed in dedicated workers in any shipping browser, so a worker-hosted Room could not own its peer connections; a postMessage bridge would add a second protocol layer for marginal gain at 12 players. The browser host runs `Room` on the main thread with a drift-corrected accumulator, and the README recommends the dedicated-server path for best quality.
- Fixed tick 60 Hz everywhere; `dt` is exactly `TICK_DT`.

---

## 3. Networking design

**Rates.** Sim 60 Hz (`TICK_DT = 1/60`). Snapshots 20 Hz (every 3rd tick). `INPUT_SEND_HZ = 60`: inputs are sampled and sent on a fixed 60 Hz cadence **decoupled from the render frame rate** (a 240 Hz monitor must not send 240 msg/s), each message carrying the newest command plus the previous 2 for redundancy. Ping every 1 s.

**Transport** (`shared/net/transport.ts`):
```ts
export interface Transport { send(data: Uint8Array): void; close(): void; onMessage: (data: Uint8Array) => void; onClose: () => void; readonly id: number; }
```
`WsTransport` (server), `PeerTransport` (browser host), `LocalTransport` (in-process pair with optional simulated latency/jitter/loss for tests).

**Message catalogue** (`shared/protocol.ts`; first byte = id, little-endian `DataView`, no JSON on the hot path):

| Id | Dir | Fields |
|---|---|---|
| 1 HELLO | C→S | protocolVersion u8, name (u8 len + utf8 ≤16), roomCode 4 ascii, mode u8, wantBots u8, rejoinId u8 (0 = new) |
| 2 WELCOME | S→C | playerId u8, serverTick u32, roomCode 4 ascii, mode u8, mapId u8, teamId u8, **state u8** (0 alive, 1 waiting-for-round, 2 spectating) |
| 3 INPUT | C→S | count u8, then per cmd: seq u32, tick u32, moveX i8, moveY i8, yaw u16, pitch i16, buttons u16, weaponSlot u8 |
| 4 SNAPSHOT | S→C | serverTick u32, lastAckSeq u32, phase u8, timeLeft u16, scores i16×2, playerCount u8, per player 30 B (id u8, flags u16, pos f32×3, vel i16×3, yaw u16, pitch i16, health u8, weapon u8, ammo u16, animId u8); projectiles; events |
| 5 PING / 6 PONG | both | clientTimeMs u32 (+ serverTick u32) |
| 7 LOADOUT | C→S | primary u8, secondary u8, lethal u8, tactical u8, **perk1 u8, perk2 u8** |
| 8 ROOM_STATE | S→C | phase, mode, round, roundsWon u8×2, players (id, team, name, kills, deaths, score, ping, isBot, **state u8**), bombState, bombSite, bombTimer |
| 9 MATCH_END | S→C | winnerTeam u8, per-player stats |
| 10 CHAT | both | text ≤64, lobby only |

Events in SNAPSHOT: FIRE, HIT, KILL, IMPACT, EXPLODE, FLASHED, PLANT, DEFUSE, ROUND, RESPAWN. At 12 players a snapshot is 12×30 + ~20 header + ~100 events ≈ 500 B, so ~10 KB/s per client.

**Ordering is not guaranteed on either path.** Verified in the PeerJS source: `reliable` maps only to `RTCDataChannelInit.ordered` (`ordered: !!reliable`), never to `maxRetransmits`, so the game channel is **unordered but still reliable** — stale frames arrive late rather than being dropped. Therefore, as hard rules: `EntityBuffer.push(tick, state)` rejects any tick ≤ the newest already buffered, and `World.applyInput` rejects any `cmd.seq ≤ lastAppliedSeq` for that player. `'raw'` serialization passes `Uint8Array` through untouched.

**Client prediction and reconciliation** (`client/net/prediction.ts`):
1. Each 60 Hz sample: build `InputCmd`, run `stepPlayer(...)` **and `stepWeapon(...)` from `shared/sim/weaponstate.ts`** locally, store `{cmd, resultState}` in a 256-entry ring.
2. On snapshot: adopt the authoritative local state, drop acked commands, replay the rest through the same two functions. Error < 0.02 m keeps the prediction; < 1.5 m applies a smoothed 10 Hz correction to the render offset only; ≥ 1.5 m snaps. Yaw/pitch are never corrected.
3. Predicted immediately: muzzle flash, fire sound, ammo decrement, fire-rate cooldown, reload timer, viewmodel kick. Server-confirmed only: hitmarkers, damage, kills.

**Interpolation** (`client/net/interpolation.ts`): render remote players at `renderTick = localEstServerTick − INTERP_TICKS` (6 ticks = 100 ms), 8-state buffer, extrapolate up to 150 ms then hold. **Stall handling for the WebSocket path:** TCP head-of-line blocking with a ≥200 ms retransmission timeout can exceed that window, so if no snapshot arrives for 250 ms, freeze extrapolation, show a lag indicator, and snap rather than smooth on resume.

**Lag compensation** (`shared/sim/lagcomp.ts`): 60 ticks of hit volumes per player (head sphere r 0.12, torso capsule, legs capsule, stance-adjusted). `rewindTick = clamp(cmd.tick − INTERP_TICKS, now−60, now)`. Bots bypass this: `BotBrain.think` stamps `cmd.tick = world.tick + INTERP_TICKS` so the formula collapses to `now` (bots have no network delay to compensate).

**Clock sync**: keep a free-running float `localEstServerTick`, advanced every frame by `realDtMs / (1000 * TICK_DT)` and used to stamp every `cmd.tick`. On each snapshot, compute the target `lastSnapshotTick + (RTT/2)/TICK_DT + 1` (RTT = EMA α 0.1, floored by the min of the last 5 samples) and slew toward it by at most 1 tick per 100 ms. Never recompute-and-jump on snapshot arrival.

**Anti-cheat**: server ignores client positions and client-reported hits; clamps move axes and button bits; validates weapon ids and fire rate; caps input messages at `MAX_INPUT_MSGS_PER_SEC = 75` (headroom over the 60 Hz cadence, independent of cmds per message); rate-limits chat.

**Backgrounding and reconnect** (this is the single most likely real-world failure on phones): iOS Safari closes WebSockets and tears down `RTCPeerConnection` when the tab hides or the screen locks, and throttles timers after ~5 min. So: a `visibilitychange` handler pauses the loop and shows "Reconnecting…"; on `visible`, `ClientNet.reconnect()` reopens the socket and re-sends HELLO with `rejoinId`, and the peer path calls `peer.reconnect()` plus a fresh `connectPeer`. `Room` holds a disconnected player's slot and `PlayerState` for a 20 s grace window. If reconnect fails within 10 s, return to the menu.

**Lobby flow**: Menu → name → Host (server, or P2P if unreachable) / Join CODE / Practice → lobby (teams, mode, bots, loadout) → Start → WARMUP 10 s → LIVE → END 15 s → lobby. FFA/TDM spawn late joiners immediately; S&D puts them in `state = 1` (waiting for next round) with a spectate camera. `Predictor.local` is therefore `PlayerState | null`, and the match loop renders a spectate overlay when it is null.

**P2P fallback**: host PeerJS id `tfps-<CODE>`; joiners open a `{reliable: false, serialization: 'raw'}` channel for inputs/snapshots and a `{reliable: true, serialization: 'raw'}` channel for HELLO/LOADOUT/ROOM_STATE. Host leaving ends the match (no host migration in v1). Google public STUN, no TURN: symmetric NATs fail, and after a 10 s timeout the UI says so and recommends the server path.

**Sharing**: `npm run share` runs the server on 8090 plus `npx cloudflared tunnel --url http://localhost:8090` and prints the `https://*.trycloudflare.com` URL (WebSockets pass through). README also documents Railway/Render/Fly with `npm run build && npm start` and a `PORT` env var.

---

