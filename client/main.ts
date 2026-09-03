// Client entry point: boot → menu → (host | join | practice) → lobby → match.
// Owns the per-frame loop that ties input, prediction, the network layer,
// rendering, audio and the HUD together. Everything gameplay-related is
// computed by shared/ code; this file only wires and presents.

import './ui/styles.css';
import './ui/touch.css';

import * as THREE from 'three';

import {
  BOMB_PLANTED,
  BTN_ADS,
  BTN_FIRE,
  CONN_ACTIVE,
  EV_DEFUSE,
  EV_EXPLODE,
  EV_FIRE,
  EV_FLASHED,
  EV_HIT,
  EV_IMPACT,
  EV_KILL,
  EV_MELEE,
  EV_PLANT,
  EV_RELOAD,
  EV_RESPAWN,
  EV_ROUND,
  FLASH_BLIND_TIME,
  FLASH_DEAFEN_TIME,
  FLASH_FADE_TIME,
  FOV_DEFAULT,
  INPUT_REDUNDANCY,
  INTERP_TICKS,
  MAP_COMPOUND,
  MAT_FLESH,
  MINIMAP_REVEAL_SECONDS,
  MODE_ANY,
  MODE_SND,
  MOVE_AIR,
  MOVE_DEAD,
  MOVE_MOUNTED,
  MOVE_SLIDE,
  PHASE_LIVE,
  PHASE_LOBBY,
  PHASE_MATCH_END,
  PROJ_FLASH,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LEN,
  ROUND_END,
  ROUND_START,
  SND_SITE_RADIUS,
  TEAM_A,
  TEAM_B,
  TICK_DT,
  WEAPON_SNIPER,
  ZONE_HEAD,
} from '../shared/constants.ts';
import type { GameEvent, HelloMsg, Loadout, PlayerState, RoomState, Snapshot, SnapshotPlayer, Vec3 } from '../shared/types.ts';
import { LOBBY_BACK_TO_LOBBY, LOBBY_KICK, LOBBY_SET_BOTS, LOBBY_SET_BOT_DIFFICULTY, LOBBY_SET_MODE, LOBBY_SET_TEAM, LOBBY_START, createPlayerState, defaultLoadout, vec3 } from '../shared/types.ts';
import { getMapLayout } from '../shared/map/layout.ts';
import { buildColliders } from '../shared/map/colliders.ts';
import type { MapColliders, MapLayout } from '../shared/map/types.ts';
import { activeWeaponDef } from '../shared/sim/weaponstate.ts';
import { recoilAt } from '../shared/weapons.ts';
import { mulberry32 } from '../shared/math.ts';
import { Room } from '../shared/net/room.ts';

import { AppState } from './app-state.ts';
import { loadSettings, saveSettings } from './settings.ts';
import type { Settings } from './settings.ts';
import { loadAssets } from './assets/loader.ts';
import type { GameAssets } from './assets/loader.ts';
import { InputManager } from './input/input-manager.ts';
import { isTouchDevice } from './input/touch.ts';
import { ClientNet } from './net/client-net.ts';
import { Predictor } from './net/prediction.ts';
import { RemoteEntities } from './net/interpolation.ts';
import { LocalHost } from './net/local-host.ts';
import { PeerHost } from './net/peer-host.ts';
import { Renderer } from './render/renderer.ts';
import type { Quality } from './render/renderer.ts';
import { setupLighting } from './render/lighting.ts';
import type { Lighting } from './render/lighting.ts';
import { MaterialLibrary } from './render/materials.ts';
import { PropLibrary } from './render/props.ts';
import { buildMap } from './render/map-builder.ts';
import { CameraRig } from './render/camera.ts';
import { Viewmodel } from './render/viewmodel.ts';
import { CharacterManager } from './render/characters.ts';
import { Effects } from './render/effects.ts';
import { AudioEngine } from './audio/audio.ts';
import { buildGunshotBank } from './audio/synth-guns.ts';
import type { GunshotBank } from './audio/synth-guns.ts';
import { loadSampleBank } from './audio/samples.ts';
import type { SampleBank } from './audio/samples.ts';
import { UI } from './ui/ui.ts';
import type { Hud } from './ui/hud.ts';
import type { Minimap } from './ui/minimap.ts';
import type { LobbyController } from './ui/lobby.ts';
import type { SpectateOverlay } from './ui/spectate.ts';
import type { ScoreboardOverlay } from './ui/scoreboard.ts';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;
const settings: Settings = loadSettings();
const isTouch = isTouchDevice();
const isIos = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const quality: Quality = settings.quality === 'auto' ? (isTouch ? 'mobile' : 'desktop') : settings.quality;

const ui = new UI(uiRoot, settings);
const app = new AppState();
const audio = new AudioEngine();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function wsUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function makeRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  return code;
}

function hello(roomCode: string, mode: number, wantBots: number): HelloMsg {
  return { protocolVersion: PROTOCOL_VERSION, name: settings.name, roomCode, mode, wantBots, rejoinId: 0 };
}

async function serverReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch('/healthz', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Boot: assets, renderer, world visuals, audio
// ---------------------------------------------------------------------------
interface Visuals {
  renderer: Renderer;
  materials: MaterialLibrary;
  lighting: Lighting;
  cameraRig: CameraRig;
  viewmodel: Viewmodel;
  characters: CharacterManager;
  effects: Effects;
  layout: MapLayout;
  colliders: MapColliders;
}

let assets: GameAssets;
let visuals: Visuals;
let guns: GunshotBank | null = null;
let samples: SampleBank | null = null;
let reachable = false;

async function boot(): Promise<void> {
  const bootScreen = ui.showBoot();
  try {
    assets = await loadAssets(quality, (done, total, label) => bootScreen.setProgress(done, total, label), { character: settings.character });
  } catch (err) {
    bootScreen.setError(`Asset loading failed: ${(err as Error).message}`);
    throw err;
  }
  bootScreen.setProgress(1, 1, 'Building world');

  const renderer = new Renderer(canvas, quality);
  const materials = new MaterialLibrary(assets, quality);
  const props = new PropLibrary(assets);
  const lighting = setupLighting(renderer, assets, quality);
  const layout = getMapLayout(MAP_COMPOUND);
  const built = buildMap(layout, materials, props, quality);
  renderer.scene.add(built.group);
  for (const light of built.lights) renderer.scene.add(light);
  const cameraRig = new CameraRig(renderer.camera, settings.fov || FOV_DEFAULT);
  const viewmodel = new Viewmodel(renderer.vmScene, renderer.vmCamera, assets, materials);
  const characters = new CharacterManager(renderer.scene, assets, materials);
  const effects = new Effects(renderer.scene, materials, quality);
  if (lighting.csm) for (const m of materials.all()) lighting.csm.setupMaterial(m);
  const colliders = buildColliders(layout);
  visuals = { renderer, materials, lighting, cameraRig, viewmodel, characters, effects, layout, colliders };

  window.addEventListener('resize', () => renderer.resize());
  window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 100));
  renderer.resize();

  // Audio unlocks on the first gesture; banks are built right after.
  const unlock = async (): Promise<void> => {
    if (audio.isReady) return;
    await audio.unlock();
    if (audio.ctx && !guns) {
      guns = buildGunshotBank(audio.ctx);
      loadSampleBank(audio.ctx, assets.audioUrls).then((bank) => { samples = bank; }).catch(() => {});
      audio.setVolumes(settings.volumeMaster, settings.volumeSfx, settings.volumeUi);
    }
  };
  for (const ev of ['pointerdown', 'touchstart', 'keydown']) document.addEventListener(ev, () => { void unlock(); }, { passive: true });

  reachable = await serverReachable();
  app.go('menu');
  showMenu();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Menu / settings / credits
// ---------------------------------------------------------------------------
function prefillCode(): string | undefined {
  const code = new URLSearchParams(location.search).get('room');
  return code ? code.toUpperCase().slice(0, ROOM_CODE_LEN) : undefined;
}

function showMenu(): void {
  app.reset('menu');
  ui.showMenu(
    {
      onHost: (mode, bots, difficulty) => { void startHost(mode, bots, difficulty); },
      onJoin: (code) => { void startJoin(code.toUpperCase()); },
      onPractice: (mode, bots, difficulty) => { void startPractice(mode, bots, difficulty); },
      onSettings: () => showSettings(showMenu),
      onCredits: () => ui.showCredits(assets.credits, showMenu),
    },
    { serverReachable: reachable, prefillCode: prefillCode() },
  );
}

function showSettings(onClose: () => void): void {
  ui.showSettings(
    () => {
      saveSettings(settings);
      visuals.cameraRig.setBaseFov(settings.fov || FOV_DEFAULT);
      audio.setVolumes(settings.volumeMaster, settings.volumeSfx, settings.volumeUi);
      onClose();
    },
    {
      isIos,
      onGyroPermission: () => session?.input.enableGyro() ?? Promise.resolve(false),
      onCredits: () => ui.showCredits(assets.credits, () => showSettings(onClose)),
    },
  );
}

// ---------------------------------------------------------------------------
// Session: one connection (ws | peer | local) with its lobby and match runtime
// ---------------------------------------------------------------------------
interface Session {
  net: ClientNet;
  localHost: LocalHost | null;
  peerHost: PeerHost | null;
  localId: number;
  roomState: RoomState | null;
  lobby: LobbyController | null;
  input: InputManager;
  // match runtime (created on first snapshot / phase change)
  inMatch: boolean;
  predictor: Predictor;
  remotes: RemoteEntities;
  hud: Hud | null;
  minimap: Minimap | null;
  spectate: SpectateOverlay | null;
  scoreboard: ScoreboardOverlay | null;
  seq: number;
  inputAccum: number;
  lastSnapshot: Snapshot | null;
  revealed: Map<number, number>;
  spectateTargetId: number;
  damageVignette: number;
  flashOverlay: number;
  paused: boolean;
  scoreboardShown: boolean;
  lastPos: Map<number, Vec3>;
  stepDist: Map<number, number>;
  lastDeadButtons: number;
  spectateCycle: boolean;
  lowFrameTime: number;
  resolutionScale: number;
  recoilRng: () => number;
}

let session: Session | null = null;

async function connectWith(label: string, connect: () => Promise<ClientNet>, localHost: LocalHost | null, peerHost: PeerHost | null): Promise<void> {
  app.go('connecting');
  ui.showMessage('Connecting', label, () => {});
  let net: ClientNet;
  try {
    net = await connect();
  } catch (err) {
    localHost?.stop();
    peerHost?.stop();
    ui.showConnectError((err as Error).message || 'Could not connect', () => showMenu(), () => showMenu());
    app.reset('menu');
    return;
  }
  openSession(net, localHost, peerHost);
}

async function startHost(mode: number, bots: number, difficulty: number): Promise<void> {
  if (reachable) {
    await connectWith('Creating a room on the server…', () => ClientNet.connectWs(wsUrl(), hello('', mode, bots)), null, null);
    return;
  }
  const code = makeRoomCode();
  const room = new Room({ code, mode, mapId: MAP_COMPOUND, botCount: bots, botDifficulty: difficulty, seed: Date.now() & 0xffff });
  const host = new PeerHost(room);
  await connectWith(`Hosting room ${code} peer-to-peer…`, async () => {
    await host.start(code, hello(code, mode, bots));
    if (!host.localNet) throw new Error('Peer host did not produce a local connection');
    return host.localNet;
  }, null, host);
}

async function startJoin(code: string): Promise<void> {
  if (code.length !== ROOM_CODE_LEN) {
    ui.showMessage('Room code', 'Enter the 4-character room code.', showMenu);
    return;
  }
  if (reachable) {
    await connectWith(`Joining ${code}…`, async () => {
      try {
        return await ClientNet.connectWs(wsUrl(), hello(code, MODE_ANY, 0));
      } catch (err) {
        // Not on this server: the host may be running a peer-to-peer room.
        if (/not found/i.test((err as Error).message)) return ClientNet.connectPeer(code, hello(code, MODE_ANY, 0));
        throw err;
      }
    }, null, null);
    return;
  }
  await connectWith(`Joining ${code} peer-to-peer…`, () => ClientNet.connectPeer(code, hello(code, MODE_ANY, 0)), null, null);
}

async function startPractice(mode: number, bots: number, difficulty: number): Promise<void> {
  const host = new LocalHost({ code: 'SOLO', mode, mapId: MAP_COMPOUND, botCount: bots, botDifficulty: difficulty, seed: Date.now() & 0xffff });
  host.start();
  await connectWith('Starting practice…', () => ClientNet.connectLocal(host.room, hello('SOLO', mode, bots)), host, null);
}

function openSession(net: ClientNet, localHost: LocalHost | null, peerHost: PeerHost | null): void {
  const input = new InputManager(canvas, uiRoot, settings);
  const s: Session = {
    net,
    localHost,
    peerHost,
    localId: net.welcome.playerId,
    roomState: null,
    lobby: null,
    input,
    inMatch: false,
    predictor: new Predictor(visuals.colliders),
    remotes: new RemoteEntities(),
    hud: null,
    minimap: null,
    spectate: null,
    scoreboard: null,
    seq: 0,
    inputAccum: 0,
    lastSnapshot: null,
    revealed: new Map(),
    spectateTargetId: 0,
    damageVignette: 0,
    flashOverlay: 0,
    paused: false,
    scoreboardShown: false,
    lastPos: new Map(),
    stepDist: new Map(),
    lastDeadButtons: 0,
    spectateCycle: false,
    lowFrameTime: 0,
    resolutionScale: 1,
    recoilRng: mulberry32(net.welcome.playerId * 7919 + 17),
  };
  session = s;

  net.onRoomState = (state) => onRoomState(s, state);
  net.onSnapshot = (snap) => onSnapshot(s, snap);
  net.onMatchEnd = (result) => {
    ui.showResults(result, s.localId, () => {
      if (s.roomState && s.roomState.phase === PHASE_LOBBY) enterLobby(s);
      else ui.hideScreens();
    });
    app.reset('results');
  };
  net.onChat = (c) => {
    const name = s.roomState?.players.find((p) => p.id === c.from)?.name ?? `Player ${c.from}`;
    s.lobby?.pushChat(name, c.text);
  };
  net.onError = (_code, message) => {
    leaveSession(`Disconnected: ${message}`);
  };
  net.onClose = () => {
    if (session === s && net.kind !== 'local') scheduleReconnect(s);
  };
  input.onMenu = () => togglePause(s);

  // The first ROOM_STATE arrives right after WELCOME; show the lobby now with a placeholder.
  enterLobby(s);
}

function leaveSession(message?: string): void {
  const s = session;
  if (!s) return;
  session = null;
  s.net.close();
  s.localHost?.stop();
  s.peerHost?.stop();
  s.input.detach();
  s.hud?.hide();
  s.spectate?.hide();
  s.scoreboard?.hide();
  ui.setPauseMenu(false);
  ui.showReconnecting(false);
  visuals.characters.update(new Map(), 0, ZERO, 0);
  if (document.pointerLockElement) document.exitPointerLock();
  if (message) ui.showMessage('Left the game', message, showMenu);
  else showMenu();
}

let reconnecting = false;
function scheduleReconnect(s: Session): void {
  if (reconnecting) return;
  reconnecting = true;
  ui.showReconnecting(true);
  s.net.reconnect()
    .then(() => { ui.showReconnecting(false); })
    .catch((err: Error) => { leaveSession(`Connection lost (${err.message})`); })
    .finally(() => { reconnecting = false; });
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
function packTeamCmd(playerId: number, team: number): number {
  return ((playerId & 0x3f) << 2) | (team & 0x3);
}

function placeholderRoomState(s: Session): RoomState {
  return {
    code: s.net.welcome.roomCode,
    phase: PHASE_LOBBY,
    mode: s.net.welcome.mode,
    mapId: s.net.welcome.mapId,
    hostId: s.localId,
    round: 0,
    roundsWon: [0, 0],
    timeLeft: 0,
    players: [{ id: s.localId, team: s.net.welcome.teamId, name: settings.name, kills: 0, deaths: 0, score: 0, ping: 0, isBot: false, connState: CONN_ACTIVE, loadout: defaultLoadout() }],
    bombState: 0,
    bombSite: 0,
    bombTimer: 0,
    bombCarrier: 0,
    botCount: 0,
    botDifficulty: 1,
    maxPlayers: 12,
  };
}

function enterLobby(s: Session): void {
  app.reset('lobby');
  s.inMatch = false;
  s.input.detach();
  s.hud?.hide();
  s.spectate?.hide();
  s.scoreboard?.hide();
  ui.setPauseMenu(false);
  if (document.pointerLockElement) document.exitPointerLock();
  const state = s.roomState ?? placeholderRoomState(s);
  s.lobby = ui.showLobby(state, s.localId, {
    onStart: () => s.net.sendLobbyCmd({ action: LOBBY_START, value: 0 }),
    onSetMode: (mode) => s.net.sendLobbyCmd({ action: LOBBY_SET_MODE, value: mode }),
    onSetBots: (n) => s.net.sendLobbyCmd({ action: LOBBY_SET_BOTS, value: n }),
    onSetDifficulty: (d) => s.net.sendLobbyCmd({ action: LOBBY_SET_BOT_DIFFICULTY, value: d }),
    onSetTeam: (team) => s.net.sendLobbyCmd({ action: LOBBY_SET_TEAM, value: packTeamCmd(s.localId, team) }),
    onKick: (id) => s.net.sendLobbyCmd({ action: LOBBY_KICK, value: id }),
    onLoadout: () => {
      const current = s.roomState?.players.find((p) => p.id === s.localId)?.loadout ?? defaultLoadout();
      app.go('loadout');
      ui.showLoadout(current, (loadout: Loadout) => { s.net.sendLoadout(loadout); enterLobby(s); }, () => enterLobby(s));
    },
    onLeave: () => leaveSession(),
    onChat: (text) => s.net.sendChat(text),
  });
}

function onRoomState(s: Session, state: RoomState): void {
  const prev = s.roomState;
  s.roomState = state;
  if (app.screen === 'lobby' && s.lobby) s.lobby.update(state);
  const wasLobby = !prev || prev.phase === PHASE_LOBBY;
  if (state.phase !== PHASE_LOBBY && state.phase !== PHASE_MATCH_END && !s.inMatch) {
    enterMatch(s);
  } else if (state.phase === PHASE_LOBBY && s.inMatch) {
    enterLobby(s);
  } else if (state.phase === PHASE_LOBBY && !wasLobby && app.screen !== 'lobby' && app.screen !== 'loadout') {
    enterLobby(s);
  }
  if (s.inMatch && s.scoreboard && s.scoreboardShown) s.scoreboard.update(state, s.localId);
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------
const ZERO: Vec3 = vec3();
const scratchVec = vec3();
const scratchVec2 = vec3();
const scratchThree = new THREE.Vector3();
const spectateState: PlayerState = createPlayerState(0, '', 0);

function enterMatch(s: Session): void {
  app.reset('match');
  ui.hideScreens();
  s.inMatch = true;
  s.hud = ui.showHud();
  s.minimap = UI.buildMinimap(visuals.layout);
  s.hud.setMinimap(s.minimap);
  s.hud.show();
  s.spectate = ui.showSpectate();
  s.spectate.hide();
  s.scoreboard = ui.showScoreboard();
  s.scoreboard.hide();
  s.input.attach();
  s.input.setEnabled(true);
  if (!isTouch) s.input.requestPointerLock();
  s.hud.banner(s.roomState?.mode === MODE_SND ? 'Search & Destroy' : 'Match starting', 3);
}

function togglePause(s: Session): void {
  if (!s.inMatch) return;
  s.paused = !s.paused;
  s.input.setEnabled(!s.paused);
  if (s.paused) {
    if (document.pointerLockElement) document.exitPointerLock();
    ui.setPauseMenu(true, {
      onResume: () => togglePause(s),
      onSettings: () => showSettings(() => { ui.setPauseMenu(true, { onResume: () => togglePause(s), onSettings: () => {}, onLeave: () => leaveSession() }); }),
      onLeave: () => leaveSession(),
    });
  } else {
    ui.setPauseMenu(false);
    if (!isTouch) s.input.requestPointerLock();
  }
}

function onSnapshot(s: Session, snap: Snapshot): void {
  if (!s.inMatch && snap.phase !== PHASE_LOBBY) enterMatch(s);
  s.remotes.onSnapshot(snap, s.localId);
  const local = s.predictor.local;
  const wasAlive = local?.alive ?? false;
  if (snap.local) {
    s.predictor.onAuthoritative(snap.local, snap.lastAckSeq);
    const p = s.predictor.local;
    if (p) {
      p.id = s.localId;
      p.name = settings.name;
    }
  }
  const nowLocal = s.predictor.local;
  if (nowLocal && nowLocal.alive && !wasAlive) {
    // Fresh spawn: align the look with the spawn yaw so the first frame does not jerk.
    s.input.setYawPitch(nowLocal.yaw, nowLocal.pitch);
    s.spectateTargetId = 0;
  }
  s.lastSnapshot = snap;
  for (const e of snap.events) handleEvent(s, e);
}

function playAt(buffer: AudioBuffer | null | undefined, pos: Vec3 | undefined, volume = 1): void {
  if (!buffer || !audio.isReady) return;
  audio.play(buffer, pos ? { pos, volume } : { volume });
}

function remotePosition(s: Session, id: number, out: Vec3): Vec3 | null {
  const local = s.predictor.local;
  if (id === s.localId && local) {
    out.x = local.pos.x; out.y = local.pos.y; out.z = local.pos.z;
    return out;
  }
  const rp = s.remotes.sample(s.net.localEstServerTick - INTERP_TICKS).get(id);
  if (!rp) return null;
  out.x = rp.pos.x; out.y = rp.pos.y; out.z = rp.pos.z;
  return out;
}

function handleEvent(s: Session, e: GameEvent): void {
  const v = visuals;
  const local = s.predictor.local;
  switch (e.type) {
    case EV_FIRE: {
      const isLocal = e.shooter === s.localId;
      const dist = local ? Math.hypot(e.origin.x - local.pos.x, e.origin.z - local.pos.z) : 30;
      if (!isLocal) {
        v.effects.muzzleFlash(e.origin, e.dir);
        v.characters.onEvent(e);
        guns?.fire(e.weapon, { pos: e.origin, distance: dist, local: false }, audio);
        s.revealed.set(e.shooter, MINIMAP_REVEAL_SECONDS);
      }
      scratchVec.x = e.origin.x + e.dir.x * 40; scratchVec.y = e.origin.y + e.dir.y * 40; scratchVec.z = e.origin.z + e.dir.z * 40;
      if (isLocal) v.viewmodel.muzzleWorldPos(scratchVec2); else { scratchVec2.x = e.origin.x; scratchVec2.y = e.origin.y - 0.1; scratchVec2.z = e.origin.z; }
      v.effects.tracer(scratchVec2, scratchVec, e.weapon);
      if (!isLocal) v.effects.casing(e.origin, e.dir);
      break;
    }
    case EV_HIT: {
      if (e.attacker === s.localId) {
        s.hud?.hitmarker(e.zone === ZONE_HEAD);
        playAt(guns?.hitmarker(e.zone === ZONE_HEAD), undefined, 0.7);
      }
      if (e.target === s.localId && local) {
        const from = remotePosition(s, e.attacker, scratchVec);
        if (from) {
          const dx = from.x - local.pos.x, dz = from.z - local.pos.z;
          // Angle of the attacker relative to the view yaw (0 = ahead, +right).
          const angle = Math.atan2(dx, -dz) - local.yaw;
          s.hud?.damageFrom(angle);
        }
        s.damageVignette = Math.min(1, s.damageVignette + e.damage / 60);
        v.cameraRig.shake(Math.min(0.6, e.damage / 100));
      } else {
        const at = remotePosition(s, e.target, scratchVec);
        if (at) { at.y += 1.2; v.effects.bloodPuff(at); }
      }
      v.characters.onEvent(e);
      break;
    }
    case EV_KILL: {
      v.characters.onEvent(e);
      if (e.victim === s.localId) {
        s.hud?.banner(e.killer === s.localId ? 'You died' : `Killed by ${nameOf(s, e.killer)}`, 2.5);
        s.spectateTargetId = 0;
      } else if (e.killer === s.localId) {
        s.hud?.banner(e.headshot ? 'HEADSHOT' : 'Eliminated ' + nameOf(s, e.victim), 1.5);
      }
      break;
    }
    case EV_IMPACT: {
      v.effects.impact(e.pos, e.normal, e.material);
      if (e.material !== MAT_FLESH) playAt(samples?.impact(e.material) ?? guns?.impactFallback(e.material), e.pos, 0.6);
      break;
    }
    case EV_EXPLODE: {
      if (e.kind === PROJ_FLASH) {
        v.effects.flashBang(e.pos);
        playAt(guns?.flashbang(), e.pos, 1);
      } else {
        v.effects.explosion(e.pos);
        playAt(guns?.explosion(), e.pos, 1);
        if (local) {
          const d = Math.hypot(e.pos.x - local.pos.x, e.pos.y - local.pos.y, e.pos.z - local.pos.z);
          if (d < 12) v.cameraRig.shake(1 - d / 12);
        }
      }
      break;
    }
    case EV_FLASHED: {
      if (e.victim === s.localId) {
        s.flashOverlay = Math.max(s.flashOverlay, e.strength);
        audio.flashDeafen(FLASH_DEAFEN_TIME * e.strength);
      }
      break;
    }
    case EV_PLANT: {
      s.hud?.banner(`Bomb planted at ${e.site === 0 ? 'A' : 'B'}`, 3);
      playAt(guns?.plantBeep(), undefined, 0.8);
      break;
    }
    case EV_DEFUSE: {
      s.hud?.banner('Bomb defused', 3);
      playAt(guns?.plantBeep(), undefined, 0.8);
      break;
    }
    case EV_ROUND: {
      if (e.state === ROUND_START) s.hud?.banner(`Round ${e.round}`, 2.5);
      else if (e.state === ROUND_END) {
        const mine = local && e.winner === local.team;
        s.hud?.banner(e.winner === TEAM_A || e.winner === TEAM_B ? (mine ? 'Round won' : 'Round lost') : 'Round over', 3);
      }
      break;
    }
    case EV_RESPAWN: {
      if (e.player === s.localId) s.hud?.setPrompt(null);
      break;
    }
    case EV_MELEE: {
      if (e.player !== s.localId) {
        const at = remotePosition(s, e.player, scratchVec);
        if (at) playAt(guns?.meleeSwing(), at, 0.7);
      }
      break;
    }
    case EV_RELOAD: {
      v.characters.onEvent(e);
      if (e.player !== s.localId) {
        const at = remotePosition(s, e.player, scratchVec);
        if (at) playAt(guns?.reloadClick('magOut'), at, 0.5);
      }
      break;
    }
    default:
      break;
  }
}

function nameOf(s: Session, id: number): string {
  return s.roomState?.players.find((p) => p.id === id)?.name ?? `Player ${id}`;
}

/** Runs once per 60 Hz input tick for the local player: sample, predict, send, react. */
function localTick(s: Session): void {
  const local = s.predictor.local;
  if (!local) return;
  const def = activeWeaponDef(local);
  s.seq++;
  const cmd = s.input.sample(s.seq, Math.floor(s.net.localEstServerTick), local.ads || local.adsT > 0.5, def.id === WEAPON_SNIPER);
  if (s.paused || !local.alive) {
    // Dead or paused: fire/ADS presses cycle the spectate target instead of driving the sim.
    const pressed = cmd.buttons & (BTN_FIRE | BTN_ADS);
    if (pressed && !(s.lastDeadButtons & (BTN_FIRE | BTN_ADS))) s.spectateCycle = true;
    s.lastDeadButtons = cmd.buttons;
    cmd.buttons = 0;
    cmd.moveX = 0;
    cmd.moveY = 0;
  } else {
    s.lastDeadButtons = 0;
  }
  s.predictor.pushInput(cmd);
  s.net.sendInput(s.predictor.pendingCmds(INPUT_REDUNDANCY));

  const we = s.predictor.weaponEvents;
  const me = s.predictor.movementEvents;
  const v = visuals;
  if (we.shots > 0) {
    guns?.fire(we.firedWeapon, { local: true }, audio);
    // Recoil is a view kick the player counteracts: apply it to the look, not the bullet.
    const kick = recoilAt(def, Math.max(0, local.shotIndex - 1), s.recoilRng);
    s.input.setYawPitch(s.input.yaw + kick.yaw, s.input.pitch + kick.pitch);
    const shell = v.viewmodel.getShellSpawnPoint();
    shell.getWorldPosition(scratchThree);
    scratchVec.x = scratchThree.x; scratchVec.y = scratchThree.y; scratchVec.z = scratchThree.z;
    v.cameraRig.getViewDirection(scratchVec2);
    // Eject to the right of the view direction.
    const rx = -scratchVec2.z, rz = scratchVec2.x;
    scratchVec2.x = rx * 0.6; scratchVec2.y = 0.4; scratchVec2.z = rz * 0.6;
    v.effects.casing(scratchVec, scratchVec2);
    if (settings.vibrate && isTouch && 'vibrate' in navigator) navigator.vibrate(8);
  }
  if (we.dryFire) playAt(guns?.dryFire(), undefined, 0.6);
  if (we.reloadStarted) playAt(guns?.reloadClick(def.shellReload ? 'shell' : 'magOut'), undefined, 0.7);
  if (we.reloadFinished) playAt(guns?.reloadClick(def.shellReload ? 'shell' : 'charge'), undefined, 0.7);
  if (we.swapped) playAt(guns?.reloadClick('magIn'), undefined, 0.5);
  if (we.meleeStarted) playAt(guns?.meleeSwing(), undefined, 0.8);
  if (we.cookStarted) playAt(guns?.grenadePin(), undefined, 0.7);
  if (me.footstepMaterial >= 0) {
    const stepBuf = samples?.footstep(me.footstepMaterial) ?? guns?.footstepFallback(me.footstepMaterial);
    playAt(stepBuf, undefined, local.moveState === MOVE_SLIDE ? 0.2 : 0.35);
  }
  if (me.landedSpeed > 2) playAt(samples?.footstep(local.groundMaterial) ?? guns?.footstepFallback(local.groundMaterial), undefined, 0.6);
  if (me.fallDamage > 0) s.damageVignette = Math.min(1, s.damageVignette + me.fallDamage / 60);
}

/** Footsteps for other players, derived from their interpolated motion. */
function remoteFootsteps(s: Session, remotes: Map<number, SnapshotPlayer>, dt: number): void {
  for (const [id, rp] of remotes) {
    let last = s.lastPos.get(id);
    if (!last) { last = vec3(rp.pos.x, rp.pos.y, rp.pos.z); s.lastPos.set(id, last); continue; }
    const d = Math.hypot(rp.pos.x - last.x, rp.pos.z - last.z);
    last.x = rp.pos.x; last.y = rp.pos.y; last.z = rp.pos.z;
    if (!rp.alive || rp.moveState === MOVE_AIR || rp.moveState === MOVE_DEAD || rp.moveState === MOVE_MOUNTED) continue;
    const acc = (s.stepDist.get(id) ?? 0) + d;
    if (acc >= 0.9) {
      s.stepDist.set(id, 0);
      const mat = visuals.colliders.materialAt(rp.pos.x, rp.pos.y, rp.pos.z);
      playAt(samples?.footstep(mat) ?? guns?.footstepFallback(mat), rp.pos, 0.5);
    } else {
      s.stepDist.set(id, acc);
    }
  }
  void dt;
}

function pickSpectateTarget(s: Session, remotes: Map<number, SnapshotPlayer>, cycle: boolean): SnapshotPlayer | null {
  const local = s.predictor.local;
  const team = local?.team ?? s.net.welcome.teamId;
  const candidates: SnapshotPlayer[] = [];
  for (const rp of remotes.values()) if (rp.alive && (rp.team === team || team === 0)) candidates.push(rp);
  if (candidates.length === 0) for (const rp of remotes.values()) if (rp.alive) candidates.push(rp);
  if (candidates.length === 0) return null;
  let idx = candidates.findIndex((c) => c.id === s.spectateTargetId);
  if (idx < 0) idx = 0;
  else if (cycle) idx = (idx + 1) % candidates.length;
  s.spectateTargetId = candidates[idx]!.id;
  return candidates[idx]!;
}

function updateObjectivePrompt(s: Session, local: PlayerState): void {
  const room = s.roomState;
  if (!room || room.mode !== MODE_SND || room.phase !== PHASE_LIVE || !local.alive) { s.hud?.setPrompt(null); return; }
  const sites = visuals.layout.sites;
  if (room.bombState === BOMB_PLANTED) {
    const site = sites[room.bombSite];
    if (site && room.bombCarrier !== s.localId && Math.hypot(site.x - local.pos.x, site.z - local.pos.z) < SND_SITE_RADIUS + 1) {
      s.hud?.setPrompt('DEFUSE');
      return;
    }
  } else if (room.bombCarrier === s.localId) {
    for (const site of sites) {
      if (Math.hypot(site.x - local.pos.x, site.z - local.pos.z) < SND_SITE_RADIUS) { s.hud?.setPrompt('PLANT'); return; }
    }
  }
  s.hud?.setPrompt(local.moveState === MOVE_MOUNTED ? 'MOUNT' : null);
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
let lastFrame = 0;
let portrait = false;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, lastFrame ? (now - lastFrame) / 1000 : TICK_DT);
  lastFrame = now;
  const s = session;
  const v = visuals;

  if (isTouch) {
    const isPortrait = window.innerHeight > window.innerWidth;
    if (isPortrait !== portrait) { portrait = isPortrait; ui.showRotatePrompt(isPortrait); }
  }

  if (!s || !s.inMatch) {
    // Idle background: slow orbit over the map behind the menus.
    const t = now / 1000;
    v.renderer.camera.position.set(Math.cos(t * 0.05) * 40, 18, Math.sin(t * 0.05) * 40);
    v.renderer.camera.lookAt(0, 2, 0);
    v.lighting.update(v.renderer.camera.position);
    v.effects.update(dt, ZERO);
    v.renderer.render();
    return;
  }

  s.net.advance(now);

  // Fixed 60 Hz input cadence, independent of the display refresh rate.
  s.inputAccum += dt;
  let ticks = 0;
  while (s.inputAccum >= TICK_DT && ticks < 4) {
    s.inputAccum -= TICK_DT;
    ticks++;
    localTick(s);
  }
  if (s.inputAccum > TICK_DT * 4) s.inputAccum = 0;
  s.predictor.update(dt);

  const renderTick = s.net.localEstServerTick - INTERP_TICKS;
  const remotes = s.remotes.sample(renderTick);
  const local = s.predictor.local;

  // Camera: first person when alive, spectate a teammate otherwise.
  let camState: PlayerState | null = null;
  let spectating = false;
  if (local && local.alive) {
    // Smooth look between input ticks: yaw/pitch are client-authoritative.
    local.yaw = s.input['yaw'];
    local.pitch = s.input['pitch'];
    camState = local;
  } else {
    spectating = true;
    // Smooth look while dead so the spectate cycle presses feel responsive.
    if (local) { local.yaw = s.input.yaw; local.pitch = s.input.pitch; }
    const cycle = s.spectateCycle;
    s.spectateCycle = false;
    const target = pickSpectateTarget(s, remotes, cycle);
    if (target) {
      spectateState.pos.x = target.pos.x; spectateState.pos.y = target.pos.y; spectateState.pos.z = target.pos.z;
      spectateState.yaw = target.yaw; spectateState.pitch = target.pitch;
      spectateState.stance = target.stance; spectateState.stanceT = 1; spectateState.moveState = target.moveState;
      spectateState.alive = true; spectateState.adsT = 0; spectateState.ads = false;
      camState = spectateState;
      s.spectate?.setTarget(nameOf(s, target.id), target.health);
    } else if (local) {
      camState = local;
    }
  }
  if (spectating) s.spectate?.show(); else s.spectate?.hide();

  if (camState) {
    v.cameraRig.update(camState, spectating ? ZERO : s.predictor.renderOffset, dt);
  }
  v.cameraRig.getPosition(scratchVec);
  scratchThree.set(scratchVec.x, scratchVec.y, scratchVec.z);

  // Viewmodel only for the living local player.
  const showViewmodel = !!local && local.alive;
  v.renderer.vmScene.visible = showViewmodel;
  if (local && showViewmodel) {
    v.viewmodel.setWeapon(local.slots[local.activeSlot]!.weapon);
    v.viewmodel.update(local, s.predictor.weaponEvents, s.predictor.movementEvents, dt);
  }

  v.characters.update(remotes, s.localId, scratchVec, dt);
  remoteFootsteps(s, remotes, dt);
  v.effects.update(dt, scratchVec);
  v.lighting.update(scratchThree);

  // Audio listener follows the camera.
  const yaw = camState ? camState.yaw : 0;
  const pitch = camState ? camState.pitch : 0;
  audio.setListener(scratchVec, yaw, pitch);

  // Post-processing state: damage and flash.
  s.damageVignette = Math.max(0, s.damageVignette - dt * 1.5);
  if (local && local.flashT > 0) {
    const total = FLASH_BLIND_TIME + FLASH_FADE_TIME;
    s.flashOverlay = Math.min(1, local.flashT / total * 1.6) * Math.max(0.3, local.flashStrength);
  } else {
    s.flashOverlay = Math.max(0, s.flashOverlay - dt * 1.2);
  }
  v.renderer.grade.damage = s.damageVignette + (local && local.alive && local.health < 35 ? (35 - local.health) / 35 * 0.5 : 0);
  v.renderer.grade.flash = s.flashOverlay;
  s.hud?.flash(s.flashOverlay);

  // HUD.
  const hud = s.hud;
  if (hud) {
    hud.update(local, s.lastSnapshot, s.roomState, s.net.rtt, s.net.stalled, dt);
    hud.showScope(v.viewmodel.scopeVisible);
    if (local && local.alive) {
      updateObjectivePrompt(s, local);
      hud.setSpread(6 + (local.adsT > 0.5 ? 0 : 10) + Math.min(24, Math.hypot(local.vel.x, local.vel.z) * 2));
    }
    for (const [id, t] of s.revealed) { const left = t - dt; if (left <= 0) s.revealed.delete(id); else s.revealed.set(id, left); }
    if (s.minimap && camState) {
      const revealedIds = new Set(s.revealed.keys());
      const bombPos: Vec3 | null = s.roomState && s.roomState.bombState === BOMB_PLANTED ? (() => { const site = v.layout.sites[s.roomState!.bombSite]; return site ? vec3(site.x, site.y, site.z) : null; })() : null;
      const all: SnapshotPlayer[] = Array.from(remotes.values());
      s.minimap.update(camState.pos, camState.yaw, all, s.localId, local?.team ?? 0, revealedIds, v.layout.sites, bombPos);
    }
  }

  // Scoreboard on hold.
  const wantScoreboard = s.input.scoreboardHeld && !s.paused;
  if (wantScoreboard !== s.scoreboardShown) {
    s.scoreboardShown = wantScoreboard;
    if (wantScoreboard) { if (s.roomState) s.scoreboard?.update(s.roomState, s.localId); s.scoreboard?.show(); } else s.scoreboard?.hide();
  }

  // Auto quality: sustained slow frames drop the resolution scale.
  if (v.renderer.lastFrameMs > 20) s.lowFrameTime += dt; else s.lowFrameTime = Math.max(0, s.lowFrameTime - dt * 0.5);
  if (s.lowFrameTime > 2 && s.resolutionScale > 0.5) {
    s.resolutionScale = Math.max(0.5, s.resolutionScale - 0.1);
    v.renderer.setResolutionScale(s.resolutionScale);
    s.lowFrameTime = 0;
  }

  v.renderer.render();
}

// ---------------------------------------------------------------------------
// Backgrounding: iOS drops sockets and peer connections when the tab hides.
// ---------------------------------------------------------------------------
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    void audio.suspend();
    if (session?.inMatch && !session.paused) togglePause(session);
  } else {
    void audio.resume();
    const s = session;
    if (s && s.net.kind !== 'local') scheduleReconnect(s);
  }
});

window.addEventListener('beforeunload', () => {
  session?.net.close();
  session?.localHost?.stop();
  session?.peerHost?.stop();
});

void boot().catch((err: unknown) => {
  console.error(err);
});

// Exposed for browser automation and debugging.
declare global {
  interface Window { tfps: { session: () => Session | null; app: AppState; settings: Settings } }
}
window.tfps = { session: () => session, app, settings };
