# Design

This is the design contract the game is built from: architecture, netcode, movement and gunplay numbers, asset pipeline, rendering, UI, bots, file ownership and verification. Every tunable named here lives in `shared/constants.ts`, `shared/weapons.ts` or `shared/perks.ts`.

## 1. Tech stack

| Piece | Choice | Why |
|---|---|---|
| Language | TypeScript 5.9.3, `erasableSyntaxOnly` + `verbatimModuleSyntax` | Many parallel agents need typed contracts. Node 26 runs `server/**` and `shared/**` `.ts` directly (no server build step), which forbids enums/namespaces/param properties and requires `.ts` extensions on every relative import. |
| Client bundler | Vite 8 | Dev server with HMR, production build to `dist/`, resolves `three/addons`. |
| Rendering | three 0.185.1 | WebGL2, GLTF/FBX/OBJ/Collada loaders, EffectComposer, CSM, AnimationMixer. |
| Server | Node 26 + ws 8.21 | One process: HTTP static (`dist/`) + WebSocket upgrade + rooms. One port means one tunnel URL. |
| P2P | peerjs 1.5.5 (client only) | Free public signaling at 0.peerjs.com. |
| Tests | `node --test` | No extra deps. |
| Deps | three, ws, peerjs, vite, typescript, @types/ws, @types/node | Nothing else. No physics engine (custom capsule vs AABB). |

**Three tsconfigs, because one cannot work.** Mixing `lib.dom` and `@types/node` in one program breaks on conflicting globals (`setTimeout` returns `number` vs `NodeJS.Timeout`), which would fail the gate for the whole repo:

- `tsconfig.base.json`: `target: esnext`, `module: nodenext`, `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noEmit`, `allowImportingTsExtensions`. No `lib`, no `types`.
- `tsconfig.client.json`: extends base, `lib: ["ES2022","DOM","DOM.Iterable"]`, `types: []`, includes `client/**`, `shared/**`.
- `tsconfig.server.json`: extends base, `lib: ["ES2022"]`, `types: ["node"]`, includes `server/**`, `shared/**`, `scripts/**`, `tests/**`.

Scripts: `dev`, `build`, `start` (`node server/index.ts`), `check` (`tsc -p tsconfig.client.json --noEmit && tsc -p tsconfig.server.json --noEmit`), `test`, `soak`, `assets`, `tunnel` (`npx cloudflared tunnel --url http://localhost:8080`), `share`. Every script prefixes `PATH=/opt/homebrew/bin:$PATH`.

---

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

**Sharing**: `npm run share` runs the server on 8080 plus `npx cloudflared tunnel --url http://localhost:8080` and prints the `https://*.trycloudflare.com` URL (WebSockets pass through). README also documents Railway/Render/Fly with `npm run build && npm start` and a `PORT` env var.

---

## 4. Movement and gunplay (all numbers in `shared/constants.ts` and `shared/weapons.ts`)

**Body**: capsule radius 0.35 m; stand 1.80 (eye 1.62), crouch 1.20 (eye 1.05), prone 0.60 (eye 0.40). Transitions: stand↔crouch 0.25 s, to prone 0.9 s, prone→stand 0.8 s. Step-up 0.45 m. Gravity 22 m/s², terminal 40. Fall damage above 6 m, 10 per extra metre.

**Speeds (m/s)**: walk 4.3 (strafe ×0.9, back ×0.8); crouch 2.4; prone 1.2; sprint 6.2 (forward ±45° cone); **tac sprint 8.2** (a 32% jump over sprint, so it reads as a distinct gear like MW2019); slide 7.5 → 2.5 over 0.75 s; ADS walk AR 2.6 / SMG 3.0 / sniper 2.0 / shotgun 2.8 / pistol 3.2; mounted 0 with ±0.4 m lean. Ground accel 40, decel 50, air accel 6. Landing: ×0.6 speed for 0.25 s plus spread bump.

**Jump** 6.6 m/s (≈1.0 m), no double jump. **Mantle**: on jump, if a chest-height forward ray (0.7 m) finds a ledge 0.5–1.6 m above the feet with clearance above, play a 0.5 s (0.35 s if ≤0.9 m) locked cubic camera path, weapon lowered, cannot fire.

**Sprint**: 0.1 s of forward input. Sprint-out-to-fire: AR 0.25, SMG 0.18, sniper 0.40, shotgun 0.28, pistol 0.15 s. **Tac sprint**: double-tap sprint or the dedicated button; 4.0 s duration, 3.0 s cooldown, gun high, sprint-out ×1.4; a slide resets the timer (slide-cancel).

**Slide** 0.75 s, no steering, free yaw, ADS blocked for the first 0.2 s, camera at 0.8 m. Pressing crouch or jump during it cancels: stand instantly, keep 90% velocity, tac sprint available again. Holding prone during a slide ends in prone.

**Mount**: ADS within 0.6 m of an edge at chest height ±0.3 m → recoil ×0.5, no sway, movement becomes a ±0.4 m lean.

**ADS**: base FOV 90 (setting 70–110). ADS FOV AR 60 / SMG 65 / sniper 18 (scope overlay, hold-breath) / shotgun 70 / pistol 70. ADS time 0.25 / 0.20 / 0.50 / 0.30 / 0.18 s. Sensitivity ×0.6 in ADS, ×0.3 sniper.

**Viewmodel motion (procedural)**: idle sway 0.4° Lissajous at 0.6/0.8 Hz (0.15° in ADS); walk bob 0.5° @ 2.2 Hz; sprint bob 1.2° @ 3 Hz with 6° tilt; tac-sprint high pose; look-lag 1.5° on an 8 Hz spring; per-shot recoil kick with 12 Hz return; reload as keyframed transform curves driven by `reloadT`; ADS lerp with ease-out; 3 cm landing dip; slide lowers and rolls 8°.

**Health** 100, regen 40 HP/s after 4 s. Damage flinch 1.5°. **Melee is a one-hit kill** at 1.6 m with a 0.8 s window (as in every mainline COD); it bypasses the damage pipeline and emits a kill event.

**Weapons** (hitscan):

| Slot | Weapon | Damage by range (m) | RPM | Mag/Res | Reload tac/empty | ADS | Recoil vert/horiz° | Hip spread stand/crouch/move/jump° | Head/chest/limb | TTK |
|---|---|---|---|---|---|---|---|---|---|---|
| Primary | AR | 28 (0–25), 24 (–45), 20 (45+) | 800 | 30/120 | 2.1/2.6 | 0.25 | 0.35 rising, right drift / ±0.12 | 2.5/1.8/4.0/7.0 | 1.4/1.0/0.9 | 225 ms |
| Primary | SMG | 26 (0–12), 21 (–25), 17 (25+) | 900 | 32/160 | 1.8/2.2 | 0.20 | 0.28 / ±0.20 walk | 1.8/1.3/2.6/5.0 | 1.3/1.0/0.9 | 200 ms |
| Primary | Sniper (semi) | 95 flat | 45 | 5/25 | 2.8/3.2 | 0.50 | 3.0 / ±0.5 | 12/9/14/20 | 1.5/1.1 one-shot upper torso/0.85 | 0–1333 ms |
| Primary | Shotgun (8 pellets, 5° ADS / 8° hip) | per pellet 14 (0–8), 8 (–14), 4 (–22), 0 beyond | 200 | 8/32 shell-by-shell 0.5 s, cancelable | 0.30 | 1.8 / ±0.6 | — | 1.1/1.0/1.0 | 0–300 ms |
| Secondary | Pistol | 34 (0–15), 26 (–30), 20 (30+) | 450 semi | 15/60 | 1.4/1.7 | 0.18 | 0.9 / ±0.3 | 2.2/1.6/3.2/6.0 | 1.4/1.0/0.9 | 266 ms |

Frag: 4.5 s cookable fuse, 18 m/s throw, restitution 0.3; 120 dmg at ≤2 m falling to 25 at 6 m, LOS-checked. Flash: 1.5 s fuse, 8 m, 1.0 s white-out + 1.5 s fade, 2 s low-passed audio, scaled by view dot. One of each per life.

**Perks** (`shared/perks.ts`, 2 slots, because identical players is the other thing a COD player notices): Double Time (tac sprint ×2 duration, crouch speed ×1.15), E.O.D. (explosive damage ×0.5), Ghost (hidden from the minimap reveal), Amped (weapon swap ×1.7 faster), Quick Fix (regen starts at 1.5 s), Tracker (enemy footstep decals for 3 s). Each perk only scales constants that already exist.

**Modes**: FFA (12 players, 30 kills or 10 min), TDM (6v6, 75 kills or 10 min), S&D (first to 6 of max 11, sides swap after 5; 1:30 rounds, **plant 5 s, defuse 5 s** (franchise default; a 7.5 s defuse would swing retakes to defenders), bomb 45 s; sites A warehouse office and B fuel depot; one life per round; 3 s freeze). Respawn 3 s, spawn scored by distance from enemies, no enemy LOS, and team bias.

---

## 5. Asset manifest and pipeline

`scripts/fetch-assets.mjs` downloads from the pinned URLs below into `public/assets/` (gitignored; the manifest, lock and credits are committed). Per asset: download to a temp path, compute SHA-256, and **if `scripts/asset-lock.json` already has an entry, compare and abort with a non-zero exit on mismatch** ("asset changed upstream or corrupted — verify manually"); write a new entry only when none exists. Then unzip, normalize into `public/assets/<category>/<name>/`, generate 512 px copies with `sips` for the mobile tier, and write `CREDITS.md`. Idempotent. A failed asset logs a warning and its category falls back to procedural.

| Category | Asset | Author / License | Pinned URL | Size | Use / fallback |
|---|---|---|---|---|---|
| Character | Animated Base Character (45 clips) | Quaternius, CC0 | `static.poly.pizza/0b65e14d-a349-44cc-836c-efdeb6933d48.glb` | 2.27 MB | Third-person players and bots. Clips verified present: Idle_Loop, Walk_Loop, Jog_Fwd_Loop, Sprint_Loop, Crouch_Idle_Loop, Crouch_Fwd_Loop, Jump_Start/Loop/Land, Pistol_Idle_Loop, Pistol_Aim_Up/Neutral/Down, Pistol_Shoot, Pistol_Reload, Hit_Chest, Hit_Head, Death01, Roll. Rig is Rigify-style `DEF-*` with full fingers. |
| Character alt | Soldier (rifle clips incl. Run_Shoot) | Quaternius, CC0 | `static.poly.pizza/66a55d04-4286-44a3-b289-0d774c27db5b.glb` | 1.70 MB | Selectable alternative; first fallback. |
| Weapon AR | Soviet Assault Rifle 3D (2,277 tris) | GGBotNet, CC0 | `opengameart.org/sites/default/files/soviet_assault_rifle_3d.zip` | 283 KB | AR. Procedural gunmetal/polymer materials. |
| Weapon AR hero | High-poly AK-47 (OBJ, ~150k tris) | Lamoot, CC0 | `opengameart.org/sites/default/files/highpoly_ak47.obj` | 843 KB | Desktop viewmodel only if it decimates cleanly; else the Soviet AR. |
| Weapon SMG | SMG-10 3D (1,140 tris) | GGBotNet, CC0 | `opengameart.org/sites/default/files/smg-10_3d.zip` | 154 KB | SMG. |
| Weapon sniper | Soviet Special Sniper Rifle 3D (2,392 tris) | GGBotNet, CC0 | `opengameart.org/sites/default/files/soviet_special_sniper_rifle_3d.zip` | 279 KB | Sniper. |
| Weapon shotgun | Semi-Auto Shotgun (OBJ/DAE) | crookedmouth, CC0 (we use the CC0 grant; the zip's CC-BY sounds are NOT used) | `opengameart.org/sites/default/files/myShotgun.zip` | 1.5 MB | Shotgun. |
| Weapon pistol | Pistol (glTF + 1k PBR, 2,357 tris) | loafbrr_1, CC0 | `opengameart.org/sites/default/files/pistolfbxgltftexturesblend_1.zip` | 16.2 MB zip → ship ≈3 MB | Pistol, fully textured. |
| Grenades | High Poly Grenades (flash/frag/smoke) | locarem, CC0 | `opengameart.org/sites/default/files/Grenades.obj` | 1.6 MB | Grenade meshes. |
| Props | Barrel_01, Barrel_03, ammo_box, cardboard_box_01, cement_bag, caged_hanging_light | Poly Haven, CC0 | `dl.polyhaven.org/file/ph-assets/Models/gltf/1k/<id>/<id>_1k.gltf` plus the files listed by `api.polyhaven.com/files/<id>` (verified: `.gltf` + `.bin` + 1k jpgs) | ≈0.7–1 MB each | Map dressing; ammo_box is the S&D bomb. Fallback: primitives. |
| Textures (1k jpg `_diff`, `_nor_gl`, `_rough`/`_arm`) | concrete_floor_01, concrete_wall_007, concrete_block_wall, asphalt_02, corrugated_iron_02, rusty_metal_02, metal_plate, painted_metal_shutter, brick_wall_02, plastered_wall_02, sandy_gravel_02, worn_planks, rubber_tiles | Poly Haven, CC0 | `dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/<id>/<id>_<map>_1k.jpg` — all 13 verified HTTP 200, 0.35–1.15 MB per map | ≈20 MB + 5 MB (512 copies) | Map materials. Fallback: flat colors. |
| HDRI | abandoned_parking 1k .hdr | Poly Haven, CC0 | `dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/abandoned_parking_1k.hdr` (verified 1.62 MB) | 1.6 MB | IBL + sky. Fallback: gradient sky rig. |
| Audio | Kenney Impact Sounds (130), Kenney Interface Sounds (100) | Kenney, CC0 | `kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip` (verified 800 KB), `.../interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip` | ≈1.8 MB | Impacts by material, casings, hitmarker, UI. |
| Audio | Footsteps on different surfaces | congusbongus, **CC-BY 3.0** (attribution required in CREDITS.md and the in-game credits screen) | `opengameart.org/sites/default/files/footsteps_0.zip` (verified 415 KB) | 415 KB | Concrete/metal/gravel/wood footsteps. |

Total ≈35 MB desktop, ≈22 MB mobile. Loaded per phase with a progress bar.

**Drop-in custom assets**: `public/assets/custom/manifest.json` can override the character (GLB + clip-name map) or any weapon (GLB with `Muzzle`/`Grip` empties). Mixamo FBX loads via `FBXLoader`; `docs/CUSTOM_ASSETS.md` gives the exact Mixamo export settings and clip mapping.

---

## 6. Rendering, art and audio

**Map "Compound"** (`shared/map/layout.ts`, declarative boxes/ramps/props/spawns/sites, 90 × 70 m): north and south spawn yards; three lanes — West Alley (60 m sniper sightline, sandbag nests), Central Warehouse (two floors, 3.5 m catwalk, office = Site A, stairs at both ends, caged interior lights), East Yard (containers, jersey barriers, fuel depot = Site B) — with cross-connectors every ~20 m. Mantle-height cover (1.0–1.4 m) throughout, mount edges on sills and barriers, 1 m nav grid for bots.

**Lighting**: HDRI via PMREM for IBL plus a matched directional sun. Desktop: 2-cascade CSM (2048) + GTAO. Mobile: one 1024 shadow map, no AO. ACES tone mapping, exp2 fog 0.004.

**iPhone PMREM guard (real bug, silent failure).** PMREM IBL from an HDR renders black on iPhone Safari in a long-standing WebKit float-render-target bug, and the download-failure fallback never fires for it. So `render/lighting.ts` checks `EXT_color_buffer_half_float` / `OES_texture_float_linear`, renders one warm-up frame, samples the environment for non-zero luminance, and drops to the gradient-sky + ambient/directional rig if it is black. Verification requires a real iPhone, not viewport emulation.

**Post FX**: desktop SMAA + UnrealBloom (threshold 1.0, strength 0.25) + a `GradePass` (vignette, chromatic aberration 0.002, grain 0.03, damage vignette, flash white-out). Mobile: none, 0.8 resolution scale, DPR cap 2.

**Viewmodel** (`client/render/viewmodel.ts`): separate scene and 60° camera composited on top; weapon GLB/FBX/OBJ normalized to a target length with an auto-detected muzzle; procedural arms; all motion from §4.

**Characters** (`client/render/characters.ts`): `SkeletonUtils.clone` per player, one mixer each; locomotion blend by speed, crouch set, jump set, slide → Roll, prone → lowered Crouch_Idle, aim layer cross-faded from the three Pistol_Aim clips by pitch, one-shots for shoot/reload/hit/death; weapon parented to `DEF-hand.R`. **Animation LOD** (the auto-quality system otherwise has no lever for mixer CPU cost): beyond 25 m or outside the frustum, drop the aim layer and tick the mixer every 4th frame; cap full-rate skinned characters at 8 and hold the rest on their last pose.

**Effects** (procedural, pooled): muzzle flash (canvas sprite, 40 ms), tracers, impact sparks/dust per material with 8 s decals, casings, blood puff, explosion with camera shake inside 12 m, flash white-out, grenade trails.

**Audio** (`client/audio/`): unlock on first gesture; master/sfx/ui buses; `PannerNode` per emitter. Gunshots are synthesized per weapon (`synth-guns.ts`): 2 ms transient, bandpassed noise body 60–120 ms centered 400–900 Hz, 60→30 Hz thump, mechanical tick, convolved 0.8 s tail, distance-low-passed variant, ±3% pitch jitter. Samples cover impacts, footsteps and UI.

**iOS mute switch**: Web Audio is silenced entirely by the hardware ring/silent switch while `<audio>` elements are exempt, so on iOS the game also loops a 1 s silent `<audio>` element to route through the media category, and shows a one-time hint.

**Mobile budget**: ≤250 draw calls, ≤300k triangles, 512 px textures, 60 fps target on iPhone 12 / Pixel 6 class. Auto-quality: frame time >20 ms for 2 s drops resolution scale by 0.1 (min 0.5), then shadows, then animation LOD tightens.

---

## 7. UI/UX

Screens (DOM overlay): Boot → Menu (name, Host / Join / Practice, Settings, Credits) → Lobby (room code with copy/share, teams, mode, bots, Start) → Loadout (primary, secondary, lethal, tactical, 2 perks, 3D preview) → Match HUD → **Spectate** → Scoreboard → Results.

**Spectate** is required by S&D's one-life rounds (otherwise a player killed at 0:05 stares at a frozen screen for 85 s): on death in a round-based mode, attach the camera to the nearest living teammate's interpolated state, cycle with fire/ADS or left/right, keep killfeed, round timer and the spectated player's name and health. No new network message: SNAPSHOT already carries everyone.

HUD: dynamic crosshair, hitmarker (red for headshots), damage-direction arcs, health with regen pulse, ammo and reserve, weapon name, grenade counts, rotating 120 px minimap with teammates and fire-revealed enemies, timer and score, 5-line killfeed, S&D objective banners, ping, low-health vignette, sprint/tac-sprint icon, mount and mantle prompts.

Desktop: pointer lock on click; WASD, Shift sprint (double-tap tac sprint), C crouch/slide, Z prone, Space jump/mantle, Mouse1 fire, Mouse2 ADS, R reload, 1/2/wheel swap, G frag, T flash, V melee, F plant/defuse, Tab scoreboard, Esc menu. Settings: sensitivity, ADS multiplier, FOV, invert, ADS hold/toggle, auto-sprint, auto-mount, quality, volumes, touch layout size and opacity.

**Touch layout** (landscape only, rotate prompt in portrait): left zone floating joystick spawning at the touch point (64 px, push >0.9 for 0.3 s auto-sprints, double-flick up = tac sprint); right zone drag-look at 0.25°/px (×0.6 in ADS, optional gyro behind a permission button); buttons ≥56 px for fire, ADS, jump, crouch/slide/prone, reload, swap, frag, flash, melee, scoreboard, menu. The **secondary tap-fire button sits on the right near ADS** (where COD Mobile actually puts it) rather than beside the joystick, where it would collide with joystick spawn detection. `touch-action: none`, non-passive listeners, per-identifier multi-touch tracking.

**iOS specifics that must be right or the mobile build simply misbehaves**: `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">` (without `viewport-fit=cover`, every `env(safe-area-inset-*)` resolves to 0); `apple-mobile-web-app-capable` and `apple-mobile-web-app-status-bar-style=black-translucent`; manifest `display: standalone` with `fullscreen` as a progressive enhancement gated on `document.fullscreenEnabled`, since iOS honors neither; `height: 100vh; height: 100dvh;` in that order so pre-15.4 WebKit falls back instead of collapsing; buttons kept `env(safe-area-inset-bottom) + 12px` off the bottom and ≥4 pt from the side edges, outside iOS's edge-swipe reservations. README states the baseline: iOS 15.4+, Android Chrome 90+, WebGL2. A tiny service worker exists only for install eligibility.

---

## 8. Bots (`shared/sim/bots.ts`, produce `InputCmd` like any client)

FSM: ROAM (A* to a lane point, sprint far, walk near cover), ENGAGE (nearest visible enemy with 3 s memory, reaction 250–600 ms by difficulty, aim error 1–6° decaying, 3–6 round bursts, strafe every 0.8 s, crouch under 40 HP, ADS beyond 15 m), RELOAD, GRENADE (frag at a lost target's last position), plus S&D roles (attackers pick and plant a site, defenders hold and defuse). Difficulties: Recruit, Regular, Veteran. Bots fill to the lobby count and yield to joining humans.

---

## 9. File tree, owners and interfaces

Waves: `W0` contracts , `W1` parallel build (letters A–L, one agent each), `W2` integration, `W3` tests, `W4` verification, `W5` GitHub. Every `shared/` file is DOM-free, three-free and clock-free.

```
tactical-fps/
├─ package.json  tsconfig.base.json  tsconfig.client.json  tsconfig.server.json  vite.config.ts
├─ index.html (viewport-fit=cover + apple meta tags)  .gitignore  LICENSE (MIT)  README.md        [W0]
├─ CREDITS.md (generated)  scripts/asset-manifest.json  scripts/asset-lock.json                   [W0 / W1-J]
├─ public/manifest.webmanifest  public/sw.js  public/icons/*.png  public/assets/custom/README.md   [W1-J]
├─ scripts/fetch-assets.mjs  make-icons.mjs  dev.mjs  tunnel.mjs  bot-soak.ts                      [W1-J, W3]
├─ shared/
│  ├─ constants.ts    TICK_RATE, TICK_DT, SNAPSHOT_EVERY, INPUT_SEND_HZ=60, MAX_INPUT_MSGS_PER_SEC=75,
│  │                  INTERP_TICKS=6, STALL_MS=250, REJOIN_GRACE_MS=20000, all §4 numbers, BTN_*, MOVE_*, PHASE_*, TEAM_*, ZONE_*   [W0]
│  ├─ types.ts        Vec3, InputCmd, PlayerState, ProjectileState, Snapshot, SnapshotPlayer, GameEvent (union), RoomState, LobbyPlayer, MatchResult, Loadout, PlayerConnState  [W0]
│  ├─ protocol.ts     MSG ids + encode/decode for every §3 message, quantization helpers, MAX_MSG_SIZE   [W0 signatures, W1-C bodies]
│  ├─ net/transport.ts  Transport interface, LocalTransport, and the documented ordering contract         [W0]
│  ├─ math.ts         allocation-free vec ops, mulberry32, quantize/dequantize, rayAabb, rayCapsule, raySphere, capsuleAabbResolve  [W1-A]
│  ├─ movement.ts     stepPlayer(state, cmd, world, dt, out: MovementEvents): void — the whole §4 state machine, pure    [W1-A]
│  ├─ weapons.ts      WEAPONS: WeaponDef[], damageAt, recoilAt, spreadFor, pelletDirs                                    [W1-A]
│  ├─ perks.ts        PERKS: PerkDef[] with multipliers applied by stepPlayer/stepWeapon/World                            [W1-A]
│  ├─ sim/weaponstate.ts  stepWeapon(state, cmd, dt, out: WeaponEvents): void — fire cooldown, ammo, reload timers;
│  │                  called by BOTH World.step and the client Predictor so replay reproduces ammo exactly                 [W1-A]
│  ├─ map/layout.ts   MAP_COMPOUND: MapLayout                                                                             [W1-B]
│  ├─ map/colliders.ts buildColliders(layout) → { aabbs, materialAt, raycast, spawnsFor, sites }; buildNavGrid → { walkable, astar }  [W1-B]
│  ├─ sim/world.ts    class World { players, projectiles, tick, events; addPlayer; removePlayer; applyInput (drops seq ≤ lastAppliedSeq);
│  │                  step(); snapshotFor(id); damage(); respawn(id, spawn: {pos, yaw}) }                                  [W1-C]
│  ├─ sim/lagcomp.ts  HitHistory { record, volumesAt, raycastPlayers }                                                     [W1-C]
│  ├─ sim/grenades.ts integration, bounce, explode, flashStrength                                                          [W1-C]
│  ├─ sim/modes.ts    interface ModeRules { onStart, onTick, onKill, onPlayerJoin, canRespawn, pickSpawn(world, team), phase, scores, roundInfo, interact };
│  │                  FfaRules, TdmRules, SndRules. Room (not World) calls pickSpawn and passes the result to world.respawn  [W1-D]
│  ├─ sim/bots.ts     class BotBrain { think(world, tick): InputCmd }  (stamps cmd.tick = world.tick + INTERP_TICKS)        [W1-K]
│  └─ net/room.ts     class Room { attach(transport, hello); detach; tick(now); state(); start(); holds slots for REJOIN_GRACE_MS }  [W1-D]
├─ server/
│  ├─ index.ts        exports createServer(opts) → { httpServer, wss, close() }; listens ONLY when run directly
│  │                  (import.meta.url === pathToFileURL(process.argv[1]).href) so tests can import it safely             [W1-D]
│  └─ ws-transport.ts WsTransport (binary frames, drops snapshots above 64 KB buffered)                                   [W1-D]
├─ client/
│  ├─ main.ts  app-state.ts                                                                                                [W2]
│  ├─ net/client-net.ts  connectWs | connectPeer | connectLocal, reconnect(), sendInput at 60 Hz, rtt, localEstServerTick   [W1-E]
│  ├─ net/prediction.ts  class Predictor { local: PlayerState | null; pushInput; onAuthoritative; renderOffset }            [W1-E]
│  ├─ net/interpolation.ts EntityBuffer (rejects stale ticks) + stall detection                                            [W1-E]
│  ├─ net/peer-host.ts  PeerHost running Room on the main thread + PeerTransport + iOS reconnect                           [W1-E]
│  ├─ net/local-host.ts LocalHost: Room + bots in-process                                                                  [W1-E]
│  ├─ input/input-manager.ts  keyboard-mouse.ts  touch.ts                                                                   [W1-H]
│  ├─ assets/loader.ts  fallbacks.ts                                                                                       [W1-J]
│  ├─ render/renderer.ts  lighting.ts (PMREM guard)  materials.ts  map-builder.ts  props.ts                                 [W1-F]
│  ├─ render/camera.ts  viewmodel.ts  characters.ts (animation LOD)  effects.ts                                             [W1-G]
│  ├─ audio/audio.ts (iOS silent-audio unmute)  synth-guns.ts  samples.ts                                                   [W1-I]
│  └─ ui/*.ts + styles.css + touch.css (menu, lobby, loadout, hud, minimap, killfeed, scoreboard, spectate, settings, results, credits), settings.ts  [W1-L]
├─ tests/ movement, protocol, world, lagcomp, modes, prediction-drift, weaponstate, bots, assets-manifest                   [W3]
└─ docs/DESIGN.md  NETCODE.md  CUSTOM_ASSETS.md                                                                             [W2]
```

Rules for every agent: import `shared/` with explicit `.ts` extensions; no three.js or DOM in `shared/`; no `Date.now()` in `shared/` (`Room.tick(now)` receives it); all tunables from `constants.ts`/`weapons.ts`/`perks.ts`; no new dependencies; your files must pass `npm run check`.

---

## 11. Verification

- `npm run check` and `npm test`: movement determinism (identical inputs → identical states), slide-cancel/mantle/tac-sprint timers, protocol round-trip including a 12-player snapshot ≤ 900 B, lag-comp rewind hitting a target that has since moved, bot shots resolving against `now`, weapon-state replay reproducing ammo after a correction, S&D round and side logic, prediction drift bounds, bots planting.
- `npm run soak`: 12 bots, 60 s, snapshot interval 50 ms ±5, no exceptions, stable memory.
- `npm run build`: JS bundle < 1.5 MB gzipped, assets within the §5 budget.
- Browser automation: no console errors; 45 s scripted practice match exercising sprint, slide-cancel, mantle, ADS, fire, reload, grenade; screenshots at 1440×900; then the 375×812 touch viewport for joystick, look, fire/ADS, portrait prompt; a two-tab host+joiner test for join, killfeed and scoreboard sync; a two-tab PeerJS test.
- **Manual, and genuinely required** (these do not reproduce in emulation): the user opens the tunnel URL on a real iPhone to confirm the PMREM lighting path is not black, audio plays with the ring switch in both positions, safe-area insets apply, and the game survives locking and unlocking the screen. Plus Safari on the Mac for a WebKit smoke test.

---

## 12. Risks and mitigations

1. **Model-tier overload (529 errors)** blocked every opus/fable subagent during planning; the sonnet tier works. Build agents run on sonnet, contracts stay tight, and the maintainer do integration myself.
2. **Realism expectations**: stated plainly above. Environment and lighting carry the look; characters are stylized operators until the user drops in their own model.
3. **iOS backgrounding** kills both WebSockets and WebRTC: reconnect path plus a 20 s server-side slot grace.
4. **iPhone PMREM black-environment bug**: capability check plus a luminance sample, with a real-device verification step.
5. **TCP head-of-line blocking** on the WebSocket path can exceed the 150 ms extrapolation window (RTO ≥200 ms): 250 ms stall detection, freeze, indicator, snap on resume.
6. **Unordered-but-reliable P2P channel**: explicit stale-frame drop rules on both ends.
7. **FBX/OBJ weapons with odd scale or orientation**: loader normalizes bounds and auto-detects the muzzle; the hero AK is optional.
8. **Mannequin lacks rifle, prone and slide clips**: aim layer from the pistol clips plus procedural spine pitch; prone and slide from lowered Crouch and Roll; drop-in path documented.
9. **P2P NAT failure** with no TURN: 10 s timeout, clear message, recommend the server path.
10. **Asset URLs changing**: SHA-256 lock with compare-and-abort, per-category fallbacks, explicit failure reporting.
11. **Scope**: modes, weapons and perks are data-driven. Explicitly out of v1: killstreaks, attachments/Gunsmith, host migration, smoke grenades, ranked progression.
