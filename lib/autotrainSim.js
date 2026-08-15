// lib/autotrainSim.js
//
// Headless physics harness for self-play training. Runs entirely in Node
// (no DOM, no Three.js) using matter-js directly — the same physics engine
// public/script.js uses in the browser. This file intentionally MIRRORS a
// subset of public/script.js (wheel geometry, terrain generation, drive
// logic, scoring) rather than importing it, because script.js is a plain
// browser script written against `document`/`window`/THREE globals from
// CDN tags, not a Node-importable module. Keep the physics constants and
// terrain-generation logic here in sync with public/script.js by hand —
// same convention the codebase already uses for scoreFromTelemetry, which
// is intentionally duplicated (with a "mirrors" comment) between
// public/script.js and server.js.
//
// One call to runTrial() simulates ONE wheel attempting ONE terrain segment
// (with a flat approach/exit runway) and returns the resulting telemetry +
// score — no rendering, no real-time waiting, so a trial that would take
// ~20 seconds to watch in a browser finishes in well under a second here.

const Matter = require('matter-js');
const decomp = require('poly-decomp');
const { Engine, World, Bodies, Body, Constraint, Vertices } = Matter;

Matter.Common.setDecomp(decomp);

// --- Constants (mirrors public/script.js) ---------------------------------
// Keep every one of these in exact sync with public/script.js's matching
// constant. Letting this drift is not a cosmetic bug: it means autotrain
// scores wheels against physics the live game no longer runs, the AI
// opponent then imitates those scores as if they were trustworthy, and you
// get shapes that were never actually validated against what the game
// really does now (this happened for real — see git history around the
// "is scoring for autoplay broken" fix: BASE_DRIVE_SPEED, wheel friction,
// water sinking, and the ice slip/flip mechanic had all drifted out of
// sync here, so autotrain kept rewarding fast/aggressive ice wheels that
// have zero flip risk in THIS file but flip constantly in the real game).
const SEG_LEN = 900;
const APPROACH_LEN = 200; // flat runway before the terrain under test
const EXIT_LEN = 300;     // flat runway after, so a finished run has room to coast/score cleanly
const BASE_DRIVE_SPEED = 0.4;
const PHYSICS_SUBSTEPS = 4;
const DRIVE_RESPONSE = 0.22;
const MAX_CHASSIS_ANGULAR_VELOCITY = 0.03;
const CHASSIS_ANGULAR_DAMPING = 0.9;
const MIN_WHEEL_R = 22;
const MAX_WHEEL_R = 42;
const REFERENCE_WHEEL_R = (MIN_WHEEL_R + MAX_WHEEL_R) / 2;
const WATER_PIT_DEPTH = 130;
const GROUND_Y = 420;
const CAT_GROUND = 0x0002;

const TERRAIN_TYPES = ['stairs', 'sand', 'water', 'ice', 'rocks', 'steep'];

const MAX_SIM_MS = 30000;   // hard cap so a hopelessly stuck wheel doesn't spin forever
const STUCK_ABORT_MS = 9000; // give up early if genuinely stuck the whole time (not just slow)

// --- Wheel geometry (mirrors public/script.js) -----------------------------
function computeWheelFeatures(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const rel = points.map(p => ({ x: p.x - cx, y: p.y - cy }));
  const radii = rel.map(p => Math.hypot(p.x, p.y));
  const meanR = radii.reduce((a, b) => a + b, 0) / radii.length;
  const maxR = Math.max(...radii);
  const variance = radii.reduce((s, r) => s + (r - meanR) ** 2, 0) / radii.length;
  const irregularity = meanR > 0 ? Math.sqrt(variance) / meanR : 0;

  const xs = rel.map(p => p.x), ys = rel.map(p => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const widthRatio = height > 0 ? width / height : 1;

  const bins = 24, binMax = new Array(bins).fill(0);
  rel.forEach((p, i) => {
    let ang = Math.atan2(p.y, p.x); if (ang < 0) ang += Math.PI * 2;
    const b = Math.floor(ang / (Math.PI * 2) * bins) % bins;
    binMax[b] = Math.max(binMax[b], radii[i]);
  });
  let protrusions = 0;
  for (let i = 0; i < bins; i++) {
    const prev = binMax[(i - 1 + bins) % bins], next = binMax[(i + 1) % bins];
    if (binMax[i] > meanR * 1.15 && binMax[i] >= prev && binMax[i] >= next) protrusions++;
  }

  // widthScale (tyre width) is a separate axis from the outline, same as in
  // public/script.js — it isn't derivable from points, so it defaults to
  // neutral here and pickWheel overrides it when imitating a stored example
  // (or explores a random value on cold-start), mirroring the client.
  return { centroid: { x: cx, y: cy }, maxR, widthRatio, irregularity, protrusions, widthScale: 1 };
}

function pointsToPhysicsVertices(points, features) {
  const targetR = Math.max(MIN_WHEEL_R, Math.min(MAX_WHEEL_R, features.maxR * 0.32));
  const scale = features.maxR > 0 ? targetR / features.maxR : 1;
  const verts = points.map(p => ({
    x: (p.x - features.centroid.x) * scale,
    y: (p.y - features.centroid.y) * scale
  }));
  const vertices = Vertices.clockwiseSort(verts);
  const bottomOffset = Math.max(...vertices.map(v => v.y));
  return { vertices, radius: targetR, bottomOffset };
}

function coldStartWheel() {
  const n = 10 + Math.floor(Math.random() * 6);
  const pts = [];
  const baseR = 30 + Math.random() * 40;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const noise = (Math.random() - 0.5) * baseR * 0.9;
    pts.push({ x: Math.cos(a) * (baseR + noise), y: Math.sin(a) * (baseR + noise) });
  }
  return pts;
}

function coldStartWidthScale() {
  return 0.4 + Math.random() * 2.1;
}

// Mirrors client aiGenerateWheel's imitate-and-mutate step. `candidates` is
// an array of { wheelPoints: [[x,y],...], wheelFeatures, score } already
// fetched by the caller (server.js) — this module has no DB access of its
// own. wheelFeatures[4] is widthScale (see server.js insertExample) —
// read it back and jitter it, same reasoning as the client: reconstructing
// a wheel from points alone would otherwise silently reset width to
// neutral every time, losing whatever the original score partly came from.
function pickWheel(candidates) {
  if (!candidates || candidates.length === 0) {
    return { points: coldStartWheel(), widthScale: coldStartWidthScale(), reason: 'no examples yet — cold-start' };
  }
  if (Math.random() <= 0.15) {
    return { points: coldStartWheel(), widthScale: coldStartWidthScale(), reason: `cold-start (random roll, ${candidates.length} available)` };
  }
  const weights = candidates.map(e => e.score * e.score + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total, pick = candidates[0];
  for (let i = 0; i < candidates.length; i++) { r -= weights[i]; if (r <= 0) { pick = candidates[i]; break; } }
  const jitter = 6;
  const points = pick.wheelPoints.map(([x, y]) => ({ x: x + (Math.random() - 0.5) * jitter, y: y + (Math.random() - 0.5) * jitter }));
  const pickWidth = (pick.wheelFeatures && typeof pick.wheelFeatures[4] === 'number') ? pick.wheelFeatures[4] : 1;
  const widthScale = Math.max(0.4, Math.min(2.5, pickWidth + (Math.random() - 0.5) * 0.3));
  return { points, widthScale, reason: `imitating score-${pick.score} wheel (${candidates.length} available)` };
}

// --- Per-race terrain conditions (mirrors rollRaceConditions) --------------
function rollConditions() {
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  return {
    stairs: { stepH: rand(16, 34), stepW: rand(55, 90) },
    sand: { friction: rand(0.9, 1.4), wideBias: rand(0.65, 1.05) },
    water: { friction: rand(0.15, 0.45), buoyancy: rand(0.0006, 0.0014), densityFactor: rand(0.7, 1.6) },
    ice: { friction: rand(0.01, 0.05) },
    rocks: { bumpAmp: rand(16, 34) },
    steep: { angle: rand(0.22, 0.42) }
  };
}

// --- Ground generation (mirrors buildGroundBodies's per-type switch) -------
function buildGround(world, terrainType, conditions) {
  const bodies = [];
  const filter = { category: CAT_GROUND };
  function addBox(x, y, w, h, angle, friction, groundType) {
    const b = Bodies.rectangle(x, y, w, h, {
      isStatic: true, friction, angle: angle || 0, collisionFilter: filter
    });
    b.groundType = groundType;
    bodies.push(b);
    return b;
  }

  const baseY = GROUND_Y;
  const x0 = 0, x1 = APPROACH_LEN;
  addBox((x0 + x1) / 2, baseY + 20, x1 - x0, 40, 0, 1.0, 'flat');

  const tx0 = x1, tx1 = x1 + SEG_LEN;
  switch (terrainType) {
    case 'stairs': {
      const { stepH, stepW } = conditions.stairs;
      const steps = Math.floor(SEG_LEN / stepW);
      for (let i = 0; i < steps; i++) {
        const rise = Math.min(i, 5) * stepH;
        const bx = tx0 + i * stepW + stepW / 2;
        addBox(bx, baseY - rise / 2 + 20, stepW + 2, Math.max(14, 40 + rise), 0, 0.95, 'stairs');
      }
      break;
    }
    case 'sand':
      addBox((tx0 + tx1) / 2, baseY + 20, SEG_LEN, 40, 0, conditions.sand.friction, 'sand');
      break;
    case 'water': {
      // Recessed floor + rising exit ramp — mirrors public/script.js's
      // buildGroundBodies 'water' case exactly (see the comment there for
      // why the ramp exists: without it a deeply-submerged car falls
      // through the world at the segment boundary).
      const RAMP_LEN = Math.min(300, SEG_LEN * 0.4);
      const pitWidth = Math.max(0, SEG_LEN - RAMP_LEN);
      const pitCx = tx0 + pitWidth / 2;
      addBox(pitCx, baseY + WATER_PIT_DEPTH + 20, pitWidth, 40, 0, conditions.water.friction, 'water');

      const rampAngleAbs = Math.atan2(WATER_PIT_DEPTH, RAMP_LEN);
      const rampLen = Math.hypot(RAMP_LEN, WATER_PIT_DEPTH);
      const rampCx = tx1 - RAMP_LEN / 2;
      addBox(rampCx, baseY + 20 + WATER_PIT_DEPTH / 2, rampLen, 40, -rampAngleAbs, conditions.water.friction, 'water');
      break;
    }
    case 'ice':
      addBox((tx0 + tx1) / 2, baseY + 20, SEG_LEN, 40, 0, conditions.ice.friction, 'ice');
      break;
    case 'rocks': {
      const amp = conditions.rocks.bumpAmp * 0.65;
      const waveLen = 140 + Math.random() * 140;
      const phase = Math.random() * Math.PI * 2;
      let x = tx0;
      while (x < tx1) {
        const chunk = Math.min(22 + Math.random() * 18, tx1 - x);
        const bx = x + chunk / 2;
        const bump = Math.sin(((bx - tx0) / waveLen) * Math.PI * 2 + phase) * amp;
        addBox(bx, baseY + 20 - bump, chunk + 2, Math.max(14, 40 + bump), 0, 0.95, 'rocks');
        x += chunk;
      }
      break;
    }
    case 'steep': {
      const angleAbs = conditions.steep.angle;
      const len = Math.hypot(SEG_LEN, SEG_LEN * Math.tan(angleAbs));
      const rise = SEG_LEN * Math.tan(angleAbs);
      addBox((tx0 + tx1) / 2, baseY + 20 - rise / 2, len, 40, -angleAbs, 0.95, 'steep');
      break;
    }
  }

  const ex0 = tx1, ex1 = tx1 + EXIT_LEN;
  addBox((ex0 + ex1) / 2, baseY + 20, ex1 - ex0, 40, 0, 1.0, 'flat');

  World.add(world, bodies);
  return { tx0, tx1 };
}

// --- Drive multiplier (mirrors terrainDriveMultiplier) ---------------------
function terrainDriveMultiplier(terrainType, features, conditions) {
  if (terrainType === 'sand') {
    const bias = conditions.sand.wideBias;
    const wideness = Math.max(0, Math.min(1, (features.widthRatio - bias) / 1.2));
    return 0.35 + wideness * 0.65;
  }
  if (terrainType === 'water') {
    const densityFactor = conditions.water.densityFactor;
    const paddle = Math.max(0, Math.min(1, features.protrusions / (6 * densityFactor)));
    return 0.15 + paddle * 1.1;
  }
  if (terrainType === 'ice') {
    return 0.7 + Math.max(0, Math.min(1, features.protrusions / 8)) * 0.5;
  }
  if (terrainType === 'stairs' || terrainType === 'rocks') {
    const tread = Math.max(0, Math.min(1, features.protrusions / 6));
    return 0.55 + tread * 0.7;
  }
  return 1;
}

// --- Score (mirrors server.js scoreFromTelemetry — keep in sync) -----------
function scoreFromTelemetry(t) {
  const completion = Math.max(0, Math.min(1, t.distance / t.segmentLength));
  if (t.flippedOver) return Math.round(5 * completion);
  const IDEAL_PX_PER_SEC = 300;
  const idealTimeMs = (t.segmentLength / IDEAL_PX_PER_SEC) * 1000;
  const speedScore = Math.max(0, Math.min(1, idealTimeMs / t.timeMs));
  const stuckPenalty = Math.max(0, 1 - t.stuckMs / Math.max(1, t.timeMs));
  const stabilityScore = Math.max(0, 1 - Math.min(1, t.maxTiltDeg / 90));
  const raw = completion * 45 + speedScore * 30 + stuckPenalty * 15 + stabilityScore * 10;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

// --- One full trial ---------------------------------------------------------
// Builds a fresh physics world, mounts the given wheel, drives it across the
// target terrain, and returns telemetry + score. Yields to the event loop
// periodically (via setImmediate) so a long-running trial doesn't block the
// Express server's own request handling.
async function runTrial(terrainType, wheelPoints, widthScale) {
  const engine = Engine.create({ positionIterations: 12, velocityIterations: 10, constraintIterations: 4 });
  engine.world.gravity.y = 3.4;
  const conditions = rollConditions();
  const { tx0, tx1 } = buildGround(engine.world, terrainType, conditions);

  const features = computeWheelFeatures(wheelPoints);
  if (typeof widthScale === 'number') features.widthScale = widthScale;
  const { vertices, radius, bottomOffset } = pointsToPhysicsVertices(wheelPoints, features);

  const startX = tx0 - APPROACH_LEN / 2;
  const chassis = Bodies.rectangle(startX, GROUND_Y - 60, 96, 26, {
    density: 0.0022, friction: 0.4, collisionFilter: { group: -1, mask: CAT_GROUND }
  });
  const filter = { group: -1, mask: CAT_GROUND };
  const offsets = [{ x: -32, y: 16 }, { x: 32, y: 16 }];
  const wheels = offsets.map(off => {
    const w = Bodies.fromVertices(startX + off.x, GROUND_Y - 60 + off.y, [vertices], {
      friction: 1.5, frictionStatic: 2.2, density: 0.0035, restitution: 0, collisionFilter: filter
    }, true);
    if (!w.parts || w.parts.length < 1) return Bodies.circle(startX + off.x, GROUND_Y - 60 + off.y, radius, { collisionFilter: filter });
    return w;
  });
  const constraints = offsets.map((off, i) => Constraint.create({
    bodyA: chassis, pointA: off, bodyB: wheels[i], pointB: { x: 0, y: 0 }, stiffness: 1, length: 0
  }));
  World.add(engine.world, [chassis, ...wheels, ...constraints]);

  // Settle the car onto the ground (same as createCar in public/script.js)
  const bottomY = wheels[0].position.y + bottomOffset;
  const dy = (GROUND_Y - 3) - bottomY;
  Body.translate(chassis, { x: 0, y: dy });
  wheels.forEach(w => Body.translate(w, { x: 0, y: dy }));

  let simMs = 0;
  let stuckMs = 0;
  let maxTiltDeg = 0;
  let flippedOver = false;
  let enteredAt = null;
  let enteredX = null;
  let flippedSince = null;
  let smoothSpeed, iceSlipDir = null;
  const dtFrame = 1000 / 60;
  const dtSub = dtFrame / PHYSICS_SUBSTEPS;
  let stepCount = 0;

  while (simMs < MAX_SIM_MS) {
    const x = chassis.position.x;
    const onTerrain = x >= tx0 && x < tx1;
    if (onTerrain && enteredAt === null) { enteredAt = simMs; enteredX = x; }

    const mul = onTerrain ? terrainDriveMultiplier(terrainType, features, conditions) : 1;
    const radiusCorrection = REFERENCE_WHEEL_R / (radius || REFERENCE_WHEEL_R);
    const targetSpeed = BASE_DRIVE_SPEED * mul * radiusCorrection;
    for (const wheel of wheels) {
      const newAV = wheel.angularVelocity + (targetSpeed - wheel.angularVelocity) * DRIVE_RESPONSE;
      Body.setAngularVelocity(wheel, newAV);
    }

    if (onTerrain && terrainType === 'stairs') {
      const protrusionFactor = Math.max(0, Math.min(1, features.protrusions / 6));
      const widenessFactor = Math.max(0, Math.min(1, (features.widthRatio - 0.8) / 1.2));
      const baseAssist = 0.002 * PHYSICS_SUBSTEPS;
      const pushScale = baseAssist * (0.7 + 0.7 * protrusionFactor + 0.5 * widenessFactor);
      const lift = 0.0006 * PHYSICS_SUBSTEPS;
      for (const wheel of wheels) {
        if (wheel._origFriction === undefined) wheel._origFriction = wheel.friction || 0.85;
        wheel.friction = wheel._origFriction * 1.8;
        const forward = pushScale * (targetSpeed >= 0 ? 1 : -1);
        Body.applyForce(wheel, wheel.position, { x: forward * wheel.mass, y: -lift * wheel.mass });
      }
    } else {
      for (const wheel of wheels) {
        if (wheel._origFriction !== undefined) { wheel.friction = wheel._origFriction; delete wheel._origFriction; }
      }
    }

    let chassisAV = chassis.angularVelocity * CHASSIS_ANGULAR_DAMPING;
    chassisAV = Math.max(-MAX_CHASSIS_ANGULAR_VELOCITY, Math.min(MAX_CHASSIS_ANGULAR_VELOCITY, chassisAV));
    Body.setAngularVelocity(chassis, chassisAV);

    if (onTerrain && terrainType === 'sand') {
      const tyreFactor = Math.max(0.4, Math.min(2.5, features.widthScale || 1));
      const wideness = Math.max(0, Math.min(1, (features.widthRatio * tyreFactor - conditions.sand.wideBias) / 1.2));
      const drag = 0.985 - 0.01 * (1 - wideness);
      Body.setVelocity(chassis, { x: chassis.velocity.x * drag, y: chassis.velocity.y });
    }
    // Water: recessed floor + position-lerp toward an equilibrium depth —
    // mirrors public/script.js's onBeforeUpdate exactly (see that file for
    // the full reasoning). GROUND_Y stands in for car.groundY.
    if (onTerrain && terrainType === 'water') {
      const widthFactor = Math.max(0.5, Math.min(1.6, features.widthRatio || 1));
      const sizeFactor = Math.max(0.6, Math.min(1.4, radius || REFERENCE_WHEEL_R) / REFERENCE_WHEEL_R);
      const tyreFactor = Math.max(0.4, Math.min(2.5, features.widthScale || 1));
      const displacement = (widthFactor * 0.6 + sizeFactor * 0.6) * tyreFactor;
      let equilibriumDepth = 46 / displacement;
      const RAMP_LEN = Math.min(300, SEG_LEN * 0.4);
      const distToExit = tx1 - chassis.position.x;
      if (distToExit < RAMP_LEN) equilibriumDepth *= Math.max(0, distToExit / RAMP_LEN);
      const targetY = GROUND_Y + equilibriumDepth;
      const wdyRaw = (targetY - chassis.position.y) * 0.08;
      // Clamp the per-frame teleport — an unclamped jump toward a very deep
      // equilibrium (e.g. min tyre width) can shove a wheel still on solid
      // approach ground into penetration, causing a violent one-sided
      // collision response that flips the chassis almost instantly. Mirrors
      // public/script.js's onBeforeUpdate water block — keep in sync.
      const wdy = Math.max(-3.5, Math.min(3.5, wdyRaw));
      Body.translate(chassis, { x: 0, y: wdy });
      wheels.forEach(w => Body.translate(w, { x: 0, y: wdy }));

      const submersion = chassis.position.y - GROUND_Y;
      const depthDrag = Math.max(0, Math.min(0.006, submersion / 40000)); // matches public/script.js — see comment there
      Body.setVelocity(chassis, {
        x: chassis.velocity.x * (1 - depthDrag),
        y: chassis.velocity.y * 0.6
      });
    }

    // Ice: mirrors public/script.js's onBeforeUpdate exactly — going too
    // fast bleeds speed off as a backward slip and builds a destabilizing
    // spin (direction picked once per slip episode) that can flip the car
    // if sustained. smoothSpeed is an EMA of |velocity.x|, same alpha as
    // the client, since raw velocity.x reads noisy near-zero on individual
    // samples in this engine.
    if (onTerrain && terrainType === 'ice') {
      const rawSpeed = Math.abs(chassis.velocity.x);
      smoothSpeed = smoothSpeed === undefined ? rawSpeed : smoothSpeed + (rawSpeed - smoothSpeed) * 0.1;
      const ICE_SAFE_SPEED = 1.8;
      if (smoothSpeed > ICE_SAFE_SPEED) {
        if (!iceSlipDir) iceSlipDir = Math.random() < 0.5 ? 1 : -1;
        const overspeed = smoothSpeed - ICE_SAFE_SPEED;
        const severity = Math.min(1, overspeed / 4);
        Body.setVelocity(chassis, { x: chassis.velocity.x - overspeed * 0.12, y: chassis.velocity.y });
        Body.setAngularVelocity(chassis, chassis.angularVelocity + iceSlipDir * severity * 0.012 * PHYSICS_SUBSTEPS);
      } else {
        iceSlipDir = null;
      }
    }

    // Telemetry
    const speed = Math.hypot(chassis.velocity.x, chassis.velocity.y);
    if (speed < 0.25) stuckMs += dtFrame; else stuckMs = Math.max(0, stuckMs - dtFrame * 0.5);
    const tiltDeg = Math.abs(((chassis.angle * 180 / Math.PI) % 360 + 360) % 360);
    const normTilt = tiltDeg > 180 ? 360 - tiltDeg : tiltDeg;
    if (onTerrain) maxTiltDeg = Math.max(maxTiltDeg, normTilt);
    if (normTilt > 100) {
      flippedOver = true;
      if (!flippedSince) flippedSince = simMs;
      else if (simMs - flippedSince > 1400) break; // stays flipped — stop early, it's not recovering
    } else flippedSince = null;

    for (let i = 0; i < PHYSICS_SUBSTEPS; i++) Engine.update(engine, dtSub);
    simMs += dtFrame;
    stepCount++;

    if (stepCount % 40 === 0) await new Promise(r => setImmediate(r)); // yield to the event loop

    if (x >= tx1) break; // cleared the terrain segment
    if (enteredAt !== null && stuckMs > STUCK_ABORT_MS) break; // genuinely stuck, not just slow
  }

  const startTime = enteredAt !== null ? enteredAt : simMs;
  const startXForScoring = enteredX !== null ? enteredX : tx0;
  const distance = Math.max(0, Math.min(tx1, chassis.position.x) - startXForScoring);
  const timeMs = Math.max(1, simMs - startTime);
  const telemetry = {
    distance, segmentLength: tx1 - tx0, timeMs,
    avgSpeed: distance / (timeMs / 1000), stuckMs, maxTiltDeg, flippedOver
  };
  const score = scoreFromTelemetry(telemetry);

  return { terrainType, wheelPoints, wheelFeatures: features, telemetry, score };
}

module.exports = { runTrial, pickWheel, coldStartWheel, TERRAIN_TYPES, scoreFromTelemetry };
