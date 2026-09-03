// Unit tests for shared/movement.ts against a tiny fake MapColliders (flat
// ground plane + optional boxes) — colliders.ts is another agent's file and
// may not exist yet, so this stays self-contained per the assignment.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BTN_CROUCH,
  BTN_JUMP,
  BTN_SPRINT,
  BTN_TACSPRINT,
  MOVE_MANTLE,
  MOVE_SLIDE,
  MOVE_SPRINT,
  MOVE_TACSPRINT,
  PLAYER_RADIUS,
  SLIDE_SPEED_START,
  SPRINT_START_DELAY,
  TACSPRINT_COOLDOWN,
  TACSPRINT_DURATION,
  TEAM_A,
  TICK_DT,
} from '../shared/constants.ts';
import { createInputCmd, createPlayerState } from '../shared/types.ts';
import type { InputCmd, PlayerState } from '../shared/types.ts';
import { createMovementEvents, resetMovementEvents } from '../shared/sim/types.ts';
import { stepPlayer } from '../shared/movement.ts';
import { rayAabb } from '../shared/math.ts';
import type { Aabb, MapColliders, MapLayout, RayHit } from '../shared/map/types.ts';

// ---------------------------------------------------------------------------
// Fake MapColliders: flat ground plane at y=0 plus a caller-supplied box list.
// ---------------------------------------------------------------------------
function makeLayout(boxes: Aabb[]): MapLayout {
  return {
    id: 0, name: 'test', width: 200, depth: 200,
    boxes: [], ramps: [], props: [], spawns: [], sites: [], lights: [],
    navCellSize: 1, groundMaterial: 0, killY: -50,
  };
}

function makeColliders(boxes: Aabb[] = []): MapColliders {
  const layout = makeLayout(boxes);
  return {
    layout,
    aabbs: boxes,
    ramps: [],
    sites: [],
    query(minX, minY, minZ, maxX, maxY, maxZ, out) {
      let n = 0;
      for (const b of boxes) {
        if (b.maxX > minX && b.minX < maxX && b.maxY > minY && b.minY < maxY && b.maxZ > minZ && b.minZ < maxZ) {
          out.push(b);
          n++;
        }
      }
      return n;
    },
    raycast(ox, oy, oz, dx, dy, dz, maxDist, out: RayHit) {
      let best = -1;
      let bestBox: Aabb | null = null;
      for (const b of boxes) {
        const t = rayAabb(ox, oy, oz, dx, dy, dz, b, maxDist);
        if (t >= 0 && (best < 0 || t < best)) { best = t; bestBox = b; }
      }
      if (best < 0 || !bestBox) return false;
      out.dist = best;
      out.point.x = ox + dx * best; out.point.y = oy + dy * best; out.point.z = oz + dz * best;
      out.normal.x = 0; out.normal.y = 0; out.normal.z = 0;
      out.material = bestBox.material;
      return true;
    },
    groundHeight(x, z, fromY) {
      let best = 0; // ground plane
      for (const b of boxes) {
        if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && b.maxY <= fromY + 1e-6 && b.maxY > best) {
          best = b.maxY;
        }
      }
      return best;
    },
    materialAt() { return 0; },
    spawnsFor() { return []; },
    lineOfSight() { return true; },
  };
}

function newPlayer(): PlayerState {
  const s = createPlayerState(1, 'p', TEAM_A);
  s.alive = true;
  s.onGround = true;
  return s;
}

// ---------------------------------------------------------------------------
test('determinism: identical input sequences produce identical resulting states', () => {
  const colliders = makeColliders();
  const cmds: InputCmd[] = [];
  for (let i = 0; i < 40; i++) {
    const c = createInputCmd();
    c.seq = i; c.tick = i;
    c.moveY = i % 7 === 0 ? 0 : 1;
    c.moveX = ((i % 5) - 2) / 2;
    c.yaw = 0.3 * Math.sin(i * 0.1);
    c.buttons = (i % 10 < 6 ? BTN_SPRINT : 0) | (i % 13 === 0 ? BTN_JUMP : 0) | (i % 17 === 0 ? BTN_CROUCH : 0);
    cmds.push(c);
  }
  function run(): PlayerState {
    const s = newPlayer();
    const events = createMovementEvents();
    for (const c of cmds) {
      resetMovementEvents(events);
      stepPlayer(s, c, colliders, TICK_DT, events);
    }
    return s;
  }
  assert.deepEqual(run(), run());
});

test('slide-cancel (jump) keeps ~90% of the slide speed and launches a jump', () => {
  const colliders = makeColliders();
  const s = newPlayer();
  const events = createMovementEvents();

  const sprintCmd = createInputCmd();
  sprintCmd.moveY = 1;
  sprintCmd.buttons = BTN_SPRINT;
  const ticksToSprint = Math.ceil(SPRINT_START_DELAY / TICK_DT) + 2;
  for (let i = 0; i < ticksToSprint; i++) { resetMovementEvents(events); stepPlayer(s, sprintCmd, colliders, TICK_DT, events); }
  assert.equal(s.moveState, MOVE_SPRINT);

  const slideCmd = createInputCmd();
  slideCmd.moveY = 1;
  slideCmd.buttons = BTN_SPRINT | BTN_CROUCH;
  resetMovementEvents(events);
  stepPlayer(s, slideCmd, colliders, TICK_DT, events);
  assert.equal(s.moveState, MOVE_SLIDE);
  assert.ok(events.slideStarted);
  const speedAtStart = Math.hypot(s.vel.x, s.vel.z);
  assert.ok(Math.abs(speedAtStart - SLIDE_SPEED_START) < 0.01);

  const cancelCmd = createInputCmd();
  cancelCmd.buttons = BTN_JUMP;
  resetMovementEvents(events);
  stepPlayer(s, cancelCmd, colliders, TICK_DT, events);
  assert.ok(events.slideCancelled, 'slideCancelled should fire on a jump-cancel');
  assert.ok(events.jumped, 'jump-cancelling a slide should also jump');
  assert.notEqual(s.moveState, MOVE_SLIDE);
  const speedAfter = Math.hypot(s.vel.x, s.vel.z);
  assert.ok(
    speedAfter > speedAtStart * 0.8 && speedAfter < speedAtStart * 0.95,
    `expected ~90% of ${speedAtStart}, got ${speedAfter}`,
  );
  assert.ok(s.vel.y > 5, 'jump-cancel should launch the player upward');
});

test('tactical sprint runs for its duration, then needs its cooldown before it is available again', () => {
  const colliders = makeColliders();
  const s = newPlayer();
  const events = createMovementEvents();
  const cmd = createInputCmd();
  cmd.moveY = 1;
  cmd.buttons = BTN_TACSPRINT;

  const stepsFull = Math.round(TACSPRINT_DURATION / TICK_DT);
  for (let i = 0; i < stepsFull - 2; i++) { resetMovementEvents(events); stepPlayer(s, cmd, colliders, TICK_DT, events); }
  assert.ok(s.tacT > 0);
  assert.equal(s.moveState, MOVE_TACSPRINT);

  for (let i = 0; i < 5; i++) { resetMovementEvents(events); stepPlayer(s, cmd, colliders, TICK_DT, events); }
  assert.equal(s.tacT, 0);
  assert.ok(s.tacCooldown > 0, 'cooldown should start once tac sprint runs out');
  assert.ok(Math.abs(s.tacCooldown - TACSPRINT_COOLDOWN) < 0.2);

  resetMovementEvents(events);
  stepPlayer(s, cmd, colliders, TICK_DT, events);
  assert.equal(s.tacT, 0, 'tac sprint must not restart while on cooldown');

  const cooldownTicks = Math.ceil(s.tacCooldown / TICK_DT) + 2;
  for (let i = 0; i < cooldownTicks; i++) { resetMovementEvents(events); stepPlayer(s, cmd, colliders, TICK_DT, events); }
  assert.ok(s.tacT > 0, 'tac sprint should be available again once the cooldown elapses');
});

test('mantle climbs a 1.0m ledge onto its top', () => {
  const box: Aabb = { minX: 3, maxX: 4, minY: 0, maxY: 1.0, minZ: -2, maxZ: 2, material: 0 };
  const colliders = makeColliders([box]);
  const s = newPlayer();
  s.pos.x = 2.5; s.pos.y = 0; s.pos.z = 0;
  s.yaw = -Math.PI / 2; // face +X
  const events = createMovementEvents();

  const jumpCmd = createInputCmd();
  jumpCmd.yaw = s.yaw;
  jumpCmd.buttons = BTN_JUMP;
  resetMovementEvents(events);
  stepPlayer(s, jumpCmd, colliders, TICK_DT, events);
  assert.ok(events.mantleStarted, 'mantle should trigger facing a 1.0m ledge within range');
  assert.equal(s.moveState, MOVE_MANTLE);

  const idleCmd = createInputCmd();
  idleCmd.yaw = s.yaw;
  const maxTicks = Math.ceil(s.mantleDuration / TICK_DT) + 5;
  for (let i = 0; i < maxTicks && s.moveState === MOVE_MANTLE; i++) {
    resetMovementEvents(events);
    stepPlayer(s, idleCmd, colliders, TICK_DT, events);
  }
  assert.notEqual(s.moveState, MOVE_MANTLE, 'mantle should have finished within its own duration');
  assert.ok(Math.abs(s.pos.y - 1.0) < 0.05, `expected to land near y=1.0, got ${s.pos.y}`);
  assert.ok(s.pos.x > 3, 'should have moved past the ledge face onto its top');
});

test('walking into a wall stops the player without penetrating it', () => {
  const box: Aabb = { minX: 5, maxX: 6, minY: 0, maxY: 3, minZ: -5, maxZ: 5, material: 0 };
  const colliders = makeColliders([box]);
  const s = newPlayer();
  s.yaw = -Math.PI / 2; // face +X
  const events = createMovementEvents();
  const cmd = createInputCmd();
  cmd.moveY = 1;
  cmd.yaw = s.yaw;

  for (let i = 0; i < 300; i++) { resetMovementEvents(events); stepPlayer(s, cmd, colliders, TICK_DT, events); }

  assert.ok(s.pos.x <= box.minX - PLAYER_RADIUS + 0.05, `player penetrated the wall: x=${s.pos.x}`);
  assert.ok(s.pos.x > box.minX - PLAYER_RADIUS - 1.0, 'player should have travelled up to the wall');
});

test('a standing jump reaches approximately 1.0m', () => {
  const colliders = makeColliders();
  const s = newPlayer();
  const events = createMovementEvents();

  const jumpCmd = createInputCmd();
  jumpCmd.buttons = BTN_JUMP;
  resetMovementEvents(events);
  stepPlayer(s, jumpCmd, colliders, TICK_DT, events);
  assert.ok(events.jumped);

  let peak = s.pos.y;
  const noCmd = createInputCmd();
  for (let i = 0; i < 200 && !s.onGround; i++) {
    resetMovementEvents(events);
    stepPlayer(s, noCmd, colliders, TICK_DT, events);
    if (s.pos.y > peak) peak = s.pos.y;
  }
  // Semi-implicit ("symplectic") Euler at 60Hz has a known small discretization
  // bias below the continuous analytic peak (v0²/2g = 0.99): roughly
  // dt*v0/2 ≈ 0.055m here, since gravity is applied before integrating
  // position on every tick including the jump tick itself.
  assert.ok(Math.abs(peak - 1.0) < 0.07, `expected peak height ~1.0m, got ${peak}`);
});
