// W0 smoke test: the contract modules load under Node's type stripping and the
// protocol round-trips every message. Later waves extend tests/ with real suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BTN_FIRE,
  BTN_SPRINT,
  CONN_ACTIVE,
  EV_FIRE,
  EV_HIT,
  EV_KILL,
  EV_ROUND,
  MAX_PLAYERS,
  MODE_TDM,
  MOVE_SPRINT,
  PHASE_LIVE,
  PROTOCOL_VERSION,
  STANCE_CROUCH,
  TEAM_A,
  TEAM_B,
  TICK_DT,
  TICK_RATE,
  WEAPON_SMG,
} from '../shared/constants.ts';
import {
  createInputCmd,
  createPlayerState,
  createProjectileState,
  createSnapshot,
  createSnapshotPlayer,
  defaultLoadout,
  vec3,
} from '../shared/types.ts';
import type { RoomState, Snapshot } from '../shared/types.ts';
import {
  decodeMessage,
  encodeHello,
  encodeInput,
  encodeLoadout,
  encodeMatchEnd,
  encodePing,
  encodePong,
  encodeRoomState,
  encodeSnapshot,
  encodeWelcome,
  encodeChat,
  encodeError,
  encodeLobbyCmd,
  peekMessageId,
  MSG_SNAPSHOT,
  SNAPSHOT_PLAYER_BYTES,
} from '../shared/protocol.ts';
import { LocalTransport } from '../shared/net/transport.ts';

test('constants are consistent', () => {
  assert.equal(TICK_RATE, 60);
  assert.ok(Math.abs(TICK_DT * TICK_RATE - 1) < 1e-9);
  assert.equal(MAX_PLAYERS, 12);
});

test('hello / welcome / loadout / ping / pong / chat / lobby / error round-trip', () => {
  const hello = decodeMessage(encodeHello({ protocolVersion: PROTOCOL_VERSION, name: 'Séb 🙂', roomCode: 'AB2C', mode: MODE_TDM, wantBots: 5, rejoinId: 0 }));
  assert.equal(hello?.kind, 'hello');
  if (hello?.kind === 'hello') {
    assert.equal(hello.hello.name, 'Séb 🙂');
    assert.equal(hello.hello.roomCode, 'AB2C');
    assert.equal(hello.hello.mode, MODE_TDM);
    assert.equal(hello.hello.wantBots, 5);
  }
  const welcome = decodeMessage(encodeWelcome({ playerId: 3, serverTick: 123456, roomCode: 'ZZ99', mode: MODE_TDM, mapId: 0, teamId: TEAM_B, connState: CONN_ACTIVE }));
  assert.equal(welcome?.kind, 'welcome');
  if (welcome?.kind === 'welcome') {
    assert.equal(welcome.welcome.serverTick, 123456);
    assert.equal(welcome.welcome.roomCode, 'ZZ99');
    assert.equal(welcome.welcome.teamId, TEAM_B);
  }
  const lo = defaultLoadout();
  lo.primary = WEAPON_SMG;
  lo.perk2 = 4;
  const loadout = decodeMessage(encodeLoadout(lo));
  assert.equal(loadout?.kind, 'loadout');
  if (loadout?.kind === 'loadout') assert.deepEqual(loadout.loadout, lo);

  const ping = decodeMessage(encodePing(4242));
  assert.deepEqual(ping, { kind: 'ping', clientTimeMs: 4242 });
  const pong = decodeMessage(encodePong(4242, 99));
  assert.deepEqual(pong, { kind: 'pong', clientTimeMs: 4242, serverTick: 99 });
  const chat = decodeMessage(encodeChat({ from: 2, text: 'gg' }));
  assert.deepEqual(chat, { kind: 'chat', chat: { from: 2, text: 'gg' } });
  const lobby = decodeMessage(encodeLobbyCmd({ action: 2, value: 7 }));
  assert.deepEqual(lobby, { kind: 'lobbyCmd', cmd: { action: 2, value: 7 } });
  const err = decodeMessage(encodeError(3, 'room not found'));
  assert.deepEqual(err, { kind: 'error', code: 3, message: 'room not found' });
});

test('input round-trip keeps seq/tick exactly and axes/angles within quantization', () => {
  const a = createInputCmd();
  a.seq = 4_000_000_001;
  a.tick = 77;
  a.moveX = -0.5;
  a.moveY = 1;
  a.yaw = 5.5;
  a.pitch = -0.7;
  a.buttons = BTN_FIRE | BTN_SPRINT;
  a.weaponSlot = 1;
  const b = createInputCmd();
  b.seq = 4_000_000_002;
  b.tick = 78;
  const m = decodeMessage(encodeInput([a, b]));
  assert.equal(m?.kind, 'input');
  if (m?.kind === 'input') {
    assert.equal(m.cmds.length, 2);
    const c = m.cmds[0]!;
    assert.equal(c.seq, 4_000_000_001);
    assert.equal(c.tick, 77);
    assert.ok(Math.abs(c.moveX + 0.5) < 0.01);
    assert.ok(Math.abs(c.moveY - 1) < 0.01);
    assert.ok(Math.abs(c.yaw - 5.5) < 0.001);
    assert.ok(Math.abs(c.pitch + 0.7) < 0.001);
    assert.equal(c.buttons, BTN_FIRE | BTN_SPRINT);
    assert.equal(c.weaponSlot, 1);
    assert.equal(m.cmds[1]!.seq, 4_000_000_002);
  }
});

test('12-player snapshot with local block round-trips and stays under 900 bytes without events', () => {
  const s: Snapshot = createSnapshot();
  s.tick = 600;
  s.lastAckSeq = 55;
  s.phase = PHASE_LIVE;
  s.timeLeft = 123.4;
  s.scores = [12, -3];
  s.bombState = 3;
  s.bombTimer = 44.4;
  for (let i = 0; i < 12; i++) {
    const p = createSnapshotPlayer();
    p.id = i + 1;
    p.team = i % 2 ? TEAM_A : TEAM_B;
    p.alive = i !== 3;
    p.stance = STANCE_CROUCH;
    p.moveState = MOVE_SPRINT;
    p.ads = i % 2 === 0;
    p.isBot = i > 5;
    p.pos = vec3(1.5 * i, 0.25, -3 * i);
    p.vel = vec3(-2.5, 0, 6.2);
    p.yaw = 1.234;
    p.pitch = -0.4;
    p.health = 100 - i;
    p.weapon = WEAPON_SMG;
    p.mag = 32;
    p.reserve = 160;
    p.animId = 2;
    s.players.push(p);
  }
  const g = createProjectileState(9, 0, 1, TEAM_A);
  g.pos = vec3(1, 2, 3);
  g.vel = vec3(4, 5, -6);
  g.fuse = 2.5;
  s.projectiles.push(g);
  const local = createPlayerState(1, 'me', TEAM_A);
  local.pos = vec3(1, 2, 3);
  local.slots[0]!.mag = 17;
  local.slots[0]!.reserve = 90;
  local.reloadT = 0.75;
  local.shotIndex = 5;
  local.lastFireTick = 599;
  local.perks = [1, 6];
  s.local = local;

  const bytes = encodeSnapshot(s);
  assert.equal(peekMessageId(bytes), MSG_SNAPSHOT);
  assert.ok(bytes.byteLength < 900, `snapshot is ${bytes.byteLength} bytes`);
  assert.ok(bytes.byteLength > 12 * SNAPSHOT_PLAYER_BYTES);

  const m = decodeMessage(bytes);
  assert.equal(m?.kind, 'snapshot');
  if (m?.kind !== 'snapshot') return;
  const d = m.snapshot;
  assert.equal(d.tick, 600);
  assert.equal(d.lastAckSeq, 55);
  assert.equal(d.phase, PHASE_LIVE);
  assert.ok(Math.abs(d.timeLeft - 123.4) < 0.06);
  assert.deepEqual(d.scores, [12, -3]);
  assert.equal(d.bombState, 3);
  assert.equal(d.players.length, 12);
  const p3 = d.players[3]!;
  assert.equal(p3.id, 4);
  assert.equal(p3.alive, false);
  assert.equal(p3.stance, STANCE_CROUCH);
  assert.equal(p3.moveState, MOVE_SPRINT);
  assert.equal(p3.isBot, false);
  assert.equal(d.players[11]!.isBot, true);
  assert.ok(Math.abs(p3.pos.x - 4.5) < 1e-5);
  assert.ok(Math.abs(p3.vel.z - 6.2) < 0.006);
  assert.ok(Math.abs(p3.yaw - 1.234) < 0.001);
  assert.equal(p3.reserve, 160);
  assert.equal(d.projectiles.length, 1);
  assert.ok(Math.abs(d.projectiles[0]!.fuse - 2.5) < 0.06);
  assert.ok(d.local);
  assert.equal(d.local!.slots[0]!.mag, 17);
  assert.equal(d.local!.slots[0]!.reserve, 90);
  assert.ok(Math.abs(d.local!.reloadT - 0.75) < 1e-6);
  assert.equal(d.local!.shotIndex, 5);
  assert.equal(d.local!.lastFireTick, 599);
  assert.deepEqual(d.local!.perks, [1, 6]);
});

test('snapshot events round-trip', () => {
  const s = createSnapshot();
  s.events.push({ type: EV_FIRE, shooter: 2, weapon: 0, origin: vec3(1, 1.6, 2), dir: vec3(0, 0, -1) });
  s.events.push({ type: EV_HIT, target: 3, attacker: 2, zone: 0, damage: 39 });
  s.events.push({ type: EV_KILL, killer: 2, victim: 3, weapon: 0, headshot: true });
  s.events.push({ type: EV_ROUND, state: 1, winner: TEAM_A, round: 4 });
  const m = decodeMessage(encodeSnapshot(s));
  assert.equal(m?.kind, 'snapshot');
  if (m?.kind !== 'snapshot') return;
  assert.equal(m.snapshot.events.length, 4);
  const fire = m.snapshot.events[0]!;
  assert.equal(fire.type, EV_FIRE);
  if (fire.type === EV_FIRE) assert.ok(Math.abs(fire.dir.z + 1) < 0.01);
  const kill = m.snapshot.events[2]!;
  if (kill.type === EV_KILL) assert.equal(kill.headshot, true);
  assert.equal(m.snapshot.local, null);
});

test('room state and match end round-trip', () => {
  const rs: RoomState = {
    code: 'QWER', phase: 0, mode: MODE_TDM, mapId: 0, hostId: 1, round: 2, roundsWon: [1, 1], timeLeft: 9.5,
    players: [
      { id: 1, team: TEAM_A, name: 'host', kills: 3, deaths: 1, score: 300, ping: 40, isBot: false, connState: 0, loadout: defaultLoadout() },
      { id: 2, team: TEAM_B, name: 'bot 1', kills: 0, deaths: 2, score: 0, ping: 0, isBot: true, connState: 0, loadout: defaultLoadout() },
    ],
    bombState: 0, bombSite: 0, bombTimer: 0, bombCarrier: 0, botCount: 1, botDifficulty: 1, maxPlayers: 12,
  };
  const m = decodeMessage(encodeRoomState(rs));
  assert.equal(m?.kind, 'roomState');
  if (m?.kind === 'roomState') {
    assert.equal(m.roomState.code, 'QWER');
    assert.equal(m.roomState.players.length, 2);
    assert.equal(m.roomState.players[1]!.name, 'bot 1');
    assert.equal(m.roomState.players[1]!.isBot, true);
    assert.equal(m.roomState.players[0]!.score, 300);
  }
  const end = decodeMessage(encodeMatchEnd({ winnerTeam: TEAM_A, winnerId: 0, players: [{ id: 1, name: 'host', team: TEAM_A, kills: 30, deaths: 12, score: 3000 }] }));
  assert.equal(end?.kind, 'matchEnd');
  if (end?.kind === 'matchEnd') assert.equal(end.result.players[0]!.kills, 30);
});

test('decodeMessage rejects garbage', () => {
  assert.equal(decodeMessage(new Uint8Array(0)), null);
  assert.equal(decodeMessage(new Uint8Array([200, 1, 2])), null);
  assert.equal(decodeMessage(new Uint8Array([MSG_SNAPSHOT, 1])), null);
});

test('LocalTransport delivers immediately with no options and with latency when advanced', () => {
  const [a, b] = LocalTransport.pair();
  const got: number[] = [];
  b.onMessage = (d) => got.push(d[0]!);
  a.send(new Uint8Array([7]));
  assert.deepEqual(got, [7]);

  const [c, d] = LocalTransport.pair({ latencyMs: 100 });
  const late: number[] = [];
  d.onMessage = (m) => late.push(m[0]!);
  c.advance(0);
  c.send(new Uint8Array([1]));
  d.advance(50);
  assert.deepEqual(late, []);
  d.advance(100);
  assert.deepEqual(late, [1]);

  let closed = 0;
  d.onClose = () => closed++;
  c.close();
  assert.equal(closed, 1);
  assert.equal(d.isClosed, true);
});
