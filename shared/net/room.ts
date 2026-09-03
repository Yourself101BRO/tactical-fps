// Transport-agnostic match host. One Room per game: it owns the World, the
// ModeRules, the bot brains and every connected player's slot, and drives the
// fixed 60 Hz tick from whatever clock its owner has (server setTimeout loop,
// browser rAF, or a test harness). Pure TypeScript: the only "clock" it knows
// is the nowMs handed to update() — no Date.now(), no Math.random().
//
// LOBBY_CMD.value encoding (LobbyCmd only carries a single u8 `value`, so
// SET_TEAM needs to pack both a target player id and a team into it — this is
// a Room-local convention, not part of protocol.ts, documented here for the
// client that must encode it the same way):
//   value = ((targetPlayerId & 0x3f) << 2) | (team & 0x3)
// KICK's value is simply the target player id.

import {
  BTN_ALL,
  CONN_ACTIVE,
  CONN_DISCONNECTED,
  ERR_BAD_NAME,
  ERR_BAD_VERSION,
  ERR_KICKED,
  ERR_ROOM_FULL,
  HEALTH_MAX,
  LOBBY_BACK_TO_LOBBY,
  LOBBY_KICK,
  LOBBY_SET_BOTS,
  LOBBY_SET_BOT_DIFFICULTY,
  LOBBY_SET_MODE,
  LOBBY_SET_TEAM,
  LOBBY_START,
  MATCH_END_SECONDS,
  MAX_CHAT_LEN,
  MAX_INPUT_MSGS_PER_SEC,
  MAX_NAME_LEN,
  MAX_PLAYERS,
  PHASE_LOBBY,
  PROTOCOL_VERSION,
  REJOIN_GRACE_MS,
  ROOM_STATE_INTERVAL_TICKS,
  SLOT_PRIMARY,
  SLOT_SECONDARY,
  SNAPSHOT_EVERY,
  TEAM_A,
  TEAM_B,
  TICK_DT,
} from '../constants.ts';
import { decodeMessage, encodeChat, encodeError, encodeMatchEnd, encodePong, encodeRoomState, encodeSnapshot, encodeWelcome } from '../protocol.ts';
import { defaultLoadout } from '../types.ts';
import type { ChatMsg, InputCmd, LobbyCmd, LobbyPlayer, Loadout, PlayerState, RoomState } from '../types.ts';
import type { Transport } from './transport.ts';
import { World } from '../sim/world.ts';
import { createRules } from '../sim/modes.ts';
import type { ModeRules } from '../sim/types.ts';
import { BotBrain, botName } from '../sim/bots.ts';
import { getMapLayout } from '../map/layout.ts';

export interface RoomOptions {
  code: string;
  mode: number;
  mapId: number;
  botCount: number;
  botDifficulty: number;
  seed: number;
}

interface Conn {
  transport: Transport;
  playerId: number;
  /** Timestamps (Room.nowMs) of INPUT messages received in roughly the last second. */
  inputTimes: number[];
}

const clamp01 = (v: number): number => Math.max(-1, Math.min(1, v));

export class Room {
  readonly code: string;
  readonly world: World;
  /** Mutable so LOBBY_SET_MODE and the post-match reset can swap it out. */
  rules: ModeRules;
  hostId = 0;
  onEmpty: () => void = () => {};

  private readonly mapId: number;
  private botDifficulty: number;
  private readonly seed: number;
  private readonly bots = new Map<number, BotBrain>();
  private readonly conns = new Map<number, Conn>();
  /** playerId -> nowMs deadline by which a rejoin must arrive. */
  private readonly disconnectDeadlines = new Map<number, number>();
  private readonly kickedIds = new Set<number>();

  private nowMs = 0;
  private lastUpdateMs: number | null = null;
  private accumulatorMs = 0;
  private matchEndSent = false;
  private matchEndAtTick = 0;
  private emptyFired = false;
  private closed = false;

  constructor(opts: RoomOptions) {
    this.code = opts.code;
    this.mapId = opts.mapId;
    this.botDifficulty = opts.botDifficulty;
    this.seed = opts.seed;
    this.world = new World(getMapLayout(opts.mapId), opts.seed);
    this.rules = createRules(opts.mode);
    this.world.rules = this.rules;
    for (let i = 0; i < opts.botCount; i++) this.addBot();
  }

  get playerCount(): number {
    return this.world.players.size;
  }

  get humanCount(): number {
    let n = 0;
    for (const p of this.world.players.values()) if (!p.isBot) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Transport lifecycle
  // -------------------------------------------------------------------------

  /**
   * Wire a new connection into this room. If `helloFrame` is given (the raw
   * frame the caller already peeked to route to this room), it is processed
   * immediately; otherwise the room waits for the transport's first message
   * to be a HELLO.
   */
  attach(transport: Transport, helloFrame?: Uint8Array): void {
    transport.onMessage = (data) => this.handlePreHello(transport, data);
    transport.onClose = () => {}; // no player yet; nothing to clean up
    if (helloFrame) this.handlePreHello(transport, helloFrame);
  }

  detach(transport: Transport): void {
    for (const [id, conn] of this.conns) {
      if (conn.transport === transport) {
        transport.onMessage = () => {};
        transport.onClose = () => {};
        this.conns.delete(id);
        return;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const conn of this.conns.values()) {
      conn.transport.onMessage = () => {};
      conn.transport.onClose = () => {};
      conn.transport.close();
    }
    this.conns.clear();
  }

  private handlePreHello(transport: Transport, data: Uint8Array): void {
    const msg = decodeMessage(data);
    if (!msg || msg.kind !== 'hello') {
      transport.send(encodeError(ERR_BAD_VERSION, 'expected HELLO'));
      transport.close();
      return;
    }
    const hello = msg.hello;
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      transport.send(encodeError(ERR_BAD_VERSION, 'unsupported protocol version'));
      transport.close();
      return;
    }
    const name = hello.name.trim().slice(0, MAX_NAME_LEN);
    if (name.length === 0) {
      transport.send(encodeError(ERR_BAD_NAME, 'name required'));
      transport.close();
      return;
    }

    // Rejoin: same id, same PlayerState, if it's still held and within grace.
    if (hello.rejoinId > 0) {
      const deadline = this.disconnectDeadlines.get(hello.rejoinId);
      const player = this.world.players.get(hello.rejoinId);
      if (deadline !== undefined && deadline >= this.nowMs && player && !player.isBot) {
        this.disconnectDeadlines.delete(hello.rejoinId);
        player.connState = CONN_ACTIVE;
        this.completeJoin(transport, player.id, player);
        return;
      }
    }

    if (this.world.players.size >= MAX_PLAYERS) {
      if (!this.dropOneBot()) {
        transport.send(encodeError(ERR_ROOM_FULL, 'room is full'));
        transport.close();
        return;
      }
    }

    const id = this.allocateId();
    if (id === 0) {
      transport.send(encodeError(ERR_ROOM_FULL, 'room is full'));
      transport.close();
      return;
    }
    const team = this.rules.assignTeam(this.world);
    const player = this.world.addPlayer(id, name, team, false, defaultLoadout());
    this.rules.onPlayerJoin(this.world, player);
    if (this.hostId === 0) this.hostId = id;
    this.completeJoin(transport, id, player);
  }

  private completeJoin(transport: Transport, playerId: number, player: PlayerState): void {
    const conn: Conn = { transport, playerId, inputTimes: [] };
    this.conns.set(playerId, conn);
    transport.onMessage = (data) => this.handleMessage(playerId, data);
    transport.onClose = () => this.handleDisconnect(playerId);
    transport.send(encodeWelcome({
      playerId,
      serverTick: this.world.tick,
      roomCode: this.code,
      mode: this.rules.mode,
      mapId: this.mapId,
      teamId: player.team,
      connState: player.connState,
    }));
    this.broadcastRoomState();
  }

  private handleDisconnect(playerId: number): void {
    if (!this.conns.has(playerId)) return;
    this.conns.delete(playerId);
    const kicked = this.kickedIds.delete(playerId);
    const player = this.world.players.get(playerId);
    if (kicked || !player) {
      this.removePlayerFully(playerId);
    } else {
      player.connState = CONN_DISCONNECTED;
      this.disconnectDeadlines.set(playerId, this.nowMs + REJOIN_GRACE_MS);
      if (playerId === this.hostId) this.reassignHost();
      this.broadcastRoomState();
    }
  }

  private removePlayerFully(playerId: number): void {
    const player = this.world.players.get(playerId);
    this.disconnectDeadlines.delete(playerId);
    this.world.removePlayer(playerId);
    if (player) this.rules.onPlayerLeave(this.world, player);
    if (playerId === this.hostId) this.reassignHost();
    this.checkEmpty();
    this.broadcastRoomState();
  }

  private reassignHost(): void {
    let newHost = 0;
    for (const p of this.world.players.values()) {
      if (!p.isBot && p.connState !== CONN_DISCONNECTED) {
        if (newHost === 0 || p.id < newHost) newHost = p.id;
      }
    }
    this.hostId = newHost;
  }

  private checkEmpty(): void {
    if (this.emptyFired) return;
    for (const p of this.world.players.values()) if (!p.isBot) return;
    this.emptyFired = true;
    this.onEmpty();
  }

  // -------------------------------------------------------------------------
  // Bots
  // -------------------------------------------------------------------------

  private allocateId(): number {
    for (let id = 1; id <= MAX_PLAYERS; id++) if (!this.world.players.has(id)) return id;
    return 0;
  }

  private addBot(): boolean {
    const id = this.allocateId();
    if (id === 0) return false;
    const team = this.rules.assignTeam(this.world);
    const player = this.world.addPlayer(id, botName(id), team, true, defaultLoadout());
    this.rules.onPlayerJoin(this.world, player);
    // Deterministic per-bot seed derived from the room seed; no Math.random.
    this.bots.set(id, new BotBrain(id, this.botDifficulty, (this.seed + id * 7919) >>> 0));
    return true;
  }

  private removeBot(id: number): void {
    const player = this.world.players.get(id);
    this.bots.delete(id);
    this.world.removePlayer(id);
    if (player) this.rules.onPlayerLeave(this.world, player);
  }

  /** Drop the lowest-id bot to free a slot for a joining human. */
  private dropOneBot(): boolean {
    for (const id of this.bots.keys()) {
      this.removeBot(id);
      return true;
    }
    return false;
  }

  private setBotCount(desired: number): void {
    const target = Math.max(0, Math.min(MAX_PLAYERS - 1, Math.floor(desired)));
    while (this.bots.size > target) {
      const first = this.bots.keys().next();
      if (first.done) break;
      this.removeBot(first.value);
    }
    while (this.bots.size < target) {
      if (!this.addBot()) break;
    }
  }

  private setBotDifficulty(difficulty: number): void {
    this.botDifficulty = difficulty;
    for (const id of this.bots.keys()) {
      this.bots.set(id, new BotBrain(id, difficulty, (this.seed + id * 7919) >>> 0));
    }
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private handleMessage(playerId: number, data: Uint8Array): void {
    if (!this.conns.has(playerId)) return;
    const msg = decodeMessage(data);
    if (!msg) return;
    switch (msg.kind) {
      case 'input': this.handleInput(playerId, msg.cmds); break;
      case 'ping': {
        const conn = this.conns.get(playerId);
        if (conn) conn.transport.send(encodePong(msg.clientTimeMs, this.world.tick));
        break;
      }
      case 'loadout': this.world.setLoadout(playerId, msg.loadout); break;
      case 'chat': this.handleChat(playerId, msg.chat); break;
      case 'lobbyCmd': this.handleLobbyCmd(playerId, msg.cmd); break;
      default: break;
    }
  }

  private handleInput(playerId: number, cmds: InputCmd[]): void {
    const conn = this.conns.get(playerId);
    if (!conn) return;
    conn.inputTimes.push(this.nowMs);
    const cutoff = this.nowMs - 1000;
    while (conn.inputTimes.length > 0 && conn.inputTimes[0]! < cutoff) conn.inputTimes.shift();
    if (conn.inputTimes.length > MAX_INPUT_MSGS_PER_SEC) return; // rate-limited: drop silently

    for (const cmd of cmds) {
      cmd.moveX = clamp01(cmd.moveX);
      cmd.moveY = clamp01(cmd.moveY);
      cmd.buttons = cmd.buttons & BTN_ALL;
      cmd.weaponSlot = cmd.weaponSlot === SLOT_SECONDARY ? SLOT_SECONDARY : SLOT_PRIMARY;
      this.world.applyInput(playerId, cmd);
    }
  }

  private handleChat(playerId: number, chat: ChatMsg): void {
    if (this.rules.phase !== PHASE_LOBBY) return;
    const text = chat.text.slice(0, MAX_CHAT_LEN);
    const bytes = encodeChat({ from: playerId, text });
    for (const conn of this.conns.values()) conn.transport.send(bytes);
  }

  private handleLobbyCmd(playerId: number, cmd: LobbyCmd): void {
    if (playerId !== this.hostId) return;
    switch (cmd.action) {
      case LOBBY_START:
        if (this.rules.phase === PHASE_LOBBY) this.rules.start(this.world);
        break;
      case LOBBY_SET_MODE:
        if (this.rules.phase === PHASE_LOBBY) {
          this.rules = createRules(cmd.value);
          this.world.rules = this.rules;
        }
        break;
      case LOBBY_SET_BOTS:
        this.setBotCount(cmd.value);
        break;
      case LOBBY_SET_BOT_DIFFICULTY:
        this.setBotDifficulty(cmd.value);
        break;
      case LOBBY_SET_TEAM: {
        const targetId = (cmd.value >> 2) & 0x3f;
        const team = (cmd.value & 0x3) === TEAM_B ? TEAM_B : TEAM_A;
        const target = this.world.players.get(targetId);
        if (target) target.team = team;
        break;
      }
      case LOBBY_KICK:
        this.kickPlayer(cmd.value);
        break;
      case LOBBY_BACK_TO_LOBBY:
        this.returnToLobby();
        break;
      default:
        break;
    }
    this.broadcastRoomState();
  }

  private kickPlayer(targetId: number): void {
    const conn = this.conns.get(targetId);
    if (conn) {
      this.kickedIds.add(targetId);
      conn.transport.send(encodeError(ERR_KICKED, 'kicked by host'));
      conn.transport.close();
      return;
    }
    if (this.bots.has(targetId)) this.removeBot(targetId);
  }

  // -------------------------------------------------------------------------
  // Simulation loop
  // -------------------------------------------------------------------------

  /** Runs any due ticks with a drift-corrected accumulator, capped per call. */
  update(nowMs: number): void {
    this.nowMs = nowMs;
    this.expireDisconnected();
    if (this.lastUpdateMs === null) this.lastUpdateMs = nowMs;
    this.accumulatorMs += nowMs - this.lastUpdateMs;
    this.lastUpdateMs = nowMs;
    const stepMs = TICK_DT * 1000;
    // Avoid unbounded catch-up growth if the host stalls (e.g. GC pause, debugger).
    this.accumulatorMs = Math.min(this.accumulatorMs, stepMs * 4);
    let ticks = 0;
    while (this.accumulatorMs >= stepMs && ticks < 4) {
      this.tickOnce();
      this.accumulatorMs -= stepMs;
      ticks++;
    }
  }

  private expireDisconnected(): void {
    for (const [id, deadline] of this.disconnectDeadlines) {
      if (deadline < this.nowMs) this.removePlayerFully(id);
    }
  }

  /** Advances the simulation by exactly one tick and broadcasts as due. */
  tickOnce(): void {
    for (const [id, bot] of this.bots) {
      const player = this.world.players.get(id);
      if (!player) continue;
      const cmd = bot.think(this.world, this.rules, this.world.tick);
      this.world.applyInput(id, cmd);
    }

    this.world.step(TICK_DT);
    this.rules.tick(this.world, TICK_DT);

    for (const p of this.world.players.values()) {
      if (p.isBot) { p.ping = 0; continue; }
      p.ping = Math.max(0, Math.min(255, Math.round((this.world.tick - p.lastInputTick) * TICK_DT * 1000)));
    }

    if (this.world.tick % SNAPSHOT_EVERY === 0) {
      this.broadcastSnapshots();
      this.world.clearEvents();
    }
    if (this.world.tick % ROOM_STATE_INTERVAL_TICKS === 0) this.broadcastRoomState();

    if (this.rules.finished && !this.matchEndSent) {
      this.matchEndSent = true;
      this.matchEndAtTick = this.world.tick;
      this.broadcastMatchEnd();
    }
    if (this.matchEndSent) {
      const elapsedTicks = this.world.tick - this.matchEndAtTick;
      if (elapsedTicks >= Math.round(MATCH_END_SECONDS / TICK_DT)) this.returnToLobby();
    }
  }

  private returnToLobby(): void {
    this.rules = createRules(this.rules.mode);
    this.world.rules = this.rules;
    this.matchEndSent = false;
    for (const p of this.world.players.values()) {
      p.kills = 0; p.deaths = 0; p.assists = 0; p.score = 0;
      p.alive = false; p.health = HEALTH_MAX;
      if (p.connState !== CONN_DISCONNECTED) p.connState = CONN_ACTIVE;
    }
    this.broadcastRoomState();
  }

  private broadcastSnapshots(): void {
    for (const [id, conn] of this.conns) {
      const player = this.world.players.get(id);
      const snap = this.world.snapshotFor(id);
      snap.phase = this.rules.phase;
      snap.timeLeft = this.rules.timeLeft;
      snap.scores = this.rules.scores;
      snap.bombState = this.rules.bomb.state;
      snap.bombTimer = this.rules.bomb.timer;
      snap.lastAckSeq = player ? player.lastAppliedSeq : 0;
      conn.transport.send(encodeSnapshot(snap));
    }
  }

  private broadcastMatchEnd(): void {
    const bytes = encodeMatchEnd(this.rules.result(this.world));
    for (const conn of this.conns.values()) conn.transport.send(bytes);
  }

  private broadcastRoomState(): void {
    const bytes = encodeRoomState(this.state());
    for (const conn of this.conns.values()) conn.transport.send(bytes);
  }

  // -------------------------------------------------------------------------
  // Snapshots of room state
  // -------------------------------------------------------------------------

  state(): RoomState {
    const players: LobbyPlayer[] = [];
    for (const p of this.world.players.values()) {
      const loadout: Loadout = {
        primary: p.slots[SLOT_PRIMARY]!.weapon,
        secondary: p.slots[SLOT_SECONDARY]!.weapon,
        lethal: p.lethal,
        tactical: p.tactical,
        perk1: p.perks[0],
        perk2: p.perks[1],
      };
      players.push({
        id: p.id, team: p.team, name: p.name, kills: p.kills, deaths: p.deaths, score: p.score,
        ping: p.ping, isBot: p.isBot, connState: p.connState, loadout,
      });
    }
    return {
      code: this.code,
      phase: this.rules.phase,
      mode: this.rules.mode,
      mapId: this.mapId,
      hostId: this.hostId,
      round: this.rules.round,
      roundsWon: this.rules.roundsWon,
      timeLeft: this.rules.timeLeft,
      players,
      bombState: this.rules.bomb.state,
      bombSite: this.rules.bomb.site,
      bombTimer: this.rules.bomb.timer,
      bombCarrier: this.rules.bomb.carrier,
      botCount: this.bots.size,
      botDifficulty: this.botDifficulty,
      maxPlayers: MAX_PLAYERS,
    };
  }

  /** Public entry point equivalent to a host LOBBY_START, for tests and solo play. */
  start(): void {
    if (this.rules.phase === PHASE_LOBBY) this.rules.start(this.world);
    this.broadcastRoomState();
  }
}
