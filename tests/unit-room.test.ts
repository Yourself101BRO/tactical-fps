// Integration-style unit tests for shared/net/room.ts, driven entirely over
// LocalTransport pairs (no real sockets, no clocks besides the nowMs each
// test hands to Room.update()).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LocalTransport } from '../shared/net/transport.ts';
import { Room } from '../shared/net/room.ts';
import type { RoomOptions } from '../shared/net/room.ts';
import { decodeMessage, encodeHello, encodeInput } from '../shared/protocol.ts';
import { createInputCmd } from '../shared/types.ts';
import type { InputCmd, Message } from '../shared/types.ts';
import { LOBBY_START } from '../shared/types.ts';
import {
  BOT_REGULAR,
  CONN_ACTIVE,
  CONN_DISCONNECTED,
  MAP_COMPOUND,
  MAX_INPUT_MSGS_PER_SEC,
  MODE_FFA,
  PROTOCOL_VERSION,
  REJOIN_GRACE_MS,
  SNAPSHOT_EVERY,
  TICK_DT,
} from '../shared/constants.ts';

function makeRoom(overrides: Partial<RoomOptions> = {}): Room {
  return new Room({
    code: 'TEST',
    mode: MODE_FFA,
    mapId: MAP_COMPOUND,
    botCount: 0,
    botDifficulty: BOT_REGULAR,
    seed: 1,
    ...overrides,
  });
}

interface Client {
  transport: LocalTransport;
  messages: Message[];
}

/** Pairs a fresh LocalTransport, attaches its server side to the room, and sends HELLO. */
function connect(room: Room, name: string, rejoinId = 0): Client {
  const [client, server] = LocalTransport.pair();
  const messages: Message[] = [];
  client.onMessage = (data) => {
    const msg = decodeMessage(data);
    if (msg) messages.push(msg);
  };
  room.attach(server);
  client.send(encodeHello({ protocolVersion: PROTOCOL_VERSION, name, roomCode: 'TEST', mode: MODE_FFA, wantBots: 0, rejoinId }));
  return { transport: client, messages };
}

function sendInput(client: Client, seq: number, tick: number): void {
  const cmd: InputCmd = createInputCmd();
  cmd.seq = seq;
  cmd.tick = tick;
  client.transport.send(encodeInput([cmd]));
}

const stepMs = TICK_DT * 1000;

test('two clients HELLO into a room and receive WELCOME then ROOM_STATE', () => {
  const room = makeRoom();

  const alice = connect(room, 'Alice');
  assert.equal(alice.messages.length, 2);
  assert.equal(alice.messages[0]!.kind, 'welcome');
  assert.equal(alice.messages[1]!.kind, 'roomState');
  const aliceWelcome = alice.messages[0]!;
  if (aliceWelcome.kind !== 'welcome') throw new Error('unreachable');
  assert.equal(aliceWelcome.welcome.playerId, 1);
  assert.equal(aliceWelcome.welcome.roomCode, 'TEST');
  assert.equal(room.hostId, 1, 'first human becomes host');

  const bob = connect(room, 'Bob');
  assert.equal(bob.messages[0]!.kind, 'welcome');
  const bobWelcome = bob.messages[0]!;
  if (bobWelcome.kind !== 'welcome') throw new Error('unreachable');
  assert.equal(bobWelcome.welcome.playerId, 2);

  // Alice also gets a fresh ROOM_STATE broadcast when Bob joins.
  const aliceRoomStates = alice.messages.filter((m) => m.kind === 'roomState');
  assert.equal(aliceRoomStates.length, 2);
  const rs = aliceRoomStates[1]!;
  if (rs.kind !== 'roomState') throw new Error('unreachable');
  assert.equal(rs.roomState.players.length, 2);
  assert.equal(rs.roomState.hostId, 1);
});

test('host START moves the room out of LOBBY, and snapshots arrive every SNAPSHOT_EVERY ticks', () => {
  const room = makeRoom();
  const alice = connect(room, 'Alice');
  alice.messages.length = 0;

  room.start();
  assert.ok(alice.messages.some((m) => m.kind === 'roomState'));
  alice.messages.length = 0;

  // tickOnce() advances the simulation by exactly one tick with no wall-clock
  // involved, so the SNAPSHOT_EVERY cadence can be checked deterministically
  // (Room.update()'s real-time accumulator is exercised separately below).
  for (let i = 0; i < 15; i++) room.tickOnce();

  const snapshots = alice.messages.filter((m) => m.kind === 'snapshot');
  assert.equal(snapshots.length, 15 / SNAPSHOT_EVERY);
});

test('update()\'s real-time accumulator eventually delivers the same number of ticks as tickOnce() would', () => {
  const room = makeRoom();
  let now = 0;
  room.update(now); // baseline call: establishes the accumulator's t0, runs zero ticks
  // Advance by a large, round number of ticks worth of wall-clock time in one
  // go; capped at 4 ticks per update() call, so drive it across many calls.
  const targetTicks = 40;
  for (let i = 0; i < targetTicks; i++) {
    now += stepMs;
    room.update(now);
  }
  // Floating-point drift in the accumulator can shift an individual call's
  // tick count by one, but it self-corrects: total ticks stays within 1 of
  // the wall-clock time actually advanced.
  assert.ok(Math.abs(room.world.tick - targetTicks) <= 1, `expected close to ${targetTicks} ticks, got ${room.world.tick}`);
});

test('a stale (already-applied) input seq does not move lastAppliedSeq backwards or re-trigger', () => {
  const room = makeRoom();
  const alice = connect(room, 'Alice');
  const player = room.world.players.get(1)!;
  // A dead player's queued input is never drained by World.step, so spawn
  // them in directly before exercising input processing.
  room.world.respawn(1, { x: 0, y: 0, z: 0, yaw: 0 });

  let now = 0;
  room.update(now); // baseline

  sendInput(alice, 10, 100);
  now += stepMs;
  room.update(now); // drains the queued cmd
  assert.equal(player.lastAppliedSeq, 10);

  sendInput(alice, 5, 50); // seq below lastAppliedSeq: World.applyInput must reject it
  now += stepMs;
  room.update(now);
  assert.equal(player.lastAppliedSeq, 10, 'stale seq must not move lastAppliedSeq');
});

test('INPUT messages beyond MAX_INPUT_MSGS_PER_SEC in the same window are dropped before reaching World', () => {
  const room = makeRoom();
  const alice = connect(room, 'Alice');

  let now = 0;
  room.update(now); // establishes room.nowMs = 0 for the rate-limit window

  let applyCalls = 0;
  const originalApplyInput = room.world.applyInput.bind(room.world);
  room.world.applyInput = (id: number, cmd: InputCmd): boolean => {
    applyCalls++;
    return originalApplyInput(id, cmd);
  };

  const extra = 20;
  for (let i = 0; i < MAX_INPUT_MSGS_PER_SEC + extra; i++) {
    sendInput(alice, i + 1, i + 1); // one INPUT message per call, all within the nowMs=0 window
  }

  assert.equal(applyCalls, MAX_INPUT_MSGS_PER_SEC, 'messages past the per-second budget must be dropped, not just queued');
});

test('disconnect then rejoin within REJOIN_GRACE_MS restores the same player id and PlayerState', () => {
  const room = makeRoom();
  const alice = connect(room, 'Alice');
  const welcome = alice.messages[0]!;
  if (welcome.kind !== 'welcome') throw new Error('unreachable');
  const id = welcome.welcome.playerId;
  const player = room.world.players.get(id)!;

  room.update(0); // establish room.nowMs = 0

  alice.transport.close(); // cascades to the paired server-side transport's onClose -> Room.handleDisconnect
  assert.equal(player.connState, CONN_DISCONNECTED);
  assert.equal(room.world.players.get(id), player, 'the slot is held, not removed, during the grace window');

  const laterMs = REJOIN_GRACE_MS / 2;
  room.update(laterMs); // still well within the grace window

  const rejoined = connect(room, 'Alice', id);
  const rejoinWelcome = rejoined.messages[0]!;
  assert.equal(rejoinWelcome.kind, 'welcome');
  if (rejoinWelcome.kind !== 'welcome') throw new Error('unreachable');
  assert.equal(rejoinWelcome.welcome.playerId, id);
  assert.equal(room.world.players.get(id), player, 'rejoin must reuse the same PlayerState object');
  assert.equal(player.connState, CONN_ACTIVE);
});

test('disconnect past REJOIN_GRACE_MS removes the slot entirely', () => {
  const room = makeRoom();
  const alice = connect(room, 'Alice');
  const welcome = alice.messages[0]!;
  if (welcome.kind !== 'welcome') throw new Error('unreachable');
  const id = welcome.welcome.playerId;

  room.update(0);
  alice.transport.close();
  assert.equal(room.world.players.get(id)!.connState, CONN_DISCONNECTED);

  room.update(REJOIN_GRACE_MS + 1000); // past the grace window; expireDisconnected() should remove the slot
  assert.equal(room.world.players.has(id), false);
});

// Sanity check that a LOBBY_START-shaped LobbyCmd id is what we think, since
// Room's HELLO/attach flow above exercises start() directly rather than the
// wire LOBBY_CMD path (covered implicitly: LOBBY_START == the action Room
// checks against PHASE_LOBBY before calling rules.start()).
test('LOBBY_START constant is 0 as protocol.ts assumes', () => {
  assert.equal(LOBBY_START, 0);
});
