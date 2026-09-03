// Unit test for client/net/prediction.ts.
//
// The assignment's original scenario drives a real shared/net/room.ts Room
// (as the authoritative side) and a scripted client through a LocalTransport
// pair with simulated latency/jitter/loss. At the time this file was
// written, shared/net/room.ts and shared/sim/world.ts do not exist yet (W1-D
// is building them in parallel) — per this agent's assignment, the fallback
// is to test Predictor directly against a fake authoritative source instead,
// which is what this file does. Reported as a gap: the integrator should
// consider adding a second test once Room/World land that exercises the
// same scenario through the real wire protocol and an actual Room, closer
// to the plan's original description.
//
// The fake "server" here is not a stub: it steps its own PlayerState with
// the exact same shared/movement.ts#stepPlayer and
// shared/sim/weaponstate.ts#stepWeapon the client predicts with, but only
// applies whichever InputCmds actually survive a lossy, jittered uplink —
// mirroring World.applyInput's "drop cmd.seq <= lastAppliedSeq" contract.
// That is the real source of prediction error this test measures: dropped
// or delayed inputs, not a scripted fake divergence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BTN_FIRE, BTN_JUMP, BTN_SPRINT, INPUT_REDUNDANCY, MAT_CONCRETE, TEAM_A, TICK_DT } from '../shared/constants.ts';
import { copyInputCmd, createInputCmd, createPlayerState, clonePlayerState } from '../shared/types.ts';
import type { InputCmd, PlayerState } from '../shared/types.ts';
import { mulberry32 } from '../shared/math.ts';
import { stepPlayer } from '../shared/movement.ts';
import { stepWeapon } from '../shared/sim/weaponstate.ts';
import type { MapColliders, MapLayout, RayHit } from '../shared/map/types.ts';
import { createMovementEvents, createWeaponEvents, resetMovementEvents, resetWeaponEvents } from '../shared/sim/types.ts';
import { Predictor } from '../client/net/prediction.ts';

/**
 * A minimal flat-ground MapColliders satisfying shared/map/types.ts, since
 * shared/map/layout.ts and shared/map/colliders.ts (W1-B) don't exist yet at
 * the time this file was written. Pure and deterministic like the real
 * thing; just has no geometry to collide with.
 */
function makeFlatColliders(): MapColliders {
  const layout: MapLayout = {
    id: 0,
    name: 'flat-test',
    width: 200,
    depth: 200,
    boxes: [],
    ramps: [],
    props: [],
    spawns: [],
    sites: [],
    lights: [],
    navCellSize: 1,
    groundMaterial: MAT_CONCRETE,
    killY: -50,
  };
  return {
    layout,
    aabbs: [],
    ramps: [],
    sites: [],
    query: () => 0,
    raycast: (_ox: number, _oy: number, _oz: number, _dx: number, _dy: number, _dz: number, _maxDist: number, _out: RayHit) => false,
    groundHeight: () => 0,
    materialAt: () => MAT_CONCRETE,
    spawnsFor: () => [],
    lineOfSight: () => true,
  };
}

/** Walk 2s, sprint 2s (with one jump), then sprint+periodic fire pulses for the remaining 6s of a 10s script. */
function scriptedCmd(seq: number, tick: number): InputCmd {
  const c = createInputCmd();
  c.seq = seq;
  c.tick = tick;
  const t = tick * TICK_DT;
  c.moveX = 0;
  c.moveY = 1;
  c.yaw = 0;
  c.pitch = 0;
  c.weaponSlot = 0;
  if (t >= 2) c.buttons |= BTN_SPRINT;
  if (t >= 4 && Math.floor(t * 2) % 2 === 0) c.buttons |= BTN_FIRE;
  if (Math.abs(t - 2.5) < TICK_DT / 2) c.buttons |= BTN_JUMP;
  return c;
}

function cloneCmd(c: InputCmd): InputCmd {
  return copyInputCmd(createInputCmd(), c);
}

interface Delivery<T> {
  at: number;
  payload: T;
}

/** A LocalTransport-like lossy/jittery/latent one-way link, but for arbitrary payloads instead of bytes, so the test doesn't need shared/net/room.ts to exist to exercise realistic delivery conditions. */
class LossyLink<T> {
  private readonly queue: Delivery<T>[] = [];
  private readonly latencyMs: number;
  private readonly jitterMs: number;
  private readonly lossPct: number;
  private readonly rng: () => number;

  constructor(latencyMs: number, jitterMs: number, lossPct: number, rng: () => number) {
    this.latencyMs = latencyMs;
    this.jitterMs = jitterMs;
    this.lossPct = lossPct;
    this.rng = rng;
  }

  send(nowMs: number, payload: T): void {
    if (this.rng() < this.lossPct) return;
    const delay = this.latencyMs + this.rng() * this.jitterMs;
    this.queue.push({ at: nowMs + delay, payload });
  }

  /** Returns every delivery due by `nowMs`, oldest-arriving first; jitter can reorder them, same as the real transports. */
  drain(nowMs: number): T[] {
    this.queue.sort((a, b) => a.at - b.at);
    const due: T[] = [];
    while (this.queue.length > 0 && this.queue[0]!.at <= nowMs) due.push(this.queue.shift()!.payload);
    return due;
  }
}

test('Predictor reconciles cleanly against a lossy, jittery authoritative source (150ms latency, 30ms jitter, 2% loss, 10s)', () => {
  const rng = mulberry32(0xc0ffee);
  const colliders = makeFlatColliders();

  const server: PlayerState = createPlayerState(1, 'Test', TEAM_A);
  server.alive = true;
  const serverMoveEvents = createMovementEvents();
  const serverWeaponEvents = createWeaponEvents();
  let lastAppliedSeq = 0;

  const predictor = new Predictor(colliders);
  predictor.local = createPlayerState(1, 'Test', TEAM_A);
  predictor.local.alive = true;

  const uplink = new LossyLink<InputCmd[]>(150, 30, 0.02, rng);
  const downlink = new LossyLink<{ block: PlayerState; lastAckSeq: number }>(150, 30, 0.02, rng);

  const TOTAL_TICKS = 600; // 10s @ 60Hz
  let seq = 1;
  let correctionSum = 0;
  let prevCorrections = 0;

  for (let tick = 0; tick < TOTAL_TICKS; tick++) {
    const nowMs = tick * TICK_DT * 1000;

    // Client: predict, then send this tick's redundant input burst uplink.
    const cmd = scriptedCmd(seq++, tick);
    predictor.pushInput(cmd);
    uplink.send(nowMs, predictor.pendingCmds(INPUT_REDUNDANCY).map(cloneCmd));

    // "Server": apply whichever bursts have arrived, oldest input first,
    // skipping anything at or behind what it has already applied.
    for (const burst of uplink.drain(nowMs)) {
      for (let i = burst.length - 1; i >= 0; i--) {
        const c = burst[i]!;
        if (c.seq <= lastAppliedSeq) continue;
        resetMovementEvents(serverMoveEvents);
        resetWeaponEvents(serverWeaponEvents);
        stepPlayer(server, c, colliders, TICK_DT, serverMoveEvents);
        stepWeapon(server, c, TICK_DT, serverWeaponEvents);
        lastAppliedSeq = c.seq;
      }
    }

    // Server snapshots at 20 Hz (every 3rd tick) and sends the local block downlink.
    if (tick % 3 === 0) {
      downlink.send(nowMs, { block: clonePlayerState(server), lastAckSeq: lastAppliedSeq });
    }

    // Client reconciles against whatever authoritative blocks have arrived.
    for (const { block, lastAckSeq } of downlink.drain(nowMs)) {
      predictor.onAuthoritative(block, lastAckSeq);
      if (predictor.corrections > prevCorrections) {
        correctionSum += predictor.lastErrorMetres;
        prevCorrections = predictor.corrections;
      }
    }
  }

  const meanCorrection = predictor.corrections > 0 ? correctionSum / predictor.corrections : 0;

  assert.equal(predictor.snaps, 0, `expected zero full snaps over 10s at 150ms/30ms/2%, got ${predictor.snaps}`);
  assert.ok(
    predictor.corrections > 0,
    'expected at least one smoothed correction — a vacuous 0/0 mean would not exercise reconciliation',
  );
  assert.ok(meanCorrection < 0.03, `mean reconciliation correction ${meanCorrection.toFixed(4)}m should be < 0.03m`);
});
