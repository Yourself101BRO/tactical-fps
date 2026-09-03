import { BTN_FIRE, BTN_JUMP, BTN_SPRINT, INPUT_REDUNDANCY, MAT_CONCRETE, TEAM_A, TICK_DT } from '../shared/constants.ts';
import { copyInputCmd, createInputCmd, createPlayerState, clonePlayerState } from '../shared/types.ts';
import type { InputCmd, PlayerState } from '../shared/types.ts';
import { mulberry32 } from '../shared/math.ts';
import { stepPlayer } from '../shared/movement.ts';
import { stepWeapon } from '../shared/sim/weaponstate.ts';
import type { MapColliders, MapLayout, RayHit } from '../shared/map/types.ts';
import { createMovementEvents, createWeaponEvents, resetMovementEvents, resetWeaponEvents } from '../shared/sim/types.ts';
import { Predictor } from '../client/net/prediction.ts';

function makeFlatColliders(): MapColliders {
  const layout: MapLayout = {
    id: 0, name: 'flat-test', width: 200, depth: 200,
    boxes: [], ramps: [], props: [], spawns: [], sites: [], lights: [],
    navCellSize: 1, groundMaterial: MAT_CONCRETE, killY: -50,
  };
  return {
    layout, aabbs: [], ramps: [], sites: [],
    query: () => 0,
    raycast: (_ox: number, _oy: number, _oz: number, _dx: number, _dy: number, _dz: number, _maxDist: number, _out: RayHit) => false,
    groundHeight: () => 0,
    materialAt: () => MAT_CONCRETE,
    spawnsFor: () => [],
    lineOfSight: () => true,
  };
}

function scriptedCmd(seq: number, tick: number): InputCmd {
  const c = createInputCmd();
  c.seq = seq; c.tick = tick;
  const t = tick * TICK_DT;
  c.moveX = 0; c.moveY = 1; c.yaw = 0; c.pitch = 0; c.weaponSlot = 0;
  if (t >= 2) c.buttons |= BTN_SPRINT;
  if (t >= 4 && Math.floor(t * 2) % 2 === 0) c.buttons |= BTN_FIRE;
  if (Math.abs(t - 2.5) < TICK_DT / 2) c.buttons |= BTN_JUMP;
  return c;
}
function cloneCmd(c: InputCmd): InputCmd { return copyInputCmd(createInputCmd(), c); }

interface Delivery<T> { at: number; payload: T; }
class LossyLink<T> {
  private readonly queue: Delivery<T>[] = [];
  private readonly latencyMs: number; private readonly jitterMs: number; private readonly lossPct: number; private readonly rng: () => number;
  constructor(latencyMs: number, jitterMs: number, lossPct: number, rng: () => number) {
    this.latencyMs = latencyMs; this.jitterMs = jitterMs; this.lossPct = lossPct; this.rng = rng;
  }
  send(nowMs: number, payload: T): void {
    if (this.rng() < this.lossPct) return;
    const delay = this.latencyMs + this.rng() * this.jitterMs;
    this.queue.push({ at: nowMs + delay, payload });
  }
  drain(nowMs: number): T[] {
    this.queue.sort((a, b) => a.at - b.at);
    const due: T[] = [];
    while (this.queue.length > 0 && this.queue[0]!.at <= nowMs) due.push(this.queue.shift()!.payload);
    return due;
  }
}

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

const TOTAL_TICKS = 600;
let seq = 1;
let maxErr = 0;
let errSamples: number[] = [];

for (let tick = 0; tick < TOTAL_TICKS; tick++) {
  const nowMs = tick * TICK_DT * 1000;
  const cmd = scriptedCmd(seq++, tick);
  predictor.pushInput(cmd);
  uplink.send(nowMs, predictor.pendingCmds(INPUT_REDUNDANCY).map(cloneCmd));
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
  if (tick % 3 === 0) {
    downlink.send(nowMs, { block: clonePlayerState(server), lastAckSeq: lastAppliedSeq });
  }
  for (const { block, lastAckSeq } of downlink.drain(nowMs)) {
    predictor.onAuthoritative(block, lastAckSeq);
    errSamples.push(predictor.lastErrorMetres);
    if (predictor.lastErrorMetres > maxErr) maxErr = predictor.lastErrorMetres;
  }
}

console.log('corrections', predictor.corrections, 'snaps', predictor.snaps);
console.log('maxErr', maxErr);
console.log('numAuthUpdates', errSamples.length);
console.log('sample errs (first 20)', errSamples.slice(0, 20));
console.log('sample errs (last 20)', errSamples.slice(-20));
console.log('final local pos', predictor.local!.pos, 'server pos', server.pos);
